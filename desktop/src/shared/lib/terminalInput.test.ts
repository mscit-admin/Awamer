import { describe, expect, it } from "vitest";
import { sanitizeInsertedCommand } from "./terminalInput";

describe("sanitizeInsertedCommand (SEC-AI-INSERT-001)", () => {
  it("keeps an ordinary command unchanged", () => {
    expect(sanitizeInsertedCommand("ls -la /var/log | grep 'err'")).toBe("ls -la /var/log | grep 'err'");
  });
  it("never contains an Enter: CR/LF end the command", () => {
    expect(sanitizeInsertedCommand("ls\rrm -rf ~")).toBe("ls");
    expect(sanitizeInsertedCommand("ls\nrm -rf ~")).toBe("ls");
    expect(sanitizeInsertedCommand("ls\r\n")).toBe("ls");
    expect(sanitizeInsertedCommand("ls\u2028rm -rf ~")).toBe("ls");
  });
  it("drops terminal/line-editor control bytes", () => {
    // ESC sequences, ^C, ^D, ^U, BEL, DEL, 8-bit CSI
    expect(sanitizeInsertedCommand("echo \u001b[2Jhi\u0003\u0004\u0015\u0007\u007f\u009b31m")).toBe("echo [2Jhi31m");
  });
  it("turns tabs into spaces so completion is not triggered", () => {
    expect(sanitizeInsertedCommand("cat\tfile")).toBe("cat file");
  });
  it("keeps non-ASCII printable text", () => {
    expect(sanitizeInsertedCommand("echo مرحبا ✓")).toBe("echo مرحبا ✓");
  });
});
