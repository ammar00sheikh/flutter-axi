/**
 * HTTP client for the flutter-axi bridge + bridge lifecycle management.
 *
 * Every entry point accepts an optional explicit `session` name so the `run`
 * script command can drive multiple sessions (apps.user / apps.driver) from a
 * single process; when omitted, the session resolves from FLUTTER_AXI_SESSION
 * exactly as in single-app CLI invocations.
 */

import { execFileSync, spawn } from "node:child_process";
import { readFileSync, existsSync } from "node:fs";
import { request } from "node:http";
import { AxiError } from "axi-sdk-js";
import { BRIDGE_PORT_IN_USE_EXIT_CODE, resolveBridgeScript } from "./bridge.js";
import {
  resolveSessionName,
  resolveSessionPidFile,
  resolveSessionPort,
  validateSessionName,
} from "./sessions.js";

const DEFAULT_BRIDGE_TIMEOUT_MS = 30_000;
const MIN_BRIDGE_TIMEOUT_MS = 1_000;
const HEALTH_TIMEOUT_MS = 2_000;
const DEEP_HEALTH_TIMEOUT_MS = 5_000;

/**
 * Resolve the bridge readiness deadline in milliseconds.
 *
 * Honors `FLUTTER_AXI_BRIDGE_TIMEOUT_MS`. Values below 1s are clamped to 1s
 * to avoid pathological retries.
 */
export function resolveBridgeTimeoutMs(): number {
  const raw = process.env.FLUTTER_AXI_BRIDGE_TIMEOUT_MS;
  if (!raw) return DEFAULT_BRIDGE_TIMEOUT_MS;
  const parsed = Number.parseInt(raw, 10);
  if (Number.isNaN(parsed) || parsed <= 0) return DEFAULT_BRIDGE_TIMEOUT_MS;
  return Math.max(parsed, MIN_BRIDGE_TIMEOUT_MS);
}

export type ErrorCode =
  | "BRIDGE_NOT_READY"
  | "NO_APP"
  | "REF_NOT_FOUND"
  | "STALE_REF"
  | "TIMEOUT"
  | "DRIVER_ERROR"
  | "TOOLCHAIN_MISSING"
  | "VALIDATION_ERROR"
  | "UNKNOWN";

export class FlutterAxiError extends AxiError {
  constructor(
    message: string,
    public readonly code: ErrorCode,
    public readonly suggestions: string[] = [],
  ) {
    super(message, code, suggestions);
    this.name = "FlutterAxiError";
  }
}

/** Resolve an explicit session name (validated) or the ambient one. */
export function resolveSession(session?: string): string {
  if (session === undefined) return resolveSessionName();
  const name = session.trim();
  if (name.length === 0) return resolveSessionName();
  validateSessionName(name);
  return name;
}

interface PidInfo {
  pid: number;
  port: number;
}

function readPidFile(pidFile: string): PidInfo | null {
  try {
    if (!existsSync(pidFile)) return null;
    const data = JSON.parse(readFileSync(pidFile, "utf-8"));
    if (typeof data.pid === "number" && typeof data.port === "number") {
      return data as PidInfo;
    }
    return null;
  } catch {
    return null;
  }
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function httpGet(
  port: number,
  path: string,
  timeoutMs = 2000,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const req = request(
      { hostname: "127.0.0.1", port, path, method: "GET", timeout: timeoutMs },
      (res) => {
        let data = "";
        res.on("data", (chunk) => (data += chunk));
        res.on("end", () => resolve(data));
      },
    );
    req.on("error", reject);
    req.on("timeout", () => {
      req.destroy();
      reject(new Error("timeout"));
    });
    req.end();
  });
}

