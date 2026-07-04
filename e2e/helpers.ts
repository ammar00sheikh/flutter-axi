/**
 * E2E helpers: run the real CLI binary (dev entrypoint via tsx) against a
 * live simulator/emulator. Suites are gated - they skip when no device is
 * booted - so `pnpm test` stays device-free while `pnpm test:e2e` proves the
 * whole stack.
 */

import { execFileSync, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";

export const PROJECT_ROOT = join(import.meta.dirname, "..");
export const FIXTURE_ROOT = join(
  PROJECT_ROOT,
  "bench",
  "fixtures",
  "counter_app",
);

export interface CliResult {
  stdout: string;
  stderr: string;
  code: number;
}

/** Run the CLI with an isolated session; never throws on non-zero exit. */
export function cli(
  args: string[],
  opts: { session?: string; stdin?: string; timeoutMs?: number } = {},
): Promise<CliResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      "npx",
      ["tsx", join(PROJECT_ROOT, "bin", "flutter-axi.ts"), ...args],
      {
        cwd: PROJECT_ROOT,
        env: {
          ...process.env,
          FLUTTER_AXI_SESSION: opts.session ?? "e2e",
        },
        timeout: opts.timeoutMs ?? 300_000,
      },
    );
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    child.on("error", reject);
    child.on("close", (code) => {
      resolve({ stdout, stderr, code: code ?? -1 });
    });
    if (opts.stdin !== undefined) {
      child.stdin.write(opts.stdin);
    }
    child.stdin.end();
  });
}

/** Booted iOS simulator UDIDs (Android emulators could be added similarly). */
export function bootedSimulators(): string[] {
  try {
    const out = execFileSync(
      "xcrun",
      ["simctl", "list", "devices", "booted"],
      { encoding: "utf-8", timeout: 15_000 },
    );
    return [...out.matchAll(/\(([0-9A-F-]{36})\)\s+\(Booted\)/g)].map(
      (m) => m[1],
    );
  } catch {
    return [];
  }
}

export function fixtureReady(): boolean {
  return existsSync(join(FIXTURE_ROOT, "lib", "flutter_axi_main.dart"));
}

/** Pull the first stamped uid for a widget type/text out of snapshot text. */
export function findUid(snapshot: string, needle: string): string | null {
  for (const line of snapshot.split("\n")) {
    if (line.includes(needle)) {
      const m = line.match(/uid=(g\d+:\d+)/);
      if (m) return m[1];
    }
  }
  return null;
}

/** Read the counter value from a counter-app snapshot. */
export function counterValue(snapshot: string): string | null {
  const m = snapshot.match(/Text "(\d+)"/);
  return m ? m[1] : null;
}
