/**
 * Native layer: exact argv assertions for both platforms via the pure
 * builders - covers Android paths without adb installed.
 */
import { describe, expect, it } from "vitest";
import {
  buildBackKeyCommand,
  buildDeeplinkCommand,
  buildGpsCommand,
  buildLifecycleCommands,
  buildPermissionCommands,
  buildScreenshotCommand,
  parseRouteFile,
  resolveAdb,
  resolvePermission,
  type DeviceTarget,
} from "../src/device.js";

const ANDROID: DeviceTarget = {
  platform: "android",
  deviceId: "emulator-5554",
  appId: "com.waselni.driver",
};
const IOS: DeviceTarget = {
  platform: "ios",
  deviceId: "00920CD6-2DFD-4A6F-9339-709459BBEE60",
  appId: "dev.flutteraxi.counterApp",
};
const ADB = "/sdk/platform-tools/adb";

describe("gps", () => {
  it("android: adb emu geo fix takes lon first", () => {
    expect(buildGpsCommand(ANDROID, 33.5138, 36.2765, ADB)).toEqual({
      command: ADB,
      args: ["-s", "emulator-5554", "emu", "geo", "fix", "36.2765", "33.5138"],
    });
  });

  it("ios: simctl location set lat,lon", () => {
    expect(buildGpsCommand(IOS, 33.5138, 36.2765, ADB)).toEqual({
      command: "xcrun",
      args: [
        "simctl",
        "location",
        IOS.deviceId,
        "set",
        "33.5138,36.2765",
      ],
    });
  });
});

describe("permissions", () => {
  it("maps friendly names per platform", () => {
    expect(resolvePermission("location", "android")).toEqual([
      "android.permission.ACCESS_FINE_LOCATION",
      "android.permission.ACCESS_COARSE_LOCATION",
    ]);
    expect(resolvePermission("location", "ios")).toEqual(["location"]);
    expect(resolvePermission("android.permission.CAMERA", "android")).toEqual([
      "android.permission.CAMERA",
    ]);
  });

  it("android: pm grant per mapped permission", () => {
    const cmds = buildPermissionCommands(
      ANDROID,
      "grant",
      "location",
      ANDROID.appId!,
      ADB,
    );
    expect(cmds).toEqual([
      {
        command: ADB,
        args: [
          "-s",
          "emulator-5554",
          "shell",
          "pm",
          "grant",
          "com.waselni.driver",
          "android.permission.ACCESS_FINE_LOCATION",
        ],
      },
      {
        command: ADB,
        args: [
          "-s",
          "emulator-5554",
          "shell",
          "pm",
          "grant",
          "com.waselni.driver",
          "android.permission.ACCESS_COARSE_LOCATION",
        ],
      },
    ]);
  });

  it("ios: simctl privacy", () => {
    expect(
      buildPermissionCommands(IOS, "revoke", "camera", IOS.appId!, ADB),
    ).toEqual([
      {
        command: "xcrun",
        args: [
          "simctl",
          "privacy",
          IOS.deviceId,
          "revoke",
          "camera",
          "dev.flutteraxi.counterApp",
        ],
      },
    ]);
  });

  it("android reset uses pm reset-permissions", () => {
    expect(
      buildPermissionCommands(ANDROID, "reset", "all", ANDROID.appId!, ADB)[0]
        .args,
    ).toContain("reset-permissions");
  });
});

describe("deeplink", () => {
  it("android: am start VIEW intent", () => {
    expect(buildDeeplinkCommand(ANDROID, "waselni://ride/1", ADB)).toEqual({
      command: ADB,
      args: [
        "-s",
        "emulator-5554",
        "shell",
        "am",
        "start",
        "-a",
        "android.intent.action.VIEW",
        "-d",
        "waselni://ride/1",
      ],
    });
  });

  it("ios: simctl openurl", () => {
    expect(buildDeeplinkCommand(IOS, "https://example.com", ADB).args).toEqual([
      "simctl",
      "openurl",
      IOS.deviceId,
      "https://example.com",
    ]);
  });
});