function httpPost(
  port: number,
  path: string,
  body: unknown,
  timeoutMs = 300_000,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const req = request(
      {
        hostname: "127.0.0.1",
        port,
        path,
        method: "POST",
        timeout: timeoutMs,
        headers: {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(payload),
        },
      },
      (res) => {
        let data = "";
        res.on("data", (chunk) => (data += chunk));
        res.on("end", () => {
          if (res.statusCode && res.statusCode >= 400) {
            reject(new Error(data));
          } else {
            resolve(data);
          }
        });
      },
    );
    req.on("error", reject);
    req.on("timeout", () => {
      req.destroy();
      reject(new Error("timeout"));
    });
    req.write(payload);
    req.end();
  });
}

/**
 * Probe the bridge's `/health` endpoint. With `deep: true`, asks the bridge
 * to drive one MCP round trip (`list_running_apps`) so callers can distinguish
 * "HTTP server is up but the Dart MCP child is wedged" from genuine readiness.
 *
 * With `expectedSession`, a bridge that reports a *different* session name is
 * treated as unhealthy, so a session never silently reuses another session's
 * bridge after a port collision (two sessions pinned to one port via a global
 * `FLUTTER_AXI_PORT`). A bridge that omits the field is accepted, since there
 * is no mismatch to detect.
 *
 * Exported for tests; production code uses it via `ensureBridge`.
 */
export async function checkBridgeHealth(
  port: number,
  opts: { deep?: boolean; expectedSession?: string } = {},
): Promise<boolean> {
  try {
    const path = opts.deep ? "/health?deep=1" : "/health";
    const timeoutMs = opts.deep ? DEEP_HEALTH_TIMEOUT_MS : HEALTH_TIMEOUT_MS;
    const resp = await httpGet(port, path, timeoutMs);
    const data = JSON.parse(resp);
    if (data.status !== "ok") return false;
    if (
      opts.expectedSession !== undefined &&
      typeof data.session === "string" &&
      data.session !== opts.expectedSession
    ) {
      return false;
    }
    return true;
  } catch {
    return false;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

export async function waitForProcessExit(
  pid: number,
  timeoutMs: number,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!isProcessAlive(pid)) return true;
    await sleep(50);
  }
  return !isProcessAlive(pid);
}

function isBridgeProcess(pid: number): boolean {
  try {
    const command = execFileSync("ps", ["-p", String(pid), "-o", "command="], {
      encoding: "utf-8",
      timeout: 1000,
    });
    return command.includes("flutter-axi-bridge");
  } catch {
    return false;
  }
}

/**
 * Terminate a bridge process and reap its detached process group. Sends
 * SIGTERM, polls up to ~2s for exit, then escalates to SIGKILL on the entire
 * process group so dart mcp-server / flutter run children can't survive as
 * orphans. Returns once the bridge PID is gone (or the SIGKILL grace window
 * expires).
 */
export async function terminateBridgeProcess(
  pid: number,
  opts: { killProcessGroup?: boolean } = {},
): Promise<void> {
  if (!isProcessAlive(pid)) return;
  const killProcessGroup = opts.killProcessGroup === true;

  // Give the bridge a chance to run its own shutdown handler (which kills its
  // process group on `exit`).
  try {
    process.kill(pid, "SIGTERM");
  } catch {
    return;
  }

  if (await waitForProcessExit(pid, 2000)) {
    if (killProcessGroup) {
      try {
        process.kill(-pid, "SIGKILL");
      } catch {
        // Group already gone or pid was never a group leader — fine.
      }
    }
    return;
  }

  // Escalate: kill the whole process group so children get reaped together.
  if (killProcessGroup) {
    try {
      process.kill(-pid, "SIGKILL");
    } catch {
      try {
        process.kill(pid, "SIGKILL");
      } catch {
        // Already dead.
      }
    }
  } else {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // Already dead.
    }
  }
  await waitForProcessExit(pid, 1000);
}

/**
 * Minimal view of the spawned bridge process that {@link ensureBridge} needs:
 * an `exit` notification so a bridge that dies before reporting healthy can be
 * detected. The default {@link spawnBridgeProcess} returns a `ChildProcess`
 * (which satisfies this); tests inject a fake.
 */
