/**
 * Shared resolution of an SSH host + its authentication material.
 *
 * Extracted from the browser SSH gateway so the gateway, the tunnel manager,
 * and the WebSocket tunnel gateway all resolve credentials the same way
 * (user-scoped, honoring shared hosts via the owner's credential, with
 * optional password/passphrase overrides).
 */
import type { HostRepository, CredentialRepository } from "../repos/sessionRepos.js";

export type SshAuth =
  | { password: string }
  | { privateKey: string; passphrase?: string };

export interface ResolvedSsh {
  host: Awaited<ReturnType<HostRepository["getById"]>>;
  username: string;
  auth: SshAuth;
}

export class SshResolveError extends Error {
  constructor(public readonly code: string, message: string) {
    super(message);
    this.name = "SshResolveError";
  }
}

/**
 * Resolve a host (user-scoped) and the SSH auth to use for it. Throws
 * SshResolveError with a stable `code` on any failure so callers can map it to
 * their transport (WS error frame, HTTP status, …).
 */
export async function resolveSshConnection(
  deps: { hosts: HostRepository; credentials: CredentialRepository },
  userId: string,
  hostId: string,
  overrides: { password?: string | null; passphrase?: string | null } = {},
): Promise<ResolvedSsh> {
  let host: ResolvedSsh["host"];
  try {
    host = await deps.hosts.getById(userId, hostId);
  } catch {
    throw new SshResolveError("host_not_found", "host not found");
  }

  let username = "root";
  let auth: SshAuth | null = null;

  const passwordOverride = overrides.password ?? null;
  const passphraseOverride = overrides.passphrase ?? null;

  try {
    if (passwordOverride) {
      if (host.credentialId) {
        const c = await deps.credentials.getById(host.userId, host.credentialId);
        username = c.username || "root";
      }
      auth = { password: passwordOverride };
    } else if (host.credentialId) {
      const cred = await deps.credentials.getById(host.userId, host.credentialId);
      username = cred.username || "root";
      const secret = cred.secretData ?? {};
      if (cred.credentialType === "password") {
        const pw = secret["password"];
        if (typeof pw !== "string") throw new SshResolveError("no_credential", "credential has no password");
        auth = { password: pw };
      } else if (cred.credentialType === "private_key") {
        const pem = secret["private_key"];
        if (typeof pem !== "string") throw new SshResolveError("no_credential", "credential has no private_key");
        const pp = passphraseOverride ?? (typeof secret["passphrase"] === "string" ? (secret["passphrase"] as string) : undefined);
        auth = { privateKey: pem, ...(pp ? { passphrase: pp } : {}) };
      } else {
        throw new SshResolveError("unsupported_credential", `credential type ${cred.credentialType} is not supported for SSH`);
      }
    } else {
      throw new SshResolveError("no_credential", "host has no credential and no password was provided");
    }
  } catch (e) {
    if (e instanceof SshResolveError) throw e;
    throw new SshResolveError("credential_error", "could not resolve credentials");
  }

  return { host, username, auth };
}
