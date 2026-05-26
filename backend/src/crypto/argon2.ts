import argon2 from "argon2";
import type { Config } from "../config/index.js";

export interface Argon2Service {
  hash(password: string): Promise<string>;
  verify(stored: string, password: string): Promise<boolean>;
  needsRehash(stored: string): boolean;
}

/**
 * Build an Argon2id service whose hash params come from config.
 * Uses the standard PHC encoded format, fully compatible with the
 * reference C implementation, Python's argon2-cffi, and Go's
 * golang.org/x/crypto/argon2 — meaning hashes computed in any of those
 * are interchangeable.
 */
export function createArgon2(cfg: Config): Argon2Service {
  const opts = {
    type: argon2.argon2id,
    memoryCost: cfg.env.ARGON2_MEMORY_KB,
    timeCost: cfg.env.ARGON2_ITERATIONS,
    parallelism: cfg.env.ARGON2_PARALLELISM,
  } as const;

  return {
    async hash(password: string) {
      if (!password) throw new Error("crypto: empty password");
      return argon2.hash(password, opts);
    },
    async verify(stored: string, password: string) {
      try {
        return await argon2.verify(stored, password);
      } catch {
        // Malformed hash, version mismatch, etc.
        return false;
      }
    },
    needsRehash(stored: string) {
      try {
        return argon2.needsRehash(stored, opts);
      } catch {
        return true;
      }
    },
  };
}
