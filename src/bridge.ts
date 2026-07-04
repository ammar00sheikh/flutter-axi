/**
 * Persistent MCP bridge server for flutter-axi.
 *
 * Spawns `dart mcp-server` as a child process and maintains a single
 * persistent MCP session. Exposes a simple HTTP API:
 *   POST /call  { name, args }  → { result }
 *   GET  /tools                 → [{ name, description }]
 *   GET  /health                → { status: "ok", session } or 503 { status: "error", error }
 *   GET  /health?deep=1         → also drives one MCP round trip; 503 may include reason
 *
 * Writes a PID file to the active session's state dir on startup
 * (~/.flutter-axi/bridge.pid for the default session; named sessions nest
 * under sessions/<name>/ - see src/sessions.ts).
 *
 * One bridge owns one Dart MCP child, which has a single "active application"
 * notion - so one bridge session maps to one target Flutter app.
 */

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, resolve } from "node:path";
import {
  resolveSessionName,
  resolveSessionPidFile,
  resolveSessionPort,
} from "./sessions.js";

export interface BridgeContentBlock {
  type: string;
  text?: string;
  data?: string;
  mimeType?: string;
}

export interface BridgeImage {
  data: string;
  mimeType: string;
}

export interface BridgeCallPayload {
  name: string;
  args: Record<string, unknown>;
}

interface BridgeToolDescription {
  name: string;
  description?: string;
}

export interface BridgeClient {
  listTools(): Promise<{ tools: BridgeToolDescription[] }>;
  callTool(request: {
    name: string;
    arguments: Record<string, unknown>;
  }): Promise<unknown>;
  close(): Promise<void>;
}

export async function isBridgeClientConnected(
  client: BridgeClient,
): Promise<boolean> {
  try {
    await client.listTools();
    return true;
  } catch {
    return false;
  }
}

/**
 * Probe whether the bridge's MCP child is genuinely responsive. Drives one
 * round-trip MCP tool call (`list_running_apps` - cheap, in-server, no device
 * round trip) — `listTools()` alone only confirms the transport is up. Used by
 * `/health?deep=1` so `ensureBridge` can detect a wedged Dart MCP child and
 * recycle the bridge. App-level liveness (is the launched Flutter app still
 * running?) is checked at the CLI layer against the session's app state.
 */
export async function isBridgeTargetReachable(
  client: BridgeClient,
): Promise<{ ok: true } | { ok: false; reason: string }> {
  try {
    await client.callTool({ name: "list_running_apps", arguments: {} });
    return { ok: true };
  } catch (error) {
    return { ok: false, reason: getErrorMessage(error) };
  }
}

function writePidFile(port: number): void {
  const pidFile = resolveSessionPidFile();
  mkdirSync(dirname(pidFile), { recursive: true });
  writeFileSync(pidFile, JSON.stringify({ pid: process.pid, port }));
}

/**
 * Remove the session PID file, but only when this process owns it. On a
 * same-session bind race the losing bridge exits via EADDRINUSE after the
 * winning bridge has already written the shared PID file; an unconditional
 * unlink would delete the still-running winner's handle and orphan it (later
 * `stop`/reuse can no longer find it). A missing, unreadable, or malformed
 * file — or one recording a different pid — is left untouched. `ownerPid` is
 * injectable for tests.
 */
export function removePidFile(
  pidFile: string = resolveSessionPidFile(),
  ownerPid: number = process.pid,
): void {
  try {
    const data = JSON.parse(readFileSync(pidFile, "utf-8")) as {
      pid?: unknown;
    };
    if (data.pid !== ownerPid) return;
  } catch {
    // Missing, unreadable, or malformed — nothing we own to remove.
    return;
  }
  try {
    unlinkSync(pidFile);
  } catch {
    // Already gone — fine
  }
}

export function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function extractToolText(content: BridgeContentBlock[]): string {
  return content
    .filter((block) => block.type === "text" && typeof block.text === "string")
    .map((block) => block.text)
    .join("\n");
}

/**
 * Extract image content blocks (driver screenshots return these instead of
 * text) so /call can forward them to the CLI as base64.
 */
export function extractToolImages(
  content: BridgeContentBlock[],
): BridgeImage[] {
  return content
    .filter(
      (block) => block.type === "image" && typeof block.data === "string",
    )
    .map((block) => ({
      data: block.data as string,
      mimeType: block.mimeType ?? "image/png",
    }));
}

