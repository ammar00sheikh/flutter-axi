import { describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DRIVER_SHIM_RELPATH,
  detectAppId,
  hasDriverShim,
  parseDevicesList,
  parseLaunchOutput,
  setupDriver,
} from "../src/lifecycle.js";

describe("parseDevicesList (captured format)", () => {
  it("parses the JSON devices payload", () => {
    const devices = parseDevicesList(
      JSON.stringify({
        devices: [
          {
            name: "iPhone SE (3rd generation)",
            id: "00920CD6-2DFD-4A6F-9339-709459BBEE60",
            targetPlatform: "ios",
            emulator: true,
          },
          { name: "macOS", id: "macos", targetPlatform: "darwin", emulator: false },
        ],
      }),
    );
    expect(devices).toHaveLength(2);
    expect(devices[0]).toEqual({
      id: "00920CD6-2DFD-4A6F-9339-709459BBEE60",
      name: "iPhone SE (3rd generation)",
      platform: "ios",
      emulator: true,
    });
  });

  it("returns [] for malformed payloads", () => {
    expect(parseDevicesList("nope")).toEqual([]);
  });
});

describe("parseLaunchOutput (captured format)", () => {
  it("parses dtdUri and pid", () => {
    expect(
      parseLaunchOutput('{"dtdUri":"ws://127.0.0.1:58210/x=","pid":56109}'),
    ).toEqual({ dtdUri: "ws://127.0.0.1:58210/x=", pid: 56109 });
  });

  it("throws a structured error on failure text", () => {
    expect(() => parseLaunchOutput("Build failed: ...")).toThrow(
      /Launch failed/,
    );
  });
});

describe("setupDriver", () => {
  function makeProject(): string {
    const dir = mkdtempSync(join(tmpdir(), "flutter-axi-proj-"));
    mkdirSync(join(dir, "lib"), { recursive: true });
    writeFileSync(
      join(dir, "pubspec.yaml"),
      "name: test_app\n\ndev_dependencies:\n  flutter_test:\n    sdk: flutter\n",
    );
    return dir;
  }

  it("adds flutter_driver and writes the shim, idempotently", () => {
    const dir = makeProject();
    try {
      const first = setupDriver(dir);
      expect(first.pubspecUpdated).toBe(true);
      expect(first.shimWritten).toBe(true);
      expect(readFileSync(join(dir, "pubspec.yaml"), "utf-8")).toContain(
        "flutter_driver:",
      );
      const shim = readFileSync(join(dir, DRIVER_SHIM_RELPATH), "utf-8");
      expect(shim).toContain("enableFlutterDriverExtension()");
      expect(hasDriverShim(dir)).toBe(true);

      const second = setupDriver(dir);
      expect(second.pubspecUpdated).toBe(false);
      expect(second.shimWritten).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("rejects non-Flutter directories", () => {
    const dir = mkdtempSync(join(tmpdir(), "flutter-axi-empty-"));
    try {
      expect(() => setupDriver(dir)).toThrow(/Not a Flutter project/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("detectAppId", () => {
  it("finds the Android applicationId in gradle files", () => {
    const dir = mkdtempSync(join(tmpdir(), "flutter-axi-appid-"));
    try {
      mkdirSync(join(dir, "android", "app"), { recursive: true });
      writeFileSync(
        join(dir, "android", "app", "build.gradle.kts"),
        'android {\n  defaultConfig {\n    applicationId = "com.example.app"\n  }\n}\n',
      );
      expect(detectAppId(dir, "android")).toBe("com.example.app");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("finds the iOS bundle id in the pbxproj", () => {
    const dir = mkdtempSync(join(tmpdir(), "flutter-axi-appid-"));
    try {
      mkdirSync(join(dir, "ios", "Runner.xcodeproj"), { recursive: true });
      writeFileSync(
        join(dir, "ios", "Runner.xcodeproj", "project.pbxproj"),
        "PRODUCT_BUNDLE_IDENTIFIER = dev.flutteraxi.counterApp;\n",
      );
      expect(detectAppId(dir, "ios")).toBe("dev.flutteraxi.counterApp");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("returns null when nothing is found", () => {
    const dir = mkdtempSync(join(tmpdir(), "flutter-axi-appid-"));
    try {
      expect(detectAppId(dir, "android")).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