export interface SpawnedBridge {
  on(
    event: "exit",
    listener: (code: number | null, signal: NodeJS.Signals | null) => void,
  ): void;
}

/**
 * Spawn the detached bridge process. Prefers the sibling `.ts` (dev mode, run
 * via tsx) and falls back to the built `.js`, so dev and dist behave the same.
 */
function spawnBridgeProcess(port: number, sessionName: string): SpawnedBridge {
  const bridgeScript = resolveBridgeScript(import.meta.dirname);
  const script = existsSync(bridgeScript.replace(/\.js$/, ".ts"))
    ? bridgeScript.replace(/\.js$/, ".ts")
    : bridgeScript;
  const runner = script.endsWith(".ts") ? "tsx" : "node";

  const child = spawn(
    runner === "tsx" ? "npx" : "node",
    runner === "tsx" ? ["tsx", script] : [script],
    {
      stdio: "ignore",
      env: {
        ...process.env,
        FLUTTER_AXI_PORT: String(port),
        FLUTTER_AXI_SESSION: sessionName,
      },
      detached: true,
    },
  );
  child.unref();
  return child;
}

/**
 * Build the error thrown when a freshly spawned bridge exits before it ever
 * reports healthy. Surfacing this the moment the child dies - rather than
 * polling the full readiness deadline - turns an early death into a fast,
 * actionable failure instead of a slow, generic "failed to start" timeout.
 *
 * The guidance is attributed by exit code. Only {@link BRIDGE_PORT_IN_USE_EXIT_CODE}
 * (the bridge's EADDRINUSE sentinel) gets the port-in-use explanation; any
 * other early death is a startup failure (`dart mcp-server` could not start:
 * dart missing from PATH, an SDK too old to ship mcp-server, or a broken
 * FLUTTER_AXI_DART_BIN) and gets the generic startup guidance.
 */
export function buildBridgeEarlyExitError(
  sessionName: string,
  port: number,
  code: number | null,
  signal: NodeJS.Signals | null,
): FlutterAxiError {
  const how =
    signal != null
      ? `was killed by ${signal}`
      : `exited with code ${code ?? "unknown"}`;
  const message = `Bridge for session "${sessionName}" ${how} before becoming ready on port ${port}`;

  if (code === BRIDGE_PORT_IN_USE_EXIT_CODE) {
    return new FlutterAxiError(message, "BRIDGE_NOT_READY", [
      `Port ${port} is already in use. It may be held by another flutter-axi session's bridge (a hashed-port collision, or a globally-exported FLUTTER_AXI_PORT forcing every session onto one port), by a stale or crashed bridge that could not be reused, or by an unrelated process.`,
      "Set a distinct FLUTTER_AXI_PORT for this session, unset a global FLUTTER_AXI_PORT so every session derives its own, or free whatever is holding the port.",
    ]);
  }

  const suggestions = [
    "Check that the Dart MCP server can start: dart mcp-server --help",
    "The Dart SDK must be >= 3.9 (ships mcp-server). Check: dart --version",
  ];
  if (process.env.FLUTTER_AXI_DART_BIN) {
    suggestions.push(
      "Verify FLUTTER_AXI_DART_BIN points to a valid dart executable.",
    );
  } else {
    suggestions.push(
      "If dart is not on PATH, set FLUTTER_AXI_DART_BIN to your Flutter SDK's dart (e.g. ~/flutter/bin/dart).",
    );
  }
  return new FlutterAxiError(message, "BRIDGE_NOT_READY", suggestions);
}

/**
 * Ensure the bridge is running, starting it if needed. Returns the port.
 *
 * Verifies a *deep* health check (one MCP round trip) before declaring the
 * bridge ready, so a bridge whose Dart MCP child wedged while still answering
 * local /health requests gets torn down + restarted instead of being reused
 * as a stale endpoint.
 *
 * `spawnBridge` is injectable for tests; production uses {@link spawnBridgeProcess}.
 */