/**
 * Prefer a tool's machine-readable `structuredContent` (JSON) over its
 * human-readable text blocks. The Dart MCP server returns both for most
 * tools; the JSON form is what flutter-axi's parsers consume. Tool *errors*
 * keep the text form (isError results carry the message in content).
 */
export function extractResultText(
  result: unknown,
  content: BridgeContentBlock[],
): string {
  if (
    result &&
    typeof result === "object" &&
    !("isError" in result && (result as { isError?: unknown }).isError) &&
    "structuredContent" in result &&
    (result as { structuredContent?: unknown }).structuredContent !== undefined
  ) {
    return JSON.stringify(
      (result as { structuredContent: unknown }).structuredContent,
    );
  }
  return extractToolText(content);
}

function getToolContent(result: unknown): BridgeContentBlock[] {
  if (
    !result ||
    typeof result !== "object" ||
    !("content" in result) ||
    !Array.isArray(result.content)
  ) {
    return [];
  }
  return result.content as BridgeContentBlock[];
}

export function parseBridgeCallPayload(body: string): BridgeCallPayload {
  let payload: { name?: unknown; args?: unknown };
  try {
    payload = JSON.parse(body) as { name?: unknown; args?: unknown };
  } catch {
    throw new Error("Invalid bridge request payload");
  }
  if (typeof payload.name !== "string" || payload.name.length === 0) {
    throw new Error("Invalid bridge request payload");
  }
  if (payload.args === undefined) {
    return { name: payload.name, args: {} };
  }
  if (
    payload.args === null ||
    typeof payload.args !== "object" ||
    Array.isArray(payload.args)
  ) {
    throw new Error("Invalid bridge request payload");
  }
  return { name: payload.name, args: payload.args as Record<string, unknown> };
}

export function resolveBridgeScript(importMetaDir: string): string {
  const builtScript = resolve(importMetaDir, "../bin/flutter-axi-bridge.js");
  const sourceScript = builtScript.replace(/\.js$/, ".ts");
  return existsSync(sourceScript) ? sourceScript : builtScript;
}

async function readRequestBody(req: IncomingMessage): Promise<string> {
  let body = "";
  for await (const chunk of req) {
    body += typeof chunk === "string" ? chunk : chunk.toString("utf-8");
  }
  return body;
}

function writeJson(
  res: ServerResponse,
  statusCode: number,
  payload: unknown,
): void {
  res.statusCode = statusCode;
  res.end(JSON.stringify(payload));
}

async function handleToolsRequest(
  client: BridgeClient,
  res: ServerResponse,
): Promise<void> {
  const result = await client.listTools();
  writeJson(
    res,
    200,
    result.tools.map((tool) => ({
      name: tool.name,
      description: tool.description,
    })),
  );
}

async function handleCallRequest(
  client: BridgeClient,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  const body = await readRequestBody(req);
  const payload = parseBridgeCallPayload(body);
  const result = await client.callTool({
    name: payload.name,
    arguments: payload.args,
  });
  const content = getToolContent(result);
  const images = extractToolImages(content);
  const response: Record<string, unknown> = {
    result: extractResultText(result, content),
  };
  if (images.length > 0) response.images = images;
  writeJson(res, 200, response);
}

export async function handleBridgeRequest(
  client: BridgeClient,
  req: IncomingMessage,
  res: ServerResponse,
  sessionName?: string,
): Promise<void> {
  res.setHeader("Content-Type", "application/json");

  if (
    req.method === "GET" &&
    (req.url === "/health" || req.url?.startsWith("/health?"))
  ) {
    if (!(await isBridgeClientConnected(client))) {
      writeJson(res, 503, { status: "error", error: "Not connected" });
      return;
    }
    const deep = req.url.includes("deep=1");
    if (deep) {
      const probe = await isBridgeTargetReachable(client);
      if (!probe.ok) {
        writeJson(res, 503, {
          status: "error",
          error: "Dart MCP server unresponsive",
          reason: probe.reason,
        });
        return;
      }
    }
    writeJson(res, 200, { status: "ok", session: sessionName });
    return;
  }

  try {
    if (req.method === "GET" && req.url === "/tools") {
      await handleToolsRequest(client, res);
      return;
    }

    if (req.method === "POST" && req.url === "/call") {
      await handleCallRequest(client, req, res);
      return;
    }
  } catch (error) {
    writeJson(res, 500, { error: getErrorMessage(error) });
    return;
  }

  writeJson(res, 404, { error: "not found" });
}

export function createBridgeServer(
  client: BridgeClient,
  sessionName?: string,
): Server {
  return createServer((req, res) => {
    void handleBridgeRequest(client, req, res, sessionName);
  });
}

