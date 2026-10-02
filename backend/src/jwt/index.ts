import { SignJWT, jwtVerify, errors as joseErrors } from "jose";
import { v4 as uuid } from "uuid";
import type { Config } from "../config/index.js";

export type TokenType = "access" | "refresh" | "mfa_pending" | "step_up";

/** SEC-MFA-002 — verified step-up claims for a sensitive-action re-auth token. */
export interface StepUpClaims {
  sub: string;
  purpose: string;
  jti: string;
  exp: number;
  /**
   * Focused fix — account security version the step-up was bound to. A step-up
   * issued before a password/MFA change (which increments auth_version) is
   * invalidated on consume. `NaN` when absent, so a token minted without `av`
   * can never satisfy the `claims.av === live.authVersion` check (fail-closed).
   */
  av: number;
}

export interface IssuedToken {
  jti: string;
  token: string;
  expiresAt: Date;
}

export interface TokenPair {
  access: IssuedToken;
  refresh: IssuedToken;
}

export interface VerifiedClaims {
  sub: string;        // user id
  typ: TokenType;
  role: string;
  jti: string;
  iat: number;
  exp: number;
  /** SEC-SESSION-001 — account security version pinned into access tokens. */
  av: number;
}

export class JwtError extends Error {}
export class JwtExpired extends JwtError {
  constructor() { super("jwt: expired"); }
}
export class JwtInvalid extends JwtError {
  constructor(msg = "jwt: invalid") { super(msg); }
}

export interface JwtService {
  /**
   * Issue an access+refresh pair. `authVersion` (SEC-SESSION-001) is pinned into
   * the access token as claim `av`; it defaults to 1 (a freshly-created user's
   * version) so callers that don't track it still mint currently-valid tokens.
   * Real flows (login/refresh) pass the account's live version.
   */
  issuePair(userId: string, role: string, authVersion?: number): Promise<TokenPair>;
  issueOne(userId: string, role: string, type: TokenType, ttlSec: number): Promise<IssuedToken>;
  verifyAccess(token: string): Promise<VerifiedClaims>;
  verifyRefresh(token: string): Promise<VerifiedClaims>;
  /**
   * SEC-MFA-BYPASS-001 — verify the short-lived login-challenge token issued
   * after a correct password for an MFA account. It carries `typ:"mfa_pending"`
   * so `verifyAccess` (and therefore every authenticated route and WebSocket)
   * rejects it: it can ONLY be exchanged at /auth/mfa/verify.
   */
  verifyMfaPending(token: string): Promise<VerifiedClaims>;
  /**
   * SEC-MFA-002 — short-lived, single-purpose step-up token (signed w/ access
   * key). `authVersion` (focused fix) is pinned as claim `av` so a change to the
   * account's security version invalidates any outstanding step-up token.
   */
  issueStepUp(userId: string, purpose: string, ttlSec: number, authVersion?: number): Promise<IssuedToken>;
  verifyStepUp(token: string): Promise<StepUpClaims>;
}

export function createJwt(cfg: Config): JwtService {
  const accessKey = new TextEncoder().encode(cfg.env.JWT_ACCESS_SECRET);
  const refreshKey = new TextEncoder().encode(cfg.env.JWT_REFRESH_SECRET);
  const issuer = cfg.env.JWT_ISSUER;

  async function sign(userId: string, role: string, type: TokenType, key: Uint8Array, ttlSec: number, authVersion?: number): Promise<IssuedToken> {
    const jti = uuid();
    const now = Math.floor(Date.now() / 1000);
    const exp = now + ttlSec;
    const claims: Record<string, unknown> = { typ: type, role };
    if (authVersion !== undefined) claims.av = authVersion;
    const token = await new SignJWT(claims)
      .setProtectedHeader({ alg: "HS256" })
      .setIssuer(issuer)
      .setSubject(userId)
      .setJti(jti)
      .setIssuedAt(now)
      .setNotBefore(now)
      .setExpirationTime(exp)
      .sign(key);
    return { jti, token, expiresAt: new Date(exp * 1000) };
  }

  async function verify(token: string, key: Uint8Array, expected: TokenType): Promise<VerifiedClaims> {
    let payload;
    try {
      // Pin the accepted signature algorithm to HS256 explicitly (defence in depth):
      // never accept "none", a downgraded/other HMAC (HS384/HS512), or an asymmetric
      // alg — even if a future key/library change would otherwise permit it.
      const result = await jwtVerify(token, key, { issuer, algorithms: ["HS256"] });
      payload = result.payload;
    } catch (err) {
      if (err instanceof joseErrors.JWTExpired) throw new JwtExpired();
      throw new JwtInvalid();
    }
    const typ = payload["typ"];
    if (typ !== expected) throw new JwtInvalid("jwt: wrong type");
    return {
      sub: String(payload.sub ?? ""),
      typ: typ as TokenType,
      role: String(payload["role"] ?? ""),
      jti: String(payload.jti ?? ""),
      iat: Number(payload.iat ?? 0),
      exp: Number(payload.exp ?? 0),
      // Legacy tokens without `av` map to 1 (the fresh-user version) so an
      // account that never changed its credentials keeps working until expiry.
      av: Number(payload["av"] ?? 1),
    };
  }

  return {
    issuePair(userId, role, authVersion = 1) {
      return Promise.all([
        sign(userId, role, "access", accessKey, cfg.jwtAccessTtlSec, authVersion),
        sign(userId, role, "refresh", refreshKey, cfg.jwtRefreshTtlSec),
      ]).then(([access, refresh]) => ({ access, refresh }));
    },
    issueOne(userId, role, type, ttlSec) {
      const key = type === "refresh" ? refreshKey : accessKey;
      return sign(userId, role, type, key, ttlSec);
    },
    verifyAccess(token) { return verify(token, accessKey, "access"); },
    verifyRefresh(token) { return verify(token, refreshKey, "refresh"); },
    verifyMfaPending(token) { return verify(token, accessKey, "mfa_pending"); },
    async issueStepUp(userId, purpose, ttlSec, authVersion) {
      const jti = uuid();
      const now = Math.floor(Date.now() / 1000);
      const exp = now + ttlSec;
      const claims: Record<string, unknown> = { typ: "step_up", purpose };
      if (authVersion !== undefined) claims.av = authVersion;
      const token = await new SignJWT(claims)
        .setProtectedHeader({ alg: "HS256" })
        .setIssuer(issuer).setSubject(userId).setJti(jti)
        .setIssuedAt(now).setNotBefore(now).setExpirationTime(exp)
        .sign(accessKey);
      return { jti, token, expiresAt: new Date(exp * 1000) };
    },
    async verifyStepUp(token) {
      let payload;
      try {
        payload = (await jwtVerify(token, accessKey, { issuer, algorithms: ["HS256"] })).payload;
      } catch (err) {
        if (err instanceof joseErrors.JWTExpired) throw new JwtExpired();
        throw new JwtInvalid();
      }
      if (payload["typ"] !== "step_up") throw new JwtInvalid("jwt: wrong type");
      return {
        sub: String(payload.sub ?? ""),
        purpose: String(payload["purpose"] ?? ""),
        jti: String(payload.jti ?? ""),
        exp: Number(payload.exp ?? 0),
        // Absent `av` → NaN, which never equals a real auth_version, so a
        // token minted without version binding fails the consume-time check.
        av: "av" in payload ? Number(payload["av"]) : Number.NaN,
      };
    },
  };
}