export async function ensureBridge(
  spawnBridge: (
    port: number,
    sessionName: string,
  ) => SpawnedBridge = spawnBridgeProcess,
  session?: string,
): Promise<number> {
  const sessionName = resolveSession(session);
  const port = resolveSessionPort(sessionName);
  const pidFile = resolveSessionPidFile(sessionName);

  // Check existing bridge via PID file. Use a deep probe so a bridge whose
  // MCP child has wedged gets recycled instead of returned.
  const pidInfo = readPidFile(pidFile);
  if (pidInfo && isProcessAlive(pidInfo.pid)) {
    if (
      await checkBridgeHealth(pidInfo.port, {
        deep: true,
        expectedSession: sessionName,
      })
    ) {
      return pidInfo.port;
    }
    await terminateBridgeProcess(pidInfo.pid, {
      killProcessGroup: isBridgeProcess(pidInfo.pid),
    });
  }

  // Start a new bridge
  const child = spawnBridge(port, sessionName);

  // If the freshly spawned bridge dies before it reports healthy - an
  // EADDRINUSE port collision with another session, or a startup failure
  // (dart missing, mcp-server unavailable) whose stderr is lost to
  // `stdio: "ignore"` - fail fast instead of polling the full readiness
  // deadline and reporting a generic timeout.
  let childExited = false;
  let exitCode: number | null = null;
  let exitSignal: NodeJS.Signals | null = null;
  child.on("exit", (code, signal) => {
    childExited = true;
    exitCode = code;
    exitSignal = signal;
  });

  const timeoutMs = resolveBridgeTimeoutMs();
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (
      await checkBridgeHealth(port, {
        deep: true,
        expectedSession: sessionName,
      })
    ) {
      return port;
    }
    if (childExited) {
      if (
        await checkBridgeHealth(port, {
          deep: true,
          expectedSession: sessionName,
        })
      ) {
        return port;
      }
      throw buildBridgeEarlyExitError(sessionName, port, exitCode, exitSignal);
    }
    await sleep(500);
  }

  const seconds = Math.round(timeoutMs / 1000);
  throw new FlutterAxiError(
    `Bridge failed to start within ${seconds}s`,
    "BRIDGE_NOT_READY",
    [
      "Check that the Dart MCP server can start: dart mcp-server --help",
      "Or extend the deadline: export FLUTTER_AXI_BRIDGE_TIMEOUT_MS=60000",
    ],
  );
}

/**
 * Call an MCP tool via the bridge. Returns the text result.
 * `opts.session` targets a specific session's bridge (multi-app `run`);
 * `opts.timeoutMs` overrides the default request timeout (launches compile).
 */
export async function callTool(
  name: string,
  args: Record<string, unknown> = {},
  opts: { session?: string; timeoutMs?: number } = {},
): Promise<string> {
  const port = await ensureBridge(undefined, opts.session);

  try {
    const resp = await httpPost(port, "/call", { name, args }, opts.timeoutMs);
    const data = JSON.parse(resp);
    if (data.error) {
      throw new Error(data.error);
    }
    return data.result ?? "";
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw mapErrorMessage(message);
  }
}

export interface ToolImage {
  data: string;
  mimeType: string;
}

/**
 * Like {@link callTool} but also returns any image content blocks the tool
 * produced (driver screenshots). Most tools return text only.
 */