function logBridgeMessage(message: string): void {
  process.stderr.write(`[flutter-axi] ${message}\n`);
}

/**
 * Distinct exit code the bridge uses for an EADDRINUSE bind failure. A generic
 * non-zero exit is ambiguous (a dart mcp-server launch failure exits non-zero
 * too), so `ensureBridge` keys on this sentinel to attribute an early death to
 * a genuine port collision versus a startup failure and tailor its error.
 */
export const BRIDGE_PORT_IN_USE_EXIT_CODE = 48;

/**
 * Handle a fatal HTTP server error by logging it and exiting non-zero. An
 * EADDRINUSE means another bridge already owns this port (typically because
 * `FLUTTER_AXI_PORT` was exported globally, forcing every session onto one
 * port); it exits with {@link BRIDGE_PORT_IN_USE_EXIT_CODE} so `ensureBridge`
 * can distinguish it from any other early death. Failing loudly prevents
 * `ensureBridge` from silently attaching to the other session's bridge. `exit`
 * is injectable for tests.
 */
export function handleBridgeServerError(
  error: NodeJS.ErrnoException,
  port: number,
  exit: (code: number) => void = process.exit,
): void {
  if (error.code === "EADDRINUSE") {
    logBridgeMessage(
      `Port ${port} is already in use (EADDRINUSE) - another bridge is listening there. ` +
        `Exporting FLUTTER_AXI_PORT globally forces every session onto one port; ` +
        `unset it so each session gets its own, or set it only per-session.`,
    );
    exit(BRIDGE_PORT_IN_USE_EXIT_CODE);
    return;
  }
  logBridgeMessage(`Bridge server error: ${getErrorMessage(error)}`);
  exit(1);
}

function writeReadySignal(): void {
  process.stdout.write("READY\n");
}

/** Resolve the dart executable used to spawn `dart mcp-server`. */
export function resolveDartBin(): string {
  const explicit = process.env.FLUTTER_AXI_DART_BIN?.trim();
  return explicit && explicit.length > 0 ? explicit : "dart";
}

/**
 * Resolve the command + args used to spawn the Dart MCP server transport.
 * `dart mcp-server` ships with the Dart SDK (>= 3.9), so there is no package
 * bootstrap step - startup is fast and deterministic. `FLUTTER_AXI_DART_BIN`
 * overrides which dart binary is used (e.g. a specific Flutter SDK's dart).
 */
export function resolveTransportSpec(): { command: string; args: string[] } {
  return { command: resolveDartBin(), args: ["mcp-server"] };
}

function createTransport(): StdioClientTransport {
  return new StdioClientTransport(resolveTransportSpec());
}

function createBridgeClient(): Client {
  return new Client({ name: "flutter-axi-bridge", version: "1.0.0" });
}

async function closeServer(server: Server): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => {
      if (error) {
        reject(error);
      } else {
        resolve();
      }
    });
  });
}

export async function runBridge(port = resolveSessionPort()): Promise<void> {
  // Connect the MCP transport (which spawns `dart mcp-server`) before binding
  // the port. A same-session bind race then self-heals: both racers finish
  // booting before listen(), so the loser's EADDRINUSE exit finds the winner
  // already deep-healthy and reuses it instead of failing.
  const transport = createTransport();
  const client = createBridgeClient();
  await client.connect(transport);
  logBridgeMessage("Connected to dart mcp-server");

  const sessionName = resolveSessionName();
  const server = createBridgeServer(client, sessionName);
  server.on("error", (error: NodeJS.ErrnoException) => {
    handleBridgeServerError(error, port);
  });
  server.listen(port, "127.0.0.1", () => {
    writePidFile(port);
    logBridgeMessage(`Listening on http://127.0.0.1:${port}`);
    writeReadySignal();
  });

  let shuttingDown = false;
  const shutdown = async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    removePidFile();
    await closeServer(server);
    await client.close();
    await transport.close();
    process.exit(0);
  };

  // Kill our entire process group on exit so dart mcp-server children (and
  // any `flutter run` processes they spawned) don't survive as orphans. The
  // bridge is spawned with detached:true, making it a process group leader —
  // all children share our PGID.
  process.on("exit", () => {
    removePidFile();
    try {
      process.kill(-process.pid, "SIGTERM");
    } catch {
      // Already dead or not a group leader
    }
  });

  process.on("SIGTERM", () => {
    void shutdown();
  });
  process.on("SIGINT", () => {
    void shutdown();
  });
}
