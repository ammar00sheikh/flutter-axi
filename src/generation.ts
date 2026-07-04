/**
 * Snapshot generation persistence. The counter survives across CLI
 * invocations (which are short-lived processes sharing one bridge) by
 * writing to a file in the session state dir. Each new snapshot bumps the
 * counter, so refs minted in older snapshots can be detected as stale.
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

/** Path to a session's snapshot-generation counter file. */
function genFile(session?: string): string {
  return join(resolveSessionStateDir(session), "snapshot-generation");
}

export function getCurrentGeneration(session?: string): number {
  const file = genFile(session);
  try {
    if (!existsSync(file)) return 0;
    const parsed = Number.parseInt(readFileSync(file, "utf-8").trim(), 10);
    return Number.isNaN(parsed) ? 0 : parsed;
  } catch {
    return 0;
  }
}

export function bumpGeneration(session?: string): number {
  const next = getCurrentGeneration(session) + 1;
  const file = genFile(session);
  try {
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, String(next));
  } catch {
    // Best-effort: a write failure still returns the bumped value so the
    // current invocation behaves consistently. The next process will
    // re-read the on-disk value (potentially the prior one) and the
    // worst case is one missed stale-ref detection, not a hang.
  }
  return next;
}

export function resetGeneration(session?: string): void {
  const file = genFile(session);
  try {
    if (existsSync(file)) unlinkSync(file);
  } catch {
    // ignore
  }
}
