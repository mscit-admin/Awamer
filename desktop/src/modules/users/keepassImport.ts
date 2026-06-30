/**
 * KeePass (.kdbx) import — parsed entirely in the browser with kdbxweb so the
 * master password and decrypted secrets never leave the device. Argon2 (used by
 * KDBX4) is provided by hash-wasm.
 */
import { Kdbx, Credentials, ProtectedValue, CryptoEngine, KdbxError, Consts, type KdbxGroup } from "kdbxweb";
import { argon2d, argon2i, argon2id } from "hash-wasm";

let argonWired = false;
function wireArgon2(): void {
  if (argonWired) return;
  argonWired = true;
  CryptoEngine.setArgon2Impl(async (password, salt, memory, iterations, length, parallelism, type) => {
    const opts = {
      password: new Uint8Array(password),
      salt: new Uint8Array(salt),
      parallelism,
      iterations,
      memorySize: memory, // kdbxweb passes memory in KiB
      hashLength: length,
      outputType: "binary" as const,
    };
    // Argon2 type codes: 0 = Argon2d, 1 = Argon2i, 2 = Argon2id.
    const t = type as number;
    const fn = t === 0 ? argon2d : t === 1 ? argon2i : argon2id;
    const hash = await fn(opts);
    return new Uint8Array(hash).buffer;
  });
}

export interface KeepassEntry {
  group: string;
  title: string;
  username: string;
  password: string;
  url: string;
  notes: string;
}

export class KeepassError extends Error {
  constructor(public readonly code: "wrong_password" | "parse_failed", message: string) {
    super(message);
    this.name = "KeepassError";
  }
}

function fieldStr(v: unknown): string {
  if (v == null) return "";
  if (typeof v === "string") return v;
  // ProtectedValue
  if (typeof (v as ProtectedValue).getText === "function") return (v as ProtectedValue).getText();
  return String(v);
}

/**
 * Decrypt and flatten a .kdbx file into a list of entries. `keyFile` is the
 * optional key-file accompanying some KeePass databases.
 */
export async function parseKdbx(file: ArrayBuffer, password: string, keyFile?: ArrayBuffer): Promise<KeepassEntry[]> {
  wireArgon2();
  const cred = new Credentials(ProtectedValue.fromString(password), keyFile ?? null);
  let db: Kdbx;
  try {
    db = await Kdbx.load(file, cred);
  } catch (e) {
    if (e instanceof KdbxError && e.code === Consts.ErrorCodes.InvalidKey) {
      throw new KeepassError("wrong_password", "Wrong master password (or key file).");
    }
    throw new KeepassError("parse_failed", e instanceof Error ? e.message : "could not read the file");
  }

  const recycleBin = db.meta.recycleBinUuid?.id;
  const out: KeepassEntry[] = [];

  const walk = (group: KdbxGroup, path: string) => {
    if (recycleBin && group.uuid?.id === recycleBin) return; // skip trash
    const here = path ? `${path}/${group.name ?? ""}` : (group.name ?? "");
    for (const entry of group.entries) {
      const f = entry.fields;
      const title = fieldStr(f.get("Title"));
      const username = fieldStr(f.get("UserName"));
      const password = fieldStr(f.get("Password"));
      const url = fieldStr(f.get("URL"));
      const notes = fieldStr(f.get("Notes"));
      if (!title && !username && !password && !url) continue; // skip empty
      out.push({ group: here, title, username, password, url, notes });
    }
    for (const sub of group.groups) walk(sub, here);
  };
  walk(db.getDefaultGroup(), "");
  return out;
}
