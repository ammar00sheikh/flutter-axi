/**
 * Dart VM service client - the performance layer.
 *
 * The Dart MCP server exposes no performance tools, so flutter-axi talks to
 * the running app's VM service directly over its WebSocket JSON-RPC endpoint
 * (Node's global WebSocket; no dependency). The endpoint URI is discovered
 * from the app's own run logs - `flutter run` emits an `app.debugPort` event
 * with the authenticated `wsUri` - and cached in the session's app state.
 *
 * Everything an agent consumes is pre-aggregated here (frame stats with jank
 * counts and percentiles, top CPU functions, memory rollups) so one command
 * returns a decision-ready summary instead of raw event streams.
 */

import { callTool, FlutterAxiError } from "./client.js";
import { readAppState, writeAppState } from "./appstate.js";

const RPC_TIMEOUT_MS = 15_000;

interface PendingRpc {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
}

export interface VmEvent {
  kind?: string;
  extensionKind?: string;
  extensionData?: Record<string, unknown>;
  [key: string]: unknown;
}

export class VmClient {
  private ws: WebSocket;
  private nextId = 1;
  private pending = new Map<string, PendingRpc>();
  private eventListeners: ((streamId: string, event: VmEvent) => void)[] = [];

  private constructor(ws: WebSocket) {
    this.ws = ws;
    ws.addEventListener("message", (msg) => {
      let data: Record<string, unknown>;
      try {
        data = JSON.parse(String(msg.data));
      } catch {
        return;
      }
      if (data.id !== undefined) {
        const entry = this.pending.get(String(data.id));
        if (!entry) return;
        this.pending.delete(String(data.id));
        if (data.error) {
          const err = data.error as { message?: string; data?: { details?: string } };
          entry.reject(
            new Error(err.data?.details ?? err.message ?? "VM service error"),
          );
        } else {
          entry.resolve(data.result);
        }
      } else if (data.method === "streamNotify") {
        const params = data.params as { streamId?: string; event?: VmEvent };
        if (params?.streamId && params.event) {
          for (const listener of this.eventListeners) {
            listener(params.streamId, params.event);
          }
        }
      }
    });
  }

  static connect(uri: string): Promise<VmClient> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(uri);
      const timer = setTimeout(() => {
        try {
          ws.close();
        } catch {
          /* ignore */
        }
        reject(new Error(`Timed out connecting to VM service at ${uri}`));
      }, 10_000);
      ws.addEventListener("open", () => {
        clearTimeout(timer);
        resolve(new VmClient(ws));
      });
      ws.addEventListener("error", () => {
        clearTimeout(timer);
        reject(new Error(`Could not connect to VM service at ${uri}`));
      });
    });
  }

  rpc(method: string, params: Record<string, unknown> = {}): Promise<unknown> {
    const id = String(this.nextId++);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`VM service call ${method} timed out`));
      }, RPC_TIMEOUT_MS);
      this.pending.set(id, {
        resolve: (v) => {
          clearTimeout(timer);
          resolve(v);
        },
        reject: (e) => {
          clearTimeout(timer);
          reject(e);
        },
      });
      this.ws.send(JSON.stringify({ jsonrpc: "2.0", id, method, params }));
    });
  }

  onEvent(listener: (streamId: string, event: VmEvent) => void): void {
    this.eventListeners.push(listener);
  }

  async streamListen(streamId: string): Promise<void> {
    try {
      await this.rpc("streamListen", { streamId });
    } catch (error) {
      // Already subscribed (kStreamAlreadySubscribed) is fine.
      const message = error instanceof Error ? error.message : String(error);
      if (!/already subscribed/i.test(message)) throw error;
    }
  }

  close(): void {
    try {
      this.ws.close();
    } catch {
      /* ignore */
    }
  }

  /** Id of the main isolate (first isolate, preferring one named main). */
  async mainIsolateId(): Promise<string> {
    const vm = (await this.rpc("getVM")) as {
      isolates?: { id?: string; name?: string }[];
    };
    const isolates = vm.isolates ?? [];
    if (isolates.length === 0) {
      throw new Error("VM has no isolates");
    }
    const main = isolates.find((i) => i.name?.includes("main")) ?? isolates[0];
    return main.id ?? "";
  }
}

// --- VM service URI discovery ---

