/**
 * Per-session app state persistence. When `launch` starts a Flutter app it
 * records the essentials here (app.json in the session state dir) so later
 * short-lived CLI invocations - logs, stopapp, native gps/permission commands
 * keyed off the device/appId - know which app this session is driving.
 */

import {
  existsSync,
  mkdirSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { resolveSessionStateDir } from "./sessions.js";

export type Platform = "android" | "ios" | "unknown";

export interface AppState {
  /** Process id reported by launch_app (used for logs/stop_app). */
  pid: number | null;
  /** Dart Tooling Daemon URI the session is connected to. */
  dtdUri: string | null;
  /** Device id the app was launched on (e.g. emulator-5554, a simulator UUID). */
  deviceId: string | null;
  platform: Platform;
  /** Android applicationId / iOS bundle id - needed by the native layer. */
  appId: string | null;
  /** Flutter project root the app was launched from. */
  projectRoot: string | null;
  launchedAt: string | null;
}

const EMPTY_STATE: AppState = {
  pid: null,
  dtdUri: null,
  deviceId: null,
  platform: "unknown",
  appId: null,
  projectRoot: null,
  launchedAt: null,
};

function appFile(session?: string): string {
  return join(resolveSessionStateDir(session), "app.json");
}

export function readAppState(session?: string): AppState | null {
  const file = appFile(session);
  try {
    if (!existsSync(file)) return null;
    const data = JSON.parse(readFileSync(file, "utf-8"));
    if (data === null || typeof data !== "object") return null;
    return { ...EMPTY_STATE, ...data } as AppState;
  } catch {
    return null;
  }
}

export function writeAppState(state: AppState, session?: string): void {
  const file = appFile(session);
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, JSON.stringify(state, null, 2));
  // Atomic replace so concurrent readers never see a torn write.
  writeFileSync(file, readFileSync(tmp));
  unlinkSync(tmp);
}

export function clearAppState(session?: string): void {
  const file = appFile(session);
  try {
    if (existsSync(file)) unlinkSync(file);
  } catch {
    // ignore
  }
}

/**
 * Infer the platform from a Flutter device id. Android devices are
 * `emulator-NNNN` or physical serials; iOS simulators are UUIDs; desktop and
 * web ids are named. Only android/ios matter to the native layer.
 */
export function platformForDeviceId(deviceId: string): Platform {
  if (/^emulator-\d+$/.test(deviceId)) return "android";
  if (/^[0-9A-Fa-f-]{36}$/.test(deviceId)) return "ios";
  // Physical Android serials are alphanumeric without dashes; physical iOS
  // device ids are 25-char with a dash at position 8 (older) or UUIDs (newer).
  if (/^[0-9A-Fa-f]{8}-[0-9A-Fa-f]{16}$/.test(deviceId)) return "ios";
  if (/^[A-Za-z0-9]{6,}$/.test(deviceId)) return "android";
  return "unknown";
}
