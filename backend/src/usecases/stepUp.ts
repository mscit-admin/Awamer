/**
 * SEC-MFA-002 — step-up (recent re-authentication) for sensitive actions.
 *
 * A normal access token is NOT sufficient to enroll/replace/disable MFA. The
 * user must prove recent possession of their password (and current MFA, when
 * enabled) to obtain a short-lived, single-purpose, single-use step-up token,
 * which the sensitive endpoints then require.
 *
 * Single-use is enforced per-instance (consumed jti set with TTL GC), matching
 * the single-instance deployment model (see AWM-SEC-022).
 */
import type { JwtService } from "../jwt/index.js";
import { DomainError } from "../domain/index.js";

export type StepUpPurpose = "mfa_change";

export class StepUpError extends DomainError {
  constructor(message = "recent re-authentication required") {
    super("step_up_required", message);
  }
}

export class StepUpService {
  private readonly consumed = new Map<string, number>(); // jti -> exp epoch ms

  constructor(
    private readonly jwt: JwtService,
    private readonly ttlSec = 300, // 5 minutes
  ) {}

  async issue(userId: string, purpose: StepUpPurpose): Promise<{ token: string; expiresInSec: number }> {
    const t = await this.jwt.issueStepUp(userId, purpose, this.ttlSec);
    return { token: t.token, expiresInSec: this.ttlSec };
  }

  /**
   * Verify + CONSUME a step-up token. Throws StepUpError unless the token is
   * valid, unexpired, bound to this user, for this exact purpose, and unused.
   * After a successful call the token cannot be used again.
   */
  async consume(token: string | undefined, userId: string, purpose: StepUpPurpose): Promise<void> {
    if (!token) throw new StepUpError();
    let claims;
    try {
      claims = await this.jwt.verifyStepUp(token);
    } catch {
      throw new StepUpError();
    }
    if (claims.sub !== userId) throw new StepUpError("step-up token does not match the current user");
    if (claims.purpose !== purpose) throw new StepUpError("step-up token is not valid for this action");
    this.gc();
    if (this.consumed.has(claims.jti)) throw new StepUpError("step-up token has already been used");
    this.consumed.set(claims.jti, claims.exp * 1000);
  }

  private gc(): void {
    const now = Date.now();
    for (const [jti, exp] of this.consumed) if (exp < now) this.consumed.delete(jti);
  }
}