/** Parse the authenticated VM service wsUri from flutter run log lines. */
export function parseVmServiceUri(logs: string[]): string | null {
  for (const line of logs) {
    const m = line.match(/"wsUri":"(ws:[^"]+)"/);
    if (m) return m[1];
  }
  // Fallback: the human-readable observatory line.
  for (const line of logs) {
    const m = line.match(
      /VM Service .* is available at:? (http[^\s"]+)/i,
    );
    if (m) {
      return m[1].replace(/^http/, "ws").replace(/\/?$/, "/ws");
    }
  }
  return null;
}

/**
 * Resolve the session app's VM service URI: cached app state first, else
 * discovered from the app's run logs (and persisted for next time).
 */
export async function getVmServiceUri(session?: string): Promise<string> {
  const state = readAppState(session);
  if (!state || state.pid === null) {
    throw new FlutterAxiError("No app is attached to this session", "NO_APP", [
      "Run `flutter-axi launch <root> --device <id>` to start and attach an app",
    ]);
  }
  if (state.vmServiceUri) return state.vmServiceUri;

  const raw = await callTool(
    "get_app_logs",
    { pid: state.pid, maxLines: -1 },
    { session },
  );
  let logs: string[] = [raw];
  try {
    const parsed = JSON.parse(raw) as { logs?: unknown };
    if (Array.isArray(parsed.logs)) logs = parsed.logs.map(String);
  } catch {
    // keep raw
  }
  const uri = parseVmServiceUri(logs);
  if (!uri) {
    throw new FlutterAxiError(
      "Could not discover the app's VM service URI from its logs",
      "DRIVER_ERROR",
      [
        "Performance commands need an app launched by `flutter-axi launch` (debug mode)",
        "Run `flutter-axi logs --full` to inspect the run output",
      ],
    );
  }
  writeAppState({ ...state, vmServiceUri: uri }, session);
  return uri;
}

export async function connectVm(session?: string): Promise<VmClient> {
  const uri = await getVmServiceUri(session);
  try {
    return await VmClient.connect(uri);
  } catch (error) {
    throw new FlutterAxiError(
      error instanceof Error ? error.message : String(error),
      "DRIVER_ERROR",
      [
        "The app may have stopped - run `flutter-axi apps` to check",
        "Relaunch with `flutter-axi launch <root> --device <id>` and retry",
      ],
    );
  }
}

// --- Memory snapshot ---

export interface MemorySnapshot {
  isolates: {
    name: string;
    heapUsedBytes: number;
    heapCapacityBytes: number;
    externalBytes: number;
  }[];
  /** Total RSS of the app process when the VM reports it. */
  processRssBytes: number | null;
}

export async function collectMemory(client: VmClient): Promise<MemorySnapshot> {
  const vm = (await client.rpc("getVM")) as {
    isolates?: { id?: string; name?: string }[];
  };
  const isolates: MemorySnapshot["isolates"] = [];
  for (const iso of vm.isolates ?? []) {
    if (!iso.id) continue;
    try {
      const mem = (await client.rpc("getMemoryUsage", {
        isolateId: iso.id,
      })) as {
        heapUsage?: number;
        heapCapacity?: number;
        externalUsage?: number;
      };
      isolates.push({
        name: iso.name ?? iso.id,
        heapUsedBytes: mem.heapUsage ?? 0,
        heapCapacityBytes: mem.heapCapacity ?? 0,
        externalBytes: mem.externalUsage ?? 0,
      });
    } catch {
      // Isolate may have exited between getVM and getMemoryUsage.
    }
  }

  let processRssBytes: number | null = null;
  try {
    const proc = (await client.rpc("getProcessMemoryUsage")) as {
      root?: { size?: number };
    };
    processRssBytes = proc.root?.size ?? null;
  } catch {
    // Method unavailable on some embedders - memory rollup still useful.
  }

  return { isolates, processRssBytes };
}

export function formatBytes(bytes: number): string {
  if (bytes >= 1024 * 1024 * 1024) {
    return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)}GB`;
  }
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${bytes}B`;
}

// --- Frame timing ---

export interface FrameSample {
  /** Total frame time in ms. */
  elapsedMs: number;
  buildMs: number;
  rasterMs: number;
}

export interface FrameStats {
  frameCount: number;
  durationMs: number;
  /** Frames whose build or raster exceeded the budget. */
  jankCount: number;
  jankPct: number;
  budgetMs: number;
  avgBuildMs: number;
  p95BuildMs: number;
  maxBuildMs: number;
  avgRasterMs: number;
  p95RasterMs: number;
  maxRasterMs: number;
  /** Frames per second over the recording window. */
  fps: number;
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.min(
    sorted.length - 1,
    Math.ceil((p / 100) * sorted.length) - 1,
  );
  return sorted[Math.max(0, idx)];
}

const round1 = (n: number): number => Math.round(n * 10) / 10;

/** Aggregate raw Flutter.Frame samples into agent-ready stats. */
export function computeFrameStats(
  samples: FrameSample[],
  durationMs: number,
  budgetMs = 16.7,
): FrameStats {
  const builds = samples.map((s) => s.buildMs).sort((a, b) => a - b);
  const rasters = samples.map((s) => s.rasterMs).sort((a, b) => a - b);
  const jank = samples.filter(
    (s) => s.buildMs > budgetMs || s.rasterMs > budgetMs,
  );
  const mean = (arr: number[]) =>
    arr.length === 0 ? 0 : arr.reduce((a, b) => a + b, 0) / arr.length;

  return {
    frameCount: samples.length,
    durationMs,
    jankCount: jank.length,
    jankPct:
      samples.length === 0
        ? 0
        : Math.round((jank.length / samples.length) * 1000) / 10,
    budgetMs,
    avgBuildMs: round1(mean(builds)),
    p95BuildMs: round1(percentile(builds, 95)),
    maxBuildMs: round1(builds[builds.length - 1] ?? 0),
    avgRasterMs: round1(mean(rasters)),
    p95RasterMs: round1(percentile(rasters, 95)),
    maxRasterMs: round1(rasters[rasters.length - 1] ?? 0),
    fps:
      durationMs > 0
        ? Math.round((samples.length / durationMs) * 10000) / 10
        : 0,
  };
}

