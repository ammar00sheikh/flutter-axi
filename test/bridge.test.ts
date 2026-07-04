import { describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  BRIDGE_PORT_IN_USE_EXIT_CODE,
  extractToolImages,
  extractToolText,
  handleBridgeServerError,
  isBridgeTargetReachable,
  parseBridgeCallPayload,
  removePidFile,
  resolveDartBin,
  resolveTransportSpec,
} from "../src/bridge.js";

describe("parseBridgeCallPayload", () => {
  it("parses name and args", () => {
    expect(parseBridgeCallPayload('{"name":"tap","args":{"a":1}}')).toEqual({
      name: "tap",
      args: { a: 1 },
    });
  });

  it("defaults missing args to {}", () => {
    expect(parseBridgeCallPayload('{"name":"tap"}')).toEqual({
      name: "tap",
      args: {},
    });
  });

  it("rejects malformed payloads", () => {
    for (const body of ["nope", "{}", '{"name":""}', '{"name":"x","args":[]}']) {
      expect(() => parseBridgeCallPayload(body)).toThrow(/Invalid/);
    }
  });
});

describe("extractToolText / extractToolImages", () => {
  it("joins text blocks and collects image blocks", () => {
    const content = [
      { type: "text", text: "a" },
      { type: "image", data: "aGk=", mimeType: "image/png" },
      { type: "text", text: "b" },
    ];
    expect(extractToolText(content)).toBe("a\nb");
    expect(extractToolImages(content)).toEqual([
      { data: "aGk=", mimeType: "image/png" },
    ]);
  });

  it("defaults image mime type to png", () => {
    expect(extractToolImages([{ type: "image", data: "x" }])[0].mimeType).toBe(
      "image/png",
    );
  });
});

describe("transport spec", () => {
  it("spawns dart mcp-server, honoring FLUTTER_AXI_DART_BIN", () => {
    const saved = process.env.FLUTTER_AXI_DART_BIN;
    try {
      delete process.env.FLUTTER_AXI_DART_BIN;
      expect(resolveTransportSpec()).toEqual({
        command: "dart",
        args: ["mcp-server"],
      });
      process.env.FLUTTER_AXI_DART_BIN = "/flutter/bin/dart";
      expect(resolveDartBin()).toBe("/flutter/bin/dart");
      expect(resolveTransportSpec().command).toBe("/flutter/bin/dart");
    } finally {
      if (saved === undefined) delete process.env.FLUTTER_AXI_DART_BIN;
      else process.env.FLUTTER_AXI_DART_BIN = saved;
    }
  });
});

describe("removePidFile ownership", () => {
  it("removes only when owned by this pid", () => {
    const dir = mkdtempSync(join(tmpdir(), "flutter-axi-pid-"));
    const pidFile = join(dir, "bridge.pid");
    try {
      writeFileSync(pidFile, JSON.stringify({ pid: 999999, port: 1 }));
      removePidFile(pidFile, 123);
      expect(existsSync(pidFile)).toBe(true);
      removePidFile(pidFile, 999999);
      expect(existsSync(pidFile)).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("leaves malformed files untouched", () => {
    const dir = mkdtempSync(join(tmpdir(), "flutter-axi-pid-"));
    const pidFile = join(dir, "bridge.pid");
    try {
      writeFileSync(pidFile, "not json");
      removePidFile(pidFile, 123);
      expect(existsSync(pidFile)).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("handleBridgeServerError", () => {
  it("exits with the sentinel code on EADDRINUSE", () => {
    const exit = vi.fn();
    const err = Object.assign(new Error("in use"), { code: "EADDRINUSE" });
    handleBridgeServerError(err, 9424, exit);
    expect(exit).toHaveBeenCalledWith(BRIDGE_PORT_IN_USE_EXIT_CODE);
  });

  it("exits 1 otherwise", () => {
    const exit = vi.fn();
    handleBridgeServerError(new Error("boom"), 9424, exit);
    expect(exit).toHaveBeenCalledWith(1);
  });
});

describe("isBridgeTargetReachable", () => {
  it("probes with list_running_apps", async () => {
    const calls: string[] = [];
    const client = {
      listTools: async () => ({ tools: [] }),
      callTool: async ({ name }: { name: string }) => {
        calls.push(name);
        return {};
      },
      close: async () => {},
    };
    expect(await isBridgeTargetReachable(client)).toEqual({ ok: true });
    expect(calls).toEqual(["list_running_apps"]);
  });

  it("reports failures with a reason", async () => {
    const client = {
      listTools: async () => ({ tools: [] }),
      callTool: async () => {
        throw new Error("wedged");
      },
      close: async () => {},
    };
    expect(await isBridgeTargetReachable(client)).toEqual({
      ok: false,
      reason: "wedged",
    });
  });
});
