/**
 * Shared app actions used by both the CLI command handlers (cli.ts) and the
 * multi-app script runner (run.ts). Every function takes an optional explicit
 * session name; when omitted the ambient FLUTTER_AXI_SESSION applies.
 */

import { callTool, FlutterAxiError } from "./client.js";
import { bumpGeneration, getCurrentGeneration } from "./generation.js";
import { checkUidGeneration } from "./snapshot.js";
import {
  lookupRef,
  parseFinderString,
  writeRefs,
  type Finder,
} from "./refs.js";
import {
  parseWidgetTree,
  renderWidgetTree,
  listRefs,
  type RefSummary,
} from "./widgettree.js";
import { readAppState, type AppState } from "./appstate.js";
import { stampSnapshotGeneration } from "./snapshot.js";

export interface SnapshotResult {
  /** Generation-stamped snapshot text. */
  text: string;
  refCount: number;
  title: string;
  refs: RefSummary[];
  generation: number;
}

/** Driver response envelope: {"isError":..., "response":...}. */
export function parseDriverResponse(output: string): unknown {
  try {
    const parsed = JSON.parse(output) as {
      isError?: unknown;
      response?: unknown;
    };
    if (parsed.isError === true) {
      const message =
        typeof parsed.response === "string"
          ? parsed.response.split("\n")[0]
          : JSON.stringify(parsed.response);
      throw new FlutterAxiError(message, "DRIVER_ERROR", [
        "Run `flutter-axi snapshot` to see current app state",
      ]);
    }
    return parsed.response;
  } catch (error) {
    if (error instanceof FlutterAxiError) throw error;
    // Not JSON - MCP-level error text or plain message; surface as-is.
    return output;
  }
}

/** Require a launched app for this session; loud NO_APP otherwise. */
export function requireAppState(session?: string): AppState {
  const state = readAppState(session);
  if (!state || state.pid === null) {
    throw new FlutterAxiError(
      "No app is attached to this session",
      "NO_APP",
      [
        "Run `flutter-axi launch <root> --device <id>` to start and attach an app",
        "Run `flutter-axi devices` to list available devices",
      ],
    );
  }
  return state;
}

/**
 * Capture a fresh widget-tree snapshot: fetch, parse, mint uids, persist the
 * uid->finder registry, bump the generation, and stamp the text.
 */
export async function takeSnapshot(
  opts: { deep?: boolean; session?: string } = {},
): Promise<SnapshotResult> {
  const raw = await callTool(
    "get_widget_tree",
    { summaryOnly: !opts.deep },
    { session: opts.session },
  );
  let root;
  try {
    root = parseWidgetTree(raw);
  } catch {
    throw new FlutterAxiError(
      `Could not parse widget tree: ${raw.slice(0, 200)}`,
      "DRIVER_ERROR",
      [
        "The app may still be starting - run `flutter-axi snapshot` again",
        "Run `flutter-axi errors` to check for runtime errors",
      ],
    );
  }
  const rendered = renderWidgetTree(root);
  const generation = bumpGeneration(opts.session);
  writeRefs(generation, rendered.refs, opts.session);
  return {
    text: stampSnapshotGeneration(rendered.text, generation),
    refCount: rendered.refCount,
    title: rendered.title,
    refs: listRefs(root),
    generation,
  };
}

/**
 * Resolve an action target: a `@uid` ref (validated against the current
 * generation and the refs registry) or a `kind:value` finder string.
 */
export function resolveFinderArg(arg: string, session?: string): Finder {
  const finderFromString = parseFinderString(arg);
  if (finderFromString) return finderFromString;

  const current = getCurrentGeneration(session);
  const check = checkUidGeneration(arg, current);
  if (check.stale) {
    const refRaw = arg.startsWith("@") ? arg.slice(1) : arg;
    throw new FlutterAxiError(
      `Stale ref @${refRaw}: from snapshot generation ${check.refGeneration}, current is ${current}. Re-snapshot to get fresh refs.`,
      "STALE_REF",
      [
        "Run `flutter-axi snapshot` to capture current refs, then retry the action",
      ],
    );
  }
  const finder = lookupRef(check.uid, session);
  if (!finder) {
    throw new FlutterAxiError(
      `Unknown ref @${check.uid} - not in the current snapshot`,
      "REF_NOT_FOUND",
      [
        "Run `flutter-axi snapshot` to see current widgets and their @uid refs",
        "Or target directly: `flutter-axi tap text:<visible text>` (also key:, type:, tooltip:, label:)",
      ],
    );
  }
  return finder;
}

/** Run a flutter_driver command through the bridge and parse the envelope. */
export async function driver(
  command: string,
  args: Record<string, unknown> = {},
  session?: string,
): Promise<unknown> {
  const output = await callTool(
    "flutter_driver",
    { command, ...args },
    { session },
  );
  return parseDriverResponse(output);
}

export async function tap(finder: Finder, session?: string): Promise<void> {
  await driver("tap", finder, session);
}

/**
 * Fill a text field: focus it with a tap, enable text-entry emulation (once
 * per process is fine - the driver keeps it on), then enter the text.
 */
export async function fill(
  finder: Finder,
  text: string,
  session?: string,
): Promise<void> {
  await driver("tap", finder, session);
  await driver("set_text_entry_emulation", { enabled: "true" }, session);
  await driver("enter_text", { text }, session);
}

export async function typeText(text: string, session?: string): Promise<void> {
  await driver("set_text_entry_emulation", { enabled: "true" }, session);
  await driver("enter_text", { text }, session);
}

export async function pressAction(
  action: string,
  session?: string,
): Promise<void> {
  await driver("send_text_input_action", { action }, session);
}

export interface ScrollOptions {
  dx?: number;
  dy?: number;
  durationMs?: number;
}

export async function scroll(
  finder: Finder,
  opts: ScrollOptions = {},
  session?: string,
): Promise<void> {
  const durationMs = opts.durationMs ?? 300;
  await driver(
    "scroll",
    {
      ...finder,
      dx: String(opts.dx ?? 0),
      dy: String(opts.dy ?? -300),
      // duration is in MICROSECONDS per the driver API.
      duration: String(durationMs * 1000),
      frequency: "60",
    },
    session,
  );
}

export async function scrollInto(
  finder: Finder,
  session?: string,
): Promise<void> {
  await driver("scrollIntoView", { ...finder, alignment: "0.0" }, session);
}

export async function goBack(session?: string): Promise<void> {
  await driver("tap", { finderType: "PageBack" }, session);
}

export async function waitFor(
  text: string,
  opts: { absent?: boolean; timeoutMs?: number } = {},
  session?: string,
): Promise<void> {
  const command = opts.absent ? "waitForAbsent" : "waitFor";
  await driver(
    command,
    {
      finderType: "ByText",
      text,
      timeout: String(opts.timeoutMs ?? 15_000),
    },
    session,
  );
}

export async function getText(
  finder: Finder,
  session?: string,
): Promise<string> {
  const response = (await driver("get_text", finder, session)) as {
    text?: unknown;
  };
  return typeof response?.text === "string" ? response.text : String(response);
}
