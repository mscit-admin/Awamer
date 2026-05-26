import { SignJWT, jwtVerify, errors as joseErrors } from "jose";
import { v4 as uuid } from "uuid";
import type { Config } from "../config/index.js";

export type TokenType = "access" | "refresh" | "mfa_pending";

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
}

export class JwtError extends Error {}
export class JwtExpired extends JwtError {
  constructor() { super("jwt: expired"); }
}
export class JwtInvalid extends JwtError {
  constructor(msg = "jwt: invalid") { super(msg); }
}

export interface JwtService {
  issuePair(userId: string, role: string): Promise<TokenPair>;
  issueOne(userId: string, role: string, type: TokenType, ttlSec: number): Promise<IssuedToken>;
  verifyAccess(token: string): Promise<VerifiedClaims>;
  verifyRefresh(token: string): Promise<VerifiedClaims>;
}

export function createJwt(cfg: Config): JwtService {
  const accessKey = new TextEncoder().encode(cfg.env.JWT_ACCESS_SECRET);
  const refreshKey = new TextEncoder().encode(cfg.env.JWT_REFRESH_SECRET);
  const issuer = cfg.env.JWT_ISSUER;

  async function sign(userId: string, role: string, type: TokenType, key: Uint8Array, ttlSec: number): Promise<IssuedToken> {
    const jti = uuid();
    const now = Math.floor(Date.now() / 1000);
    const exp = now + ttlSec;
    const token = await new SignJWT({ typ: type, role })
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
      const result = await jwtVerify(token, key, { issuer });
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
    };
  }

  return {
    issuePair(userId, role) {
      return Promise.all([
        sign(userId, role, "access", accessKey, cfg.jwtAccessTtlSec),
        sign(userId, role, "refresh", refreshKey, cfg.jwtRefreshTtlSec),
      ]).then(([access, refresh]) => ({ access, refresh }));
    },
    issueOne(userId, role, type, ttlSec) {
      const key = type === "refresh" ? refreshKey : accessKey;
      return sign(userId, role, type, key, ttlSec);
    },
    verifyAccess(token) { return verify(token, accessKey, "access"); },
    verifyRefresh(token) { return verify(token, refreshKey, "refresh"); },
  };
}
