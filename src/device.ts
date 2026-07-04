/**
 * Native device layer - direct adb (Android) / xcrun simctl (iOS simulator)
 * commands for everything the Flutter tooling layer cannot reach: GPS
 * mocking, permissions, deep links, push notifications, app lifecycle, and
 * OS-level screenshots.
 *
 * No bridge involved: these are one-shot child_process executions keyed off
 * the session's app.json (platform, deviceId, appId). `exec` is injectable so
 * unit tests can assert the exact argv for both platforms without any
 * toolchain installed.
 */

import { execFile } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { FlutterAxiError } from "./client.js";
import type { Platform } from "./appstate.js";

export interface ExecResult {
  stdout: string;
  stderr: string;
}

export type Exec = (
  command: string,
  args: string[],
  opts?: { timeoutMs?: number },
) => Promise<ExecResult>;

export const defaultExec: Exec = (command, args, opts = {}) =>
  new Promise((resolve, reject) => {
    execFile(
      command,
      args,
      { timeout: opts.timeoutMs ?? 60_000, maxBuffer: 32 * 1024 * 1024 },
      (error, stdout, stderr) => {
        if (error) {
          reject(
            new Error(
              `${command} ${args.join(" ")} failed: ${stderr.trim() || error.message}`,
            ),
          );
        } else {
          resolve({ stdout, stderr });
        }
      },
    );
  });

/**
 * Resolve the adb binary: ANDROID_HOME / ANDROID_SDK_ROOT platform-tools,
 * the default macOS SDK location, then bare "adb" from PATH. `probe` is
 * injectable for tests.
 */
export function resolveAdb(
  probe: (path: string) => boolean = existsSync,
  env: NodeJS.ProcessEnv = process.env,
): string | null {
  const candidates: string[] = [];
  for (const envVar of ["ANDROID_HOME", "ANDROID_SDK_ROOT"]) {
    const root = env[envVar];
    if (root) candidates.push(join(root, "platform-tools", "adb"));
  }
  candidates.push(join(homedir(), "Library", "Android", "sdk", "platform-tools", "adb"));
  for (const candidate of candidates) {
    if (probe(candidate)) return candidate;
  }
  // Fall back to PATH resolution - existence is verified at exec time.
  return "adb";
}

export function toolchainMissingError(platform: Platform): FlutterAxiError {
  if (platform === "android") {
    return new FlutterAxiError(
      "adb not found - Android native commands need the Android SDK platform-tools",
      "TOOLCHAIN_MISSING",
      [
        "Install Android Studio or platform-tools, or set ANDROID_HOME to your SDK root",
        "Check: adb version",
      ],
    );
  }
  return new FlutterAxiError(
    "xcrun not found - iOS simulator commands need Xcode command line tools",
    "TOOLCHAIN_MISSING",
    ["Install with: xcode-select --install"],
  );
}

export interface DeviceTarget {
  platform: Platform;
  /** adb serial (emulator-5554) or simulator UDID. */
  deviceId: string;
  /** Android applicationId / iOS bundle id; required by app-scoped commands. */
  appId: string | null;
}

function requireAppId(target: DeviceTarget, what: string): string {
  if (!target.appId) {
    throw new FlutterAxiError(
      `${what} needs the app id, but none is recorded for this session`,
      "VALIDATION_ERROR",
      [
        "Pass --app-id <bundle/application id>, or relaunch with `flutter-axi launch <root> --app-id <id>`",
      ],
    );
  }
  return target.appId;
}

function requirePlatform(target: DeviceTarget, what: string): void {
  if (target.platform !== "android" && target.platform !== "ios") {
    throw new FlutterAxiError(
      `${what} requires an Android emulator or iOS simulator target`,
      "VALIDATION_ERROR",
      [
        "Run `flutter-axi launch <root> --device <id>` first so the session knows its device",
        "Or pass --device <id> and --platform android|ios explicitly",
      ],
    );
  }
}

/** Build the adb argv prefix targeting a specific device. */
function adbArgs(target: DeviceTarget, ...rest: string[]): string[] {
  return ["-s", target.deviceId, ...rest];
}

// --- Permission name mapping ---

/**
 * Friendly permission names -> platform-specific identifiers. Grant/revoke
 * uses these so agents say `permission grant location` on either platform.
 */
