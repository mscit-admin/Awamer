import { test } from "node:test";
import assert from "node:assert/strict";
import forge from "node-forge";
import { generateCa, generateServerCert, generateClientCert, generateTlsCryptKey } from "./pki.js";

test("generateCa produces a self-signed CA + tls-crypt key", () => {
  const ca = generateCa("Awamer VPN CA");
  assert.match(ca.certPem, /BEGIN CERTIFICATE/);
  assert.match(ca.keyPem, /BEGIN RSA PRIVATE KEY/);
  assert.match(ca.tlsCrypt, /BEGIN OpenVPN Static key V1/);
  const cert = forge.pki.certificateFromPem(ca.certPem);
  assert.equal(cert.subject.getField("CN").value, "Awamer VPN CA");
  // Self-signed: verifies with its own public key.
  assert.ok(cert.verify(cert));
});

test("client + server certs are signed by the CA and carry the right EKU", () => {
  const ca = generateCa("Awamer VPN CA");
  const caCert = forge.pki.certificateFromPem(ca.certPem);

  for (const [cn, kind, mk] of [
    ["server-1", "server", generateServerCert],
    ["client-alice", "client", generateClientCert],
  ] as const) {
    const leaf = mk(cn, ca.certPem, ca.keyPem);
    const cert = forge.pki.certificateFromPem(leaf.certPem);
    assert.equal(cert.subject.getField("CN").value, cn);
    // The CA's public key verifies the leaf signature → correctly chained.
    assert.ok(caCert.verify(cert), `${cn} should be signed by the CA`);
    const eku = cert.getExtension("extKeyUsage") as { serverAuth?: boolean; clientAuth?: boolean };
    if (kind === "server") assert.equal(eku.serverAuth, true);
    else assert.equal(eku.clientAuth, true);
  }
});

test("tls-crypt key has the 2048-bit static-key layout", () => {
  const k = generateTlsCryptKey();
  const body = k.split("\n").filter((l) => l && !l.includes("OpenVPN Static key"));
  assert.equal(body.length, 16); // 16 lines × 32 hex chars = 256 bytes
  for (const line of body) assert.match(line, /^[0-9a-f]{32}$/);
});