/** Parse a Flutter.Frame extension event into a sample. */
export function parseFrameEvent(event: VmEvent): FrameSample | null {
  if (event.extensionKind !== "Flutter.Frame") return null;
  const data = event.extensionData;
  if (!data) return null;
  const num = (v: unknown): number => (typeof v === "number" ? v : 0);
  // Values are microseconds.
  return {
    elapsedMs: num(data.elapsed) / 1000,
    buildMs: num(data.build) / 1000,
    rasterMs: num(data.raster) / 1000,
  };
}

/**
 * Record Flutter.Frame events for a window. `onWindow` runs during the
 * recording (used to generate load, e.g. repeated taps or scrolls); the
 * window always lasts at least `durationMs`.
 */
export async function recordFrames(
  client: VmClient,
  durationMs: number,
  onWindow?: () => Promise<void>,
): Promise<FrameSample[]> {
  const samples: FrameSample[] = [];
  client.onEvent((streamId, event) => {
    if (streamId !== "Extension") return;
    const sample = parseFrameEvent(event);
    if (sample) samples.push(sample);
  });
  await client.streamListen("Extension");

  const windowDone = new Promise<void>((r) => setTimeout(r, durationMs));
  if (onWindow) {
    await Promise.all([windowDone, onWindow()]);
  } else {
    await windowDone;
  }
  return samples;
}

// --- CPU profile ---

export interface CpuProfile {
  sampleCount: number;
  samplePeriodMicros: number;
  topFunctions: { name: string; exclusivePct: number; samples: number }[];
}

/**
 * Aggregate getCpuSamples into top functions by exclusive (leaf) samples.
 */
export function aggregateCpuSamples(result: {
  sampleCount?: number;
  samplePeriod?: number;
  functions?: { function?: { name?: string; owner?: { name?: string } } }[];
  samples?: { stack?: number[] }[];
}): CpuProfile {
  const counts = new Map<number, number>();
  const samples = result.samples ?? [];
  for (const sample of samples) {
    const leaf = sample.stack?.[0];
    if (leaf === undefined) continue;
    counts.set(leaf, (counts.get(leaf) ?? 0) + 1);
  }
  const functions = result.functions ?? [];
  const top = [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10)
    .map(([idx, count]) => {
      const fn = functions[idx]?.function;
      const owner = fn?.owner?.name;
      const name = fn?.name ?? `#${idx}`;
      return {
        name: owner ? `${owner}.${name}` : name,
        exclusivePct:
          samples.length === 0
            ? 0
            : Math.round((count / samples.length) * 1000) / 10,
        samples: count,
      };
    });
  return {
    sampleCount: result.sampleCount ?? samples.length,
    samplePeriodMicros: result.samplePeriod ?? 0,
    topFunctions: top,
  };
}

export async function collectCpuProfile(
  client: VmClient,
  durationMs: number,
): Promise<CpuProfile> {
  const isolateId = await client.mainIsolateId();
  const t0 = (await client.rpc("getVMTimelineMicros")) as {
    timestamp?: number;
  };
  const origin = t0.timestamp ?? 0;
  await new Promise((r) => setTimeout(r, durationMs));
  let result: Parameters<typeof aggregateCpuSamples>[0];
  try {
    result = (await client.rpc("getCpuSamples", {
      isolateId,
      timeOriginMicros: origin,
      timeExtentMicros: durationMs * 1000,
    })) as Parameters<typeof aggregateCpuSamples>[0];
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new FlutterAxiError(
      `CPU sampling unavailable: ${message}`,
      "DRIVER_ERROR",
      [
        "The VM profiler may be disabled for this run mode",
        "Frame timings still work: `flutter-axi perf frames --duration 5000`",
      ],
    );
  }
  return aggregateCpuSamples(result);
}

// --- Timeline trace ---

const TIMELINE_STREAMS = ["Dart", "Embedder", "GC"];

export async function startTimeline(client: VmClient): Promise<void> {
  await client.rpc("setVMTimelineFlags", { recordedStreams: TIMELINE_STREAMS });
  await client.rpc("clearVMTimeline");
}

export async function stopTimeline(
  client: VmClient,
): Promise<{ traceEvents: unknown[] }> {
  const timeline = (await client.rpc("getVMTimeline")) as {
    traceEvents?: unknown[];
  };
  await client.rpc("setVMTimelineFlags", { recordedStreams: [] });
  return { traceEvents: timeline.traceEvents ?? [] };
}
