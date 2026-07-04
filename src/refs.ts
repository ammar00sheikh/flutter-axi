/**
 * uid -> finder registry.
 *
 * The Dart MCP server's flutter_driver tool addresses widgets with *finders*
 * (ByValueKey / ByText / ByType / ...), not uids. flutter-axi mints uids at
 * snapshot time and persists the finder each uid resolves to in refs.json in
 * the session state dir, so action commands in later short-lived CLI
 * processes can translate `@g3:12` back to a driver finder.
 *
 * The file is rewritten wholesale on every snapshot (same lifecycle as the
 * generation counter): refs are only valid for the generation they were
 * minted in.
 */

import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { resolveSessionStateDir } from "./sessions.js";

/**
 * A flutter_driver finder, in the exact JSON shape the Dart MCP server's
 * flutter_driver tool accepts (spread into the command args).
 */
export type Finder = Record<string, unknown> & { finderType: string };

export interface RefsFile {
  generation: number;
  refs: Record<string, Finder>;
}

function refsFile(session?: string): string {
  return join(resolveSessionStateDir(session), "refs.json");
}

export function readRefs(session?: string): RefsFile | null {
  const file = refsFile(session);
  try {
    if (!existsSync(file)) return null;
    const data = JSON.parse(readFileSync(file, "utf-8"));
    if (
      data === null ||
      typeof data !== "object" ||
      typeof data.generation !== "number" ||
      data.refs === null ||
      typeof data.refs !== "object"
    ) {
      return null;
    }
    return data as RefsFile;
  } catch {
    return null;
  }
}

export function writeRefs(
  generation: number,
  refs: Record<string, Finder>,
  session?: string,
): void {
  const file = refsFile(session);
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, JSON.stringify({ generation, refs }));
  // rename is atomic on POSIX - concurrent readers never see a torn write.
  renameSync(tmp, file);
}

/** Look up the finder for a uid; null when unknown. */
export function lookupRef(uid: string, session?: string): Finder | null {
  const data = readRefs(session);
  if (!data) return null;
  return data.refs[uid] ?? null;
}

// --- Direct finder escape hatch ---

/**
 * Parse a `kind:value` finder string (the escape hatch that bypasses uids):
 *   text:Accept          -> ByText
 *   key:submit_button    -> ByValueKey
 *   type:ElevatedButton  -> ByType
 *   tooltip:Increment    -> ByTooltipMessage
 *   label:Sign in        -> BySemanticsLabel
 * Returns null when the string is not a finder expression.
 */
export function parseFinderString(arg: string): Finder | null {
  const m = arg.match(/^(text|key|type|tooltip|label):(.+)$/s);
  if (!m) return null;
  const value = m[2];
  switch (m[1]) {
    case "text":
      return { finderType: "ByText", text: value };
    case "key":
      return {
        finderType: "ByValueKey",
        keyValueString: value,
        keyValueType: "String",
      };
    case "type":
      return { finderType: "ByType", type: value };
    case "tooltip":
      return { finderType: "ByTooltipMessage", text: value };
    case "label":
      return { finderType: "BySemanticsLabel", label: value };
    default:
      return null;
  }
}

/** Human-readable one-liner for a finder (used in errors/suggestions). */
export function describeFinder(finder: Finder): string {
  switch (finder.finderType) {
    case "ByText":
      return `text "${finder.text}"`;
    case "ByValueKey":
      return `key ${finder.keyValueString}`;
    case "ByType":
      return `type ${finder.type}`;
    case "ByTooltipMessage":
      return `tooltip "${finder.text}"`;
    case "BySemanticsLabel":
      return `label "${finder.label}"`;
    case "PageBack":
      return "page back button";
    case "Descendant": {
      const of = finder.of as Finder | undefined;
      const matching = finder.matching as Finder | undefined;
      return `${matching ? describeFinder(matching) : "widget"} under ${of ? describeFinder(of) : "ancestor"}`;
    }
    default:
      return finder.finderType;
  }
}