export const PERMISSION_MAP: Record<
  string,
  { android: string[]; ios: string }
> = {
  location: {
    android: [
      "android.permission.ACCESS_FINE_LOCATION",
      "android.permission.ACCESS_COARSE_LOCATION",
    ],
    ios: "location",
  },
  "location-always": {
    android: ["android.permission.ACCESS_BACKGROUND_LOCATION"],
    ios: "location-always",
  },
  camera: { android: ["android.permission.CAMERA"], ios: "camera" },
  microphone: { android: ["android.permission.RECORD_AUDIO"], ios: "microphone" },
  notifications: {
    android: ["android.permission.POST_NOTIFICATIONS"],
    ios: "notifications",
  },
  contacts: { android: ["android.permission.READ_CONTACTS"], ios: "contacts" },
  photos: {
    android: ["android.permission.READ_MEDIA_IMAGES"],
    ios: "photos",
  },
  all: { android: [], ios: "all" },
};

export function resolvePermission(
  name: string,
  platform: Platform,
): string[] {
  const entry = PERMISSION_MAP[name];
  if (entry) {
    return platform === "android" ? entry.android : [entry.ios];
  }
  // Raw platform identifiers pass through (android.permission.X / simctl service names).
  return [name];
}

// --- Command builders (pure - unit-testable argv) ---

export interface NativeCommand {
  command: string;
  args: string[];
}

export function buildGpsCommand(
  target: DeviceTarget,
  lat: number,
  lon: number,
  adbPath: string,
): NativeCommand {
  if (target.platform === "android") {
    // adb emu takes lon first.
    return {
      command: adbPath,
      args: adbArgs(target, "emu", "geo", "fix", String(lon), String(lat)),
    };
  }
  return {
    command: "xcrun",
    args: ["simctl", "location", target.deviceId, "set", `${lat},${lon}`],
  };
}

export function buildPermissionCommands(
  target: DeviceTarget,
  action: "grant" | "revoke" | "reset",
  permission: string,
  appId: string,
  adbPath: string,
): NativeCommand[] {
  const resolved = resolvePermission(permission, target.platform);
  if (target.platform === "android") {
    if (action === "reset") {
      return [
        {
          command: adbPath,
          args: adbArgs(target, "shell", "pm", "reset-permissions", appId),
        },
      ];
    }
    return resolved.map((perm) => ({
      command: adbPath,
      args: adbArgs(target, "shell", "pm", action, appId, perm),
    }));
  }
  return resolved.map((service) => ({
    command: "xcrun",
    args: ["simctl", "privacy", target.deviceId, action, service, appId],
  }));
}

export function buildDeeplinkCommand(
  target: DeviceTarget,
  url: string,
  adbPath: string,
): NativeCommand {
  if (target.platform === "android") {
    return {
      command: adbPath,
      args: adbArgs(
        target,
        "shell",
        "am",
        "start",
        "-a",
        "android.intent.action.VIEW",
        "-d",
        url,
      ),
    };
  }
  return {
    command: "xcrun",
    args: ["simctl", "openurl", target.deviceId, url],
  };
}

export function buildScreenshotCommand(
  target: DeviceTarget,
  filePath: string,
  adbPath: string,
): NativeCommand {
  if (target.platform === "android") {
    // exec-out writes binary png to stdout; the caller redirects to file.
    return {
      command: adbPath,
      args: adbArgs(target, "exec-out", "screencap", "-p"),
    };
  }
  return {
    command: "xcrun",
    args: ["simctl", "io", target.deviceId, "screenshot", filePath],
  };
}

export type LifecycleAction =
  | "install"
  | "uninstall"
  | "clear"
  | "force-stop"
  | "background"
  | "foreground";

