/**
 * OpenVPN `auth-user-pass-verify` handler (built-in VPN server).
 *
 * The server config references this as:
 *   auth-user-pass-verify "node <dist>/vpn/authVerify.js" via-file
 * OpenVPN then invokes it as `node authVerify.js <tempfile>`, where the temp
 * file holds `username\npassword`. The running server instance is identified
 * by the `AWAMER_VPN_SERVER_ID` env var the manager sets on the child process.
 *
 * Exit 0 = allow, non-zero = deny. A revoked client fails here (which is how
 * revocation is enforced without a CRL). Runs as its own short-lived process,
 * so it only needs `DATABASE_URL` — not the full app config.
 */
import { readFileSync } from "node:fs";
import { Pool } from "pg";
import argon2 from "argon2";

async function main(): Promise<number> {
  const serverId = process.env.AWAMER_VPN_SERVER_ID;
  const credFile = process.argv[2];
  if (!serverId || !credFile) return 1;

  let username: string, password: string;
  try {
    const parts = readFileSync(credFile, "utf8").split("\n");
    username = parts[0] ?? "";
    password = parts[1] ?? "";
  } catch {
    return 1;
  }
  if (!username) return 1;

  const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 1 });
  try {
    const { rows } = await pool.query<{ password_hash: string }>(
      `SELECT password_hash FROM vpn_server_clients
       WHERE server_id = $1 AND username = $2 AND NOT revoked`,
      [serverId, username],
    );
    if (!rows[0]) return 1;
    return (await argon2.verify(rows[0].password_hash, password)) ? 0 : 1;
  } catch {
    return 1;
  } finally {
    await pool.end().catch(() => {});
  }
}

main().then((code) => process.exit(code)).catch(() => process.exit(1));
