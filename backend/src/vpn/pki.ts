/**
 * Minimal PKI for the built-in OpenVPN server (feature: Awamer as VPN server).
 *
 * Each VPN server profile owns a small CA: a self-signed CA cert, one server
 * cert, and a per-client cert signed by that CA, plus a `tls-crypt` static key.
 * RSA keys are generated with Node's native crypto (fast) and certificates are
 * created/signed with node-forge. Private keys never leave the backend
 * unencrypted — the repository seals them with the same AES-256-GCM SecretBox
 * as other secrets.
 *
 * Revocation is handled by the username/password auth-verify step (a revoked
 * client's password check fails), so no CRL machinery is needed.
 */
import { generateKeyPairSync, randomBytes } from "node:crypto";
import forge from "node-forge";

export interface KeyPairPem {
  certPem: string;
  keyPem: string;
}

export interface CaBundle extends KeyPairPem {
  /** OpenVPN `tls-crypt` static key (control-channel encryption). */
  tlsCrypt: string;
}

const YEAR = 365 * 24 * 60 * 60 * 1000;

function newRsaKeys(): { forgePriv: forge.pki.rsa.PrivateKey; forgePub: forge.pki.rsa.PublicKey; keyPem: string } {
  const { publicKey, privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const keyPem = privateKey.export({ type: "pkcs1", format: "pem" }) as string;
  const pubPem = publicKey.export({ type: "spki", format: "pem" }) as string;
  return {
    forgePriv: forge.pki.privateKeyFromPem(keyPem),
    forgePub: forge.pki.publicKeyFromPem(pubPem),
    keyPem,
  };
}

/**
 * Positive, MINIMALLY-encoded 128-bit serial (RFC 5280 §4.1.2.2; ≥120 bits of
 * CSPRNG entropy). The first octet is forced into 0x01..0x7f, so the DER
 * INTEGER needs no sign-padding byte and can never start with a redundant
 * 0x00. The previous `"00" + 16 random bytes` produced a non-minimal INTEGER
 * whenever the random part itself began with 0x00 (~1 in 256): OpenSSL (and so
 * OpenVPN) refuses to parse such certificates ("asn1 illegal padding"), and a
 * forge PEM round-trip re-encodes the serial so the signature no longer verifies.
 */
export function serial(): string {
  const b = randomBytes(16);
  b[0] = (b[0]! & 0x7f) | 0x01;
  return b.toString("hex");
}

/** Build a self-signed CA plus a fresh tls-crypt key. */
export function generateCa(commonName: string): CaBundle {
  const { forgePriv, forgePub, keyPem } = newRsaKeys();
  const cert = forge.pki.createCertificate();
  cert.publicKey = forgePub;
  cert.serialNumber = serial();
  cert.validity.notBefore = new Date();
  cert.validity.notAfter = new Date(Date.now() + 10 * YEAR);
  const attrs = [{ name: "commonName", value: commonName }];
  cert.setSubject(attrs);
  cert.setIssuer(attrs);
  cert.setExtensions([
    { name: "basicConstraints", cA: true, critical: true },
    { name: "keyUsage", keyCertSign: true, cRLSign: true, critical: true },
    { name: "subjectKeyIdentifier" },
  ]);
  cert.sign(forgePriv, forge.md.sha256.create());
  return { certPem: forge.pki.certificateToPem(cert), keyPem, tlsCrypt: generateTlsCryptKey() };
}

function signWithCa(commonName: string, caCertPem: string, caKeyPem: string, kind: "server" | "client"): KeyPairPem {
  const { forgePub, keyPem } = newRsaKeys();
  const caCert = forge.pki.certificateFromPem(caCertPem);
  const caKey = forge.pki.privateKeyFromPem(caKeyPem);

  const cert = forge.pki.createCertificate();
  cert.publicKey = forgePub;
  cert.serialNumber = serial();
  cert.validity.notBefore = new Date();
  cert.validity.notAfter = new Date(Date.now() + 5 * YEAR);
  cert.setSubject([{ name: "commonName", value: commonName }]);
  cert.setIssuer(caCert.subject.attributes);
  cert.setExtensions([
    { name: "basicConstraints", cA: false },
    { name: "keyUsage", digitalSignature: true, keyEncipherment: true, critical: true },
    { name: "extKeyUsage", serverAuth: kind === "server", clientAuth: kind === "client" },
  ]);
  cert.sign(caKey, forge.md.sha256.create());
  return { certPem: forge.pki.certificateToPem(cert), keyPem };
}

/** Issue the server certificate (extKeyUsage=serverAuth) signed by the CA. */
export function generateServerCert(commonName: string, caCertPem: string, caKeyPem: string): KeyPairPem {
  return signWithCa(commonName, caCertPem, caKeyPem, "server");
}

/** Issue a client certificate (extKeyUsage=clientAuth) signed by the CA. */
export function generateClientCert(commonName: string, caCertPem: string, caKeyPem: string): KeyPairPem {
  return signWithCa(commonName, caCertPem, caKeyPem, "client");
}

/** OpenVPN `tls-crypt` static key (2048-bit, the "Static key V1" wire format). */
export function generateTlsCryptKey(): string {
  const hex = randomBytes(256).toString("hex"); // 512 hex chars = 256 bytes
  const lines = hex.match(/.{1,32}/g) ?? [];
  return `-----BEGIN OpenVPN Static key V1-----\n${lines.join("\n")}\n-----END OpenVPN Static key V1-----\n`;
}
