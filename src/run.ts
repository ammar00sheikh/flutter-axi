/**
 * Script runner for `flutter-axi run`.
 *
 * Reads a script from stdin, provides `app` (the invoking session) and
 * `apps.<name>` (any named session) globals, and executes it. Only the
 * script's own console.log output is visible to the caller.
 *
 * `apps` is a Proxy: `apps.user` / `apps.driver` lazily create helpers bound
 * to those sessions, each talking to its own bridge - a single script can
 * orchestrate a rider-driver flow across two devices.
 */

import { mkdtempSync, writeFileSync, unlinkSync, rmdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { callTool, callToolWithImages, FlutterAxiError } from "./client.js";
import {
  fill,
  getText,
  goBack,
  pressAction,
  requireAppState,
  resolveFinderArg,
  scroll,
  scrollInto,
  takeSnapshot,
  tap,
  typeText,
  waitFor,
  type ScrollOptions,
} from "./actions.js";
import { launchApp, stopApp, type LaunchOptions } from "./lifecycle.js";
import {
  runDeeplink,
  runGps,
  runPermission,
  runPush,
  type DeviceTarget,
} from "./device.js";
import { resolveOutputPath } from "./paths.js";

/** Read all of stdin into a string. */
export async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
  }
  return Buffer.concat(chunks).toString("utf-8");
}

// --- App helper ---

export interface AppHelper {
  launch(root: string, opts?: LaunchOptions): Promise<{ pid: number }>;
  stop(): Promise<void>;
  snapshot(opts?: { deep?: boolean }): Promise<string>;
  tap(ref: string): Promise<void>;
  fill(ref: string, text: string): Promise<void>;
  type(text: string): Promise<void>;
  press(action: string): Promise<void>;
  scroll(ref: string, opts?: ScrollOptions): Promise<void>;
  scrollInto(ref: string): Promise<void>;
  back(): Promise<void>;
  text(ref: string): Promise<string>;
  waitFor(text: string, opts?: { absent?: boolean; timeout?: number }): Promise<void>;
  wait(ms: number): Promise<void>;
  reload(): Promise<void>;
  restart(): Promise<void>;
  logs(maxLines?: number): Promise<string[]>;
  errors(): Promise<string>;
  screenshot(path: string): Promise<string>;
  gps(lat: number, lon: number): Promise<void>;
  permission(action: "grant" | "revoke" | "reset", name: string): Promise<void>;
  deeplink(url: string): Promise<void>;
  push(payload: { title: string; body: string; data?: Record<string, string> }): Promise<void>;
}

function deviceTarget(session: string | undefined): DeviceTarget {
  const state = requireAppState(session);
  return {
    platform: state.platform,
    deviceId: state.deviceId ?? "",
    appId: state.appId,
  };
}

/**
 * Create an app helper bound to a session. `session` undefined = the ambient
 * (invoking) session.
 */