export async function callToolWithImages(
  name: string,
  args: Record<string, unknown> = {},
  opts: { session?: string; timeoutMs?: number } = {},
): Promise<{ result: string; images: ToolImage[] }> {
  const port = await ensureBridge(undefined, opts.session);

  try {
    const resp = await httpPost(port, "/call", { name, args }, opts.timeoutMs);
    const data = JSON.parse(resp);
    if (data.error) {
      throw new Error(data.error);
    }
    return {
      result: data.result ?? "",
      images: Array.isArray(data.images) ? (data.images as ToolImage[]) : [],
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw mapErrorMessage(message);
  }
}

export function mapErrorMessage(message: string): FlutterAxiError {
  if (message.includes("ECONNREFUSED") || message.includes("ECONNRESET")) {
    return new FlutterAxiError("Bridge is not running", "BRIDGE_NOT_READY", [
      "Run `flutter-axi launch <root> --device <id>` — the bridge starts automatically",
    ]);
  }
  if (
    message.includes("No app is currently connected") ||
    message.includes("No active debug session") ||
    message.includes("connect_dart_tooling_daemon") ||
    message.includes("DTD connection")
  ) {
    return new FlutterAxiError(message, "NO_APP", [
      "Run `flutter-axi launch <root> --device <id>` to start and attach an app",
      "Run `flutter-axi devices` to list available devices",
    ]);
  }
  if (
    (message.includes("finder") || message.includes("element")) &&
    (message.includes("not found") || message.includes("invalid"))
  ) {
    return new FlutterAxiError(message, "REF_NOT_FOUND", [
      "Run `flutter-axi snapshot` to see current widgets and their @uid refs",
    ]);
  }
  if (message.includes("timeout") || message.includes("timed out")) {
    return new FlutterAxiError(message, "TIMEOUT", [
      "Run `flutter-axi snapshot` to see current app state",
    ]);
  }
  if (
    message.includes("flutter_driver") ||
    message.includes("driver extension") ||
    message.includes("ext.flutter.driver")
  ) {
    return new FlutterAxiError(message, "DRIVER_ERROR", [
      "Run `flutter-axi snapshot` to see current app state",
      "The app must have been started via `flutter-axi launch` for driver input to work",
    ]);
  }
  // Try to parse JSON error
  try {
    const parsed = JSON.parse(message);
    if (parsed.error) {
      return new FlutterAxiError(parsed.error, "DRIVER_ERROR", [
        "Run `flutter-axi snapshot` to see current app state",
      ]);
    }
  } catch {
    // Not JSON
  }
  return new FlutterAxiError(message, "UNKNOWN");
}

/**
 * Call an MCP tool only if this session's bridge is already running & healthy.
 *
 * Returns null if the bridge is not running. This backs the ambient home view
 * / SessionStart probe, so it must stay cheap and never throw: an invalid
 * session name degrades to "no active session" (null) here, while action
 * commands (`ensureBridge` / `stopBridge`) still fail loudly.
 */
export async function callToolIfRunning(
  name: string,
  args: Record<string, unknown> = {},
  session?: string,
): Promise<string | null> {
  let sessionName: string;
  let pidInfo: PidInfo | null;
  try {
    sessionName = resolveSession(session);
    pidInfo = readPidFile(resolveSessionPidFile(sessionName));
  } catch {
    return null;
  }
  if (!pidInfo || !isProcessAlive(pidInfo.pid)) {
    return null;
  }
  if (
    !(await checkBridgeHealth(pidInfo.port, { expectedSession: sessionName }))
  ) {
    return null;
  }
  try {
    const resp = await httpPost(pidInfo.port, "/call", { name, args }, 5000);
    const data = JSON.parse(resp);
    if (data.error) return null;
    return data.result ?? null;
  } catch {
    return null;
  }
}

/**
 * Stop the bridge process. Waits for the bridge PID to actually exit (bounded
 * poll, ~2s) before escalating to SIGKILL on the entire detached process
 * group, so dart mcp-server + flutter run children get reaped together rather
 * than orphaned. Resolves once the bridge process is gone.
 */
export async function stopBridge(session?: string): Promise<boolean> {
  const sessionName = resolveSession(session);
  const pidInfo = readPidFile(resolveSessionPidFile(sessionName));
  if (!pidInfo) return false;
  if (!isProcessAlive(pidInfo.pid)) return false;
  await terminateBridgeProcess(pidInfo.pid, {
    killProcessGroup: isBridgeProcess(pidInfo.pid),
  });
  return true;
}