export function buildLifecycleCommands(
  target: DeviceTarget,
  action: LifecycleAction,
  appId: string | null,
  artifactPath: string | null,
  adbPath: string,
): NativeCommand[] {
  const android = target.platform === "android";
  switch (action) {
    case "install":
      if (!artifactPath) {
        throw new FlutterAxiError(
          "install needs a path to an .apk / .app artifact",
          "VALIDATION_ERROR",
          ["Run `flutter-axi applifecycle install ./build/app.apk`"],
        );
      }
      return android
        ? [{ command: adbPath, args: adbArgs(target, "install", "-r", artifactPath) }]
        : [
            {
              command: "xcrun",
              args: ["simctl", "install", target.deviceId, artifactPath],
            },
          ];
    case "uninstall":
      return android
        ? [
            {
              command: adbPath,
              args: adbArgs(target, "uninstall", requireId(appId)),
            },
          ]
        : [
            {
              command: "xcrun",
              args: ["simctl", "uninstall", target.deviceId, requireId(appId)],
            },
          ];
    case "clear":
      if (android) {
        return [
          {
            command: adbPath,
            args: adbArgs(target, "shell", "pm", "clear", requireId(appId)),
          },
        ];
      }
      throw new FlutterAxiError(
        "iOS simulators have no direct app-data clear - uninstall and reinstall instead",
        "VALIDATION_ERROR",
        [
          "Run `flutter-axi applifecycle uninstall` then relaunch with `flutter-axi launch <root>`",
        ],
      );
    case "force-stop":
      return android
        ? [
            {
              command: adbPath,
              args: adbArgs(target, "shell", "am", "force-stop", requireId(appId)),
            },
          ]
        : [
            {
              command: "xcrun",
              args: ["simctl", "terminate", target.deviceId, requireId(appId)],
            },
          ];
    case "background":
      return android
        ? [
            {
              command: adbPath,
              args: adbArgs(target, "shell", "input", "keyevent", "KEYCODE_HOME"),
            },
          ]
        : [
            {
              // Foregrounding springboard backgrounds the current app.
              command: "xcrun",
              args: [
                "simctl",
                "launch",
                target.deviceId,
                "com.apple.springboard",
              ],
            },
          ];
    case "foreground":
      return android
        ? [
            {
              command: adbPath,
              args: adbArgs(
                target,
                "shell",
                "monkey",
                "-p",
                requireId(appId),
                "-c",
                "android.intent.category.LAUNCHER",
                "1",
              ),
            },
          ]
        : [
            {
              command: "xcrun",
              args: ["simctl", "launch", target.deviceId, requireId(appId)],
            },
          ];
  }

  function requireId(id: string | null): string {
    if (!id) {
      throw new FlutterAxiError(
        `applifecycle ${action} needs the app id`,
        "VALIDATION_ERROR",
        ["Pass --app-id <bundle/application id>"],
      );
    }
    return id;
  }
}

export function buildBackKeyCommand(
  target: DeviceTarget,
  adbPath: string,
): NativeCommand {
  if (target.platform === "android") {
    return {
      command: adbPath,
      args: adbArgs(target, "shell", "input", "keyevent", "4"),
    };
  }
  throw new FlutterAxiError(
    "iOS has no OS-level back button - use `flutter-axi back` (in-app navigation)",
    "VALIDATION_ERROR",
    [],
  );
}

// --- Executors ---

export async function runGps(
  target: DeviceTarget,
  lat: number,
  lon: number,
  exec: Exec = defaultExec,
): Promise<void> {
  requirePlatform(target, "gps");
  const cmd = buildGpsCommand(target, lat, lon, resolveAdb() ?? "adb");
  await execNative(cmd, target, exec);
}

export interface RoutePoint {
  lat: number;
  lon: number;
}

/** Parse a GPS route file: JSONL of {lat,lon} or "lat,lon" lines. */
export function parseRouteFile(content: string): RoutePoint[] {
  const points: RoutePoint[] = [];
  for (const rawLine of content.split("\n")) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    if (line.startsWith("{")) {
      const parsed = JSON.parse(line) as { lat?: unknown; lon?: unknown };
      if (typeof parsed.lat === "number" && typeof parsed.lon === "number") {
        points.push({ lat: parsed.lat, lon: parsed.lon });
        continue;
      }
      throw new FlutterAxiError(
        `Invalid route line: ${line}`,
        "VALIDATION_ERROR",
        ['Route lines must be {"lat": <num>, "lon": <num>} or "lat,lon"'],
      );
    }
    const m = line.match(/^(-?[\d.]+)\s*,\s*(-?[\d.]+)$/);
    if (!m) {
      throw new FlutterAxiError(
        `Invalid route line: ${line}`,
        "VALIDATION_ERROR",
        ['Route lines must be {"lat": <num>, "lon": <num>} or "lat,lon"'],
      );
    }
    points.push({ lat: Number(m[1]), lon: Number(m[2]) });
  }
  return points;
}