export function createAppHelper(session?: string): AppHelper {
  return {
    async launch(root: string, opts: LaunchOptions = {}) {
      const result = await launchApp(root, { ...opts, session });
      return { pid: result.pid };
    },

    async stop() {
      await stopApp(session);
    },

    async snapshot(opts: { deep?: boolean } = {}) {
      const snap = await takeSnapshot({ deep: opts.deep, session });
      return snap.text;
    },

    async tap(ref: string) {
      await tap(resolveFinderArg(ref, session), session);
    },

    async fill(ref: string, text: string) {
      await fill(resolveFinderArg(ref, session), text, session);
    },

    async type(text: string) {
      await typeText(text, session);
    },

    async press(action: string) {
      await pressAction(action, session);
    },

    async scroll(ref: string, opts: ScrollOptions = {}) {
      await scroll(resolveFinderArg(ref, session), opts, session);
    },

    async scrollInto(ref: string) {
      await scrollInto(resolveFinderArg(ref, session), session);
    },

    async back() {
      await goBack(session);
    },

    async text(ref: string) {
      return getText(resolveFinderArg(ref, session), session);
    },

    async waitFor(text: string, opts: { absent?: boolean; timeout?: number } = {}) {
      await waitFor(text, { absent: opts.absent, timeoutMs: opts.timeout }, session);
    },

    async wait(ms: number) {
      await new Promise((r) => setTimeout(r, ms));
    },

    async reload() {
      await callTool("hot_reload", {}, { session });
    },

    async restart() {
      await callTool("hot_restart", {}, { session });
    },

    async logs(maxLines = 100) {
      const state = requireAppState(session);
      const raw = await callTool(
        "get_app_logs",
        { pid: state.pid, maxLines },
        { session },
      );
      try {
        const parsed = JSON.parse(raw) as { logs?: unknown };
        return Array.isArray(parsed.logs) ? parsed.logs.map(String) : [raw];
      } catch {
        return [raw];
      }
    },

    async errors() {
      return callTool("get_runtime_errors", {}, { session });
    },

    async screenshot(path: string) {
      const resolved = resolveOutputPath(path);
      const { images } = await callToolWithImages(
        "flutter_driver",
        { command: "screenshot" },
        { session },
      );
      const data = images[0]?.data;
      if (!data) {
        throw new FlutterAxiError(
          "Driver screenshot returned no image data",
          "DRIVER_ERROR",
          ["Try the OS screenshot instead: flutter-axi screenshot <path> --os"],
        );
      }
      writeFileSync(resolved, Buffer.from(data, "base64"));
      return resolved;
    },

    async gps(lat: number, lon: number) {
      await runGps(deviceTarget(session), lat, lon);
    },

    async permission(action: "grant" | "revoke" | "reset", name: string) {
      await runPermission(deviceTarget(session), action, name);
    },

    async deeplink(url: string) {
      await runDeeplink(deviceTarget(session), url);
    },

    async push(payload: { title: string; body: string; data?: Record<string, string> }) {
      await runPush(deviceTarget(session), payload);
    },
  };
}

/** `apps` global: property access binds a helper to that session name. */
export function createAppsProxy(): Record<string, AppHelper> {
  const cache = new Map<string, AppHelper>();
  return new Proxy(
    {},
    {
      get(_target, prop) {
        if (typeof prop !== "string") return undefined;
        let helper = cache.get(prop);
        if (!helper) {
          helper = createAppHelper(prop);
          cache.set(prop, helper);
        }
        return helper;
      },
    },
  ) as Record<string, AppHelper>;
}

// --- Script runner ---

export interface RunResult {
  stdout: string;
}

export async function runScript(content: string): Promise<RunResult> {
  const app = createAppHelper();
  const apps = createAppsProxy();

  // Write to a temp .mjs so dynamic import supports top-level await
  const tmpDir = mkdtempSync(join(tmpdir(), "flutter-axi-run-"));
  const tmpFile = join(tmpDir, "script.mjs");
  writeFileSync(tmpFile, content, "utf-8");

  // Capture console.log output from the script
  const lines: string[] = [];
  const origLog = console.log;
  const captureLog = (...args: unknown[]) => {
    lines.push(args.map(String).join(" "));
  };

  const globals = globalThis as Record<string, unknown>;
  const prevApp = globals.app;
  const prevApps = globals.apps;
  globals.app = app;
  globals.apps = apps;
  console.log = captureLog;

  try {
    const mod = await import(tmpFile);

    // Support optional default export function
    if (typeof mod.default === "function") {
      await mod.default();
    }
  } finally {
    console.log = origLog;
    if (prevApp === undefined) delete globals.app;
    else globals.app = prevApp;
    if (prevApps === undefined) delete globals.apps;
    else globals.apps = prevApps;
    // Clean up temp file
    try {
      unlinkSync(tmpFile);
      rmdirSync(tmpDir);
    } catch {
      /* best effort */
    }
  }

  const stdout = lines.length > 0 ? lines.join("\n") + "\n" : "";
  return { stdout };
}
