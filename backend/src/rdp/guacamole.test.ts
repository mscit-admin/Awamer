import { test } from "node:test";
import assert from "node:assert/strict";
import {
  encodeInstruction, parseInstruction, buildConnectInstruction, rdpParamMap,
} from "./guacamole.js";

test("encodeInstruction length-prefixes each element by codepoint count", () => {
  assert.equal(encodeInstruction("select", "rdp"), "6.select,3.rdp;");
  assert.equal(encodeInstruction("size", "1024", "768", "96"), "4.size,4.1024,3.768,2.96;");
  // Empty element → 0-length prefix.
  assert.equal(encodeInstruction("video"), "5.video;");
  assert.equal(encodeInstruction("connect", ""), "7.connect,0.;");
  // Astral codepoint counts as 1 (emoji is a single codepoint but 2 UTF-16 units).
  assert.equal(encodeInstruction("😀"), "1.😀;");
});

test("parseInstruction reads one complete instruction and reports consumption", () => {
  const r = parseInstruction("6.select,3.rdp;");
  assert.deepEqual(r?.elements, ["select", "rdp"]);
  assert.equal(r?.consumed, "6.select,3.rdp;".length);
});

test("parseInstruction returns null on a partial instruction", () => {
  assert.equal(parseInstruction("6.sele"), null);          // value not complete
  assert.equal(parseInstruction("4.args,8.hostname"), null); // no terminator yet
  assert.equal(parseInstruction("3."), null);              // value missing
});

test("parseInstruction handles a trailing remainder after the terminator", () => {
  const r = parseInstruction("5.ready,4.$abc;3.foo");
  assert.deepEqual(r?.elements, ["ready", "$abc"]);
  assert.equal("5.ready,4.$abc;3.foo".slice(r!.consumed), "3.foo");
});

test("parseInstruction parses astral codepoints by codepoint length", () => {
  const inst = encodeInstruction("name", "a😀b"); // "a😀b" = 3 codepoints
  const r = parseInstruction(inst);
  assert.deepEqual(r?.elements, ["name", "a😀b"]);
});

test("parseInstruction throws on a malformed length prefix", () => {
  assert.throws(() => parseInstruction("x.foo;"));
});

test("buildConnectInstruction echoes VERSION and maps params in args order", () => {
  const args = ["args", "VERSION_1_5_0", "hostname", "port", "username", "password"];
  const params = { hostname: "10.0.0.5", port: "3389", username: "alice", password: "s3cret" };
  const out = buildConnectInstruction(args, params);
  assert.equal(
    out,
    encodeInstruction("connect", "VERSION_1_5_0", "10.0.0.5", "3389", "alice", "s3cret"),
  );
});

test("buildConnectInstruction sends empty string for unknown args (guacd default)", () => {
  const args = ["args", "hostname", "port", "some-future-param"];
  const out = buildConnectInstruction(args, { hostname: "h", port: "3389" });
  assert.equal(out, encodeInstruction("connect", "h", "3389", ""));
});

test("buildConnectInstruction works with no VERSION token (older guacd)", () => {
  const args = ["args", "hostname", "port"];
  assert.equal(
    buildConnectInstruction(args, { hostname: "h", port: "3389" }),
    encodeInstruction("connect", "h", "3389"),
  );
});

test("rdpParamMap fills sensible defaults and honors overrides", () => {
  const m = rdpParamMap({ hostname: "host", port: 3389 });
  assert.equal(m.hostname, "host");
  assert.equal(m.port, "3389");
  assert.equal(m.security, "any");
  assert.equal(m["ignore-cert"], "true");
  assert.equal(m.width, "1024");
  assert.equal(m["resize-method"], "display-update");

  const m2 = rdpParamMap({
    hostname: "h", port: 3390, username: "u", password: "p", domain: "CORP",
    security: "nla", ignoreCert: false, width: 1600, height: 900, dpi: 120,
    extra: { "enable-drive": "true", "color-depth": "24" },
  });
  assert.equal(m2.username, "u");
  assert.equal(m2.domain, "CORP");
  assert.equal(m2.security, "nla");
  assert.equal(m2["ignore-cert"], "false");
  assert.equal(m2.width, "1600");
  assert.equal(m2["enable-drive"], "true");
  assert.equal(m2["color-depth"], "24");
});

test("round-trip: a connect built from a parsed args re-parses to the same elements", () => {
  const argsInst = encodeInstruction("args", "VERSION_1_5_0", "hostname", "port", "domain");
  const parsed = parseInstruction(argsInst)!;
  const connect = buildConnectInstruction(parsed.elements, { hostname: "1.2.3.4", port: "3389", domain: "" });
  const back = parseInstruction(connect)!;
  assert.deepEqual(back.elements, ["connect", "VERSION_1_5_0", "1.2.3.4", "3389", ""]);
});