export async function runPermission(
  target: DeviceTarget,
  action: "grant" | "revoke" | "reset",
  permission: string,
  exec: Exec = defaultExec,
): Promise<void> {
  requirePlatform(target, "permission");
  const appId = requireAppId(target, "permission");
  const cmds = buildPermissionCommands(
    target,
    action,
    permission,
    appId,
    resolveAdb() ?? "adb",
  );
  for (const cmd of cmds) {
    await execNative(cmd, target, exec);
  }
}

export async function runDeeplink(
  target: DeviceTarget,
  url: string,
  exec: Exec = defaultExec,
): Promise<void> {
  requirePlatform(target, "deeplink");
  await execNative(
    buildDeeplinkCommand(target, url, resolveAdb() ?? "adb"),
    target,
    exec,
  );
}

/**
 * Deliver a push notification. iOS: real APNs payload via `simctl push`.
 * Android emulators have no FCM injection path without Google services
 * plumbing; v1 posts a local notification via `cmd notification post` as an
 * approximation (documented limitation).
 */
export async function runPush(
  target: DeviceTarget,
  payload: { title: string; body: string; data?: Record<string, string> },
  exec: Exec = defaultExec,
): Promise<void> {
  requirePlatform(target, "push");
  const appId = requireAppId(target, "push");
  if (target.platform === "ios") {
    const apns = {
      "Simulator Target Bundle": appId,
      aps: { alert: { title: payload.title, body: payload.body } },
      ...(payload.data ?? {}),
    };
    const dir = mkdtempSync(join(tmpdir(), "flutter-axi-push-"));
    const file = join(dir, "payload.apns");
    try {
      writeFileSync(file, JSON.stringify(apns));
      await execNative(
        {
          command: "xcrun",
          args: ["simctl", "push", target.deviceId, appId, file],
        },
        target,
        exec,
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
    return;
  }
  const adbPath = resolveAdb() ?? "adb";
  await execNative(
    {
      command: adbPath,
      args: adbArgs(
        target,
        "shell",
        "cmd",
        "notification",
        "post",
        "-t",
        payload.title,
        "flutter_axi",
        payload.body,
      ),
    },
    target,
    exec,
  );
}

/**
 * OS-level screenshot. iOS: simctl writes the file directly. Android:
 * `adb exec-out screencap -p` emits binary PNG on stdout, captured with a
 * buffer-safe exec (not the injectable string exec).
 */
export async function runOsScreenshot(
  target: DeviceTarget,
  filePath: string,
  exec: Exec = defaultExec,
): Promise<void> {
  requirePlatform(target, "screenshot --os");
  if (target.platform === "ios") {
    await execNative(
      buildScreenshotCommand(target, filePath, "adb"),
      target,
      exec,
    );
    return;
  }
  const adbPath = resolveAdb() ?? "adb";
  const png = await new Promise<Buffer>((resolve, reject) => {
    execFile(
      adbPath,
      ["-s", target.deviceId, "exec-out", "screencap", "-p"],
      { encoding: "buffer", timeout: 60_000, maxBuffer: 64 * 1024 * 1024 },
      (error, stdout) => {
        if (error) reject(error);
        else resolve(stdout as unknown as Buffer);
      },
    );
  }).catch((error: Error) => {
    if (error.message.includes("ENOENT")) {
      throw toolchainMissingError("android");
    }
    throw new FlutterAxiError(error.message, "UNKNOWN", [
      "Run `flutter-axi devices` to verify the device is connected",
    ]);
  });
  writeFileSync(filePath, png);
}

async function execNative(
  cmd: NativeCommand,
  target: DeviceTarget,
  exec: Exec,
): Promise<ExecResult> {
  try {
    return await exec(cmd.command, cmd.args);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message.includes("ENOENT")) {
      throw toolchainMissingError(target.platform);
    }
    throw new FlutterAxiError(message, "UNKNOWN", [
      "Run `flutter-axi devices` to verify the device is connected",
    ]);
  }
}

export { execNative };
