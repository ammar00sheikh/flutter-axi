import { describe, expect, it, beforeEach, afterEach } from "vitest";
import {
  FlutterAxiError,
  buildBridgeEarlyExitError,
  mapErrorMessage,
  resolveBridgeTimeoutMs,
  resolveSession,
} from "../src/client.js";
import { BRIDGE_PORT_IN_USE_EXIT_CODE } from "../src/bridge.js";

const saved: Record<string, string | undefined> = {};

beforeEach(() => {
  saved.FLUTTER_AXI_BRIDGE_TIMEOUT_MS =
    process.env.FLUTTER_AXI_BRIDGE_TIMEOUT_MS;
  saved.FLUTTER_AXI_SESSION = process.env.FLUTTER_AXI_SESSION;
  delete process.env.FLUTTER_AXI_BRIDGE_TIMEOUT_MS;
  delete process.env.FLUTTER_AXI_SESSION;
});

afterEach(() => {
  for (const key of Object.keys(saved)) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
});

describe("resolveBridgeTimeoutMs", () => {
  it("defaults to 30s and clamps to >= 1s", () => {
    expect(resolveBridgeTimeoutMs()).toBe(30_000);
    process.env.FLUTTER_AXI_BRIDGE_TIMEOUT_MS = "100";
    expect(resolveBridgeTimeoutMs()).toBe(1_000);
    process.env.FLUTTER_AXI_BRIDGE_TIMEOUT_MS = "60000";
    expect(resolveBridgeTimeoutMs()).toBe(60_000);
    process.env.FLUTTER_AXI_BRIDGE_TIMEOUT_MS = "banana";
    expect(resolveBridgeTimeoutMs()).toBe(30_000);
  });
});

describe("resolveSession", () => {
  it("uses the explicit name when given, ambient otherwise", () => {
    expect(resolveSession("driver")).toBe("driver");
    process.env.FLUTTER_AXI_SESSION = "user";
    expect(resolveSession()).toBe("user");
    expect(resolveSession("driver")).toBe("driver");
  });

  it("validates explicit names", () => {
    expect(() => resolveSession("../x")).toThrow(/Invalid/);
  });
});

describe("mapErrorMessage", () => {
  it("maps connection failures to BRIDGE_NOT_READY", () => {
    expect(mapErrorMessage("connect ECONNREFUSED 127.0.0.1:9424").code).toBe(
      "BRIDGE_NOT_READY",
    );
  });

  it("maps missing-app failures to NO_APP", () => {
    expect(
      mapErrorMessage(
        "You must call connect_dart_tooling_daemon first",
      ).code,
    ).toBe("NO_APP");
  });

  it("maps timeouts to TIMEOUT", () => {
    expect(mapErrorMessage("Request timed out").code).toBe("TIMEOUT");
  });

  it("maps driver extension failures to DRIVER_ERROR", () => {
    expect(
      mapErrorMessage("The flutter driver extension is not enabled").code,
    ).toBe("DRIVER_ERROR");
  });

  it("falls back to UNKNOWN", () => {
    const err = mapErrorMessage("mystery");
    expect(err.code).toBe("UNKNOWN");
    expect(err).toBeInstanceOf(FlutterAxiError);
  });
});

describe("buildBridgeEarlyExitError", () => {
  it("attributes the port-in-use sentinel", () => {
    const err = buildBridgeEarlyExitError(
      "driver",
      9500,
      BRIDGE_PORT_IN_USE_EXIT_CODE,
      null,
    );
    expect(err.code).toBe("BRIDGE_NOT_READY");
    expect(err.suggestions.join(" ")).toContain("already in use");
  });

  it("gives startup guidance for other exits", () => {
    const err = buildBridgeEarlyExitError("default", 9424, 1, null);
    expect(err.suggestions.join(" ")).toContain("dart mcp-server");
  });

  it("mentions the signal when killed", () => {
    expect(
      buildBridgeEarlyExitError("default", 9424, null, "SIGKILL").message,
    ).toContain("SIGKILL");
  });
});
