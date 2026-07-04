import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  DEFAULT_BASE_PORT,
  DEFAULT_SESSION_NAME,
  defaultPortForSession,
  resolveSessionName,
  resolveSessionPidFile,
  resolveSessionPort,
  resolveSessionStateDir,
  validateSessionName,
} from "../src/sessions.js";

const STATE_DIR = join(homedir(), ".flutter-axi");

const saved: Record<string, string | undefined> = {};

beforeEach(() => {
  saved.FLUTTER_AXI_SESSION = process.env.FLUTTER_AXI_SESSION;
  saved.FLUTTER_AXI_PORT = process.env.FLUTTER_AXI_PORT;
  delete process.env.FLUTTER_AXI_SESSION;
  delete process.env.FLUTTER_AXI_PORT;
});

afterEach(() => {
  for (const key of ["FLUTTER_AXI_SESSION", "FLUTTER_AXI_PORT"]) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
});

describe("resolveSessionName", () => {
  it('defaults to "default" when unset', () => {
    expect(resolveSessionName()).toBe(DEFAULT_SESSION_NAME);
  });

  it('defaults to "default" when empty or whitespace', () => {
    process.env.FLUTTER_AXI_SESSION = "   ";
    expect(resolveSessionName()).toBe(DEFAULT_SESSION_NAME);
  });

  it("trims the configured name", () => {
    process.env.FLUTTER_AXI_SESSION = "  driver  ";
    expect(resolveSessionName()).toBe("driver");
  });

  it("throws on a configured-but-unsafe name", () => {
    process.env.FLUTTER_AXI_SESSION = "../escape";
    expect(() => resolveSessionName()).toThrow(/Invalid/);
  });

  it("throws on a dot-only name that would collapse onto the default dir", () => {
    process.env.FLUTTER_AXI_SESSION = "..";
    expect(() => resolveSessionName()).toThrow(/Invalid/);
  });
});

describe("validateSessionName", () => {
  it("accepts safe names", () => {
    for (const name of ["default", "user", "driver", "worker-1", "a.b_c"]) {
      expect(() => validateSessionName(name)).not.toThrow();
    }
  });

  it("rejects path traversal, separators, shell metacharacters, spaces", () => {
    for (const name of ["../x", "a/b", "a b", "a$b", "a;b", "a\\b", ""]) {
      expect(() => validateSessionName(name)).toThrow(/Invalid/);
    }
  });

  it("rejects names longer than 64 chars", () => {
    expect(() => validateSessionName("x".repeat(65))).toThrow(/Invalid/);
  });
});

describe("defaultPortForSession", () => {
  it("keeps the base port for the default session", () => {
    expect(defaultPortForSession(DEFAULT_SESSION_NAME)).toBe(DEFAULT_BASE_PORT);
  });

  it("derives deterministic ports in (base, base+1000]", () => {
    for (const name of ["user", "driver", "worker-1", "bench-run-3"]) {
      const port = defaultPortForSession(name);
      expect(port).toBeGreaterThan(DEFAULT_BASE_PORT);
      expect(port).toBeLessThanOrEqual(DEFAULT_BASE_PORT + 1000);
      expect(defaultPortForSession(name)).toBe(port);
    }
  });

  it("gives distinct sessions distinct ports (for these names)", () => {
    expect(defaultPortForSession("user")).not.toBe(
      defaultPortForSession("driver"),
    );
  });
});

describe("resolveSessionPort", () => {
  it("prefers an explicit FLUTTER_AXI_PORT", () => {
    process.env.FLUTTER_AXI_PORT = "12345";
    expect(resolveSessionPort("driver")).toBe(12345);
  });

  it("ignores an invalid FLUTTER_AXI_PORT", () => {
    process.env.FLUTTER_AXI_PORT = "banana";
    expect(resolveSessionPort("default")).toBe(DEFAULT_BASE_PORT);
  });
});

describe("state paths", () => {
  it("default session uses the legacy state dir", () => {
    expect(resolveSessionStateDir("default")).toBe(STATE_DIR);
    expect(resolveSessionPidFile("default")).toBe(
      join(STATE_DIR, "bridge.pid"),
    );
  });

  it("named sessions nest under sessions/<name>", () => {
    expect(resolveSessionStateDir("driver")).toBe(
      join(STATE_DIR, "sessions", "driver"),
    );
  });
});