describe("screenshot", () => {
  it("android: exec-out screencap", () => {
    expect(buildScreenshotCommand(ANDROID, "/tmp/s.png", ADB).args).toEqual([
      "-s",
      "emulator-5554",
      "exec-out",
      "screencap",
      "-p",
    ]);
  });

  it("ios: simctl io screenshot writes the file", () => {
    expect(buildScreenshotCommand(IOS, "/tmp/s.png", ADB).args).toEqual([
      "simctl",
      "io",
      IOS.deviceId,
      "screenshot",
      "/tmp/s.png",
    ]);
  });
});

describe("applifecycle", () => {
  it("force-stop", () => {
    expect(
      buildLifecycleCommands(ANDROID, "force-stop", ANDROID.appId, null, ADB)[0]
        .args,
    ).toEqual([
      "-s",
      "emulator-5554",
      "shell",
      "am",
      "force-stop",
      "com.waselni.driver",
    ]);
    expect(
      buildLifecycleCommands(IOS, "force-stop", IOS.appId, null, ADB)[0].args,
    ).toEqual(["simctl", "terminate", IOS.deviceId, IOS.appId]);
  });

  it("clear is android-only", () => {
    expect(
      buildLifecycleCommands(ANDROID, "clear", ANDROID.appId, null, ADB)[0]
        .args,
    ).toContain("clear");
    expect(() =>
      buildLifecycleCommands(IOS, "clear", IOS.appId, null, ADB),
    ).toThrow(/uninstall/);
  });

  it("install requires an artifact", () => {
    expect(() =>
      buildLifecycleCommands(ANDROID, "install", null, null, ADB),
    ).toThrow(/artifact/);
    expect(
      buildLifecycleCommands(IOS, "install", null, "/tmp/Runner.app", ADB)[0]
        .args,
    ).toEqual(["simctl", "install", IOS.deviceId, "/tmp/Runner.app"]);
  });

  it("actions needing an app id fail without one", () => {
    expect(() =>
      buildLifecycleCommands(ANDROID, "uninstall", null, null, ADB),
    ).toThrow(/app id/);
  });
});

describe("back key", () => {
  it("android keyevent 4; ios unsupported", () => {
    expect(buildBackKeyCommand(ANDROID, ADB).args).toEqual([
      "-s",
      "emulator-5554",
      "shell",
      "input",
      "keyevent",
      "4",
    ]);
    expect(() => buildBackKeyCommand(IOS, ADB)).toThrow(/back/);
  });
});

describe("resolveAdb", () => {
  it("prefers ANDROID_HOME, then ANDROID_SDK_ROOT, then default, then PATH", () => {
    const probeAll = () => true;
    expect(
      resolveAdb(probeAll, { ANDROID_HOME: "/opt/sdk" } as NodeJS.ProcessEnv),
    ).toBe("/opt/sdk/platform-tools/adb");
    expect(
      resolveAdb(probeAll, {
        ANDROID_SDK_ROOT: "/opt/sdk2",
      } as NodeJS.ProcessEnv),
    ).toBe("/opt/sdk2/platform-tools/adb");
    expect(resolveAdb(() => false, {} as NodeJS.ProcessEnv)).toBe("adb");
  });
});

describe("parseRouteFile", () => {
  it("parses JSONL and lat,lon lines, skipping comments", () => {
    const points = parseRouteFile(
      '# route\n{"lat": 33.5, "lon": 36.2}\n33.6,36.3\n\n',
    );
    expect(points).toEqual([
      { lat: 33.5, lon: 36.2 },
      { lat: 33.6, lon: 36.3 },
    ]);
  });

  it("rejects invalid lines", () => {
    expect(() => parseRouteFile("banana")).toThrow(/Invalid route line/);
    expect(() => parseRouteFile('{"lat": "x"}')).toThrow(/Invalid route line/);
  });
});
