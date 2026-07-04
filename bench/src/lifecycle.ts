/**
 * Daemon + fixture lifecycle for benchmark conditions.
 *
 * - flutter-axi: explicit `flutter-axi start` / `flutter-axi stop` per run
 *   session (fresh bridge = fresh app state, equalizing with MCP conditions
 *   whose server is respawned by Claude per run).
 * - dart-mcp: no daemon — the MCP server is spawned by the Claude process.
 *
 * The counter fixture must exist and be driver-ready before any run; the
 * first launch also compiles it, so `prewarmFixture` builds once up front to
 * keep cold-compile time out of the benchmark timings.
 */

import { execFileSync, execSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import type { ConditionDef } from "./types.js";
import { FIXTURE_ROOT } from "./runner.js";

const BENCH_ROOT = resolve(import.meta.dirname, "..");

export function assertFixtureReady(): void {
  if (!existsSync(join(FIXTURE_ROOT, "pubspec.yaml"))) {
    throw new Error(
      `Counter fixture missing at ${FIXTURE_ROOT} - run bench/scripts/setup-fixture.sh first`,
    );
  }
  if (!existsSync(join(FIXTURE_ROOT, "lib", "flutter_axi_main.dart"))) {
    throw new Error(
      `Fixture is not driver-ready - run bench/scripts/setup-fixture.sh (it runs 'flutter-axi setup driver')`,
    );
  }
}

/** First booted device id (iOS simulator or Android emulator). */
export function detectDevice(): string {
  try {
    const out = execFileSync("xcrun", ["simctl", "list", "devices", "booted"], {
      encoding: "utf-8",
      timeout: 15_000,
    });
    const m = out.match(/\(([0-9A-F-]{36})\)\s+\(Booted\)/);
    if (m) return m[1];
  } catch {
    // fall through to adb
  }
  try {
    const out = execFileSync("adb", ["devices"], {
      encoding: "utf-8",
      timeout: 15_000,
    });
    const m = out.match(/^(emulator-\d+)\s+device$/m);
    if (m) return m[1];
  } catch {
    // fall through
  }
  throw new Error(
    "No booted device found - boot an iOS simulator (open -a Simulator) or an Android emulator",
  );
}

/**
 * Build the fixture once before the matrix so no run pays the cold Xcode /
 * Gradle compile. Uses a throwaway flutter-axi session.
 */
export function prewarmFixture(deviceId: string): void {
  console.log("  [lifecycle] Pre-warming fixture build (first compile can take minutes)...");
  const env = { ...process.env, FLUTTER_AXI_SESSION: "bench-prewarm" };
  try {
    execSync(
      `npx tsx ${join(BENCH_ROOT, "..", "bin", "flutter-axi.ts")} launch ${FIXTURE_ROOT} --device ${deviceId}`,
      { encoding: "utf-8", timeout: 15 * 60 * 1000, stdio: "pipe", env },
    );
  } finally {
    try {
      execSync(
        `npx tsx ${join(BENCH_ROOT, "..", "bin", "flutter-axi.ts")} stop`,
        { encoding: "utf-8", timeout: 60_000, stdio: "pipe", env },
      );
    } catch {
      // best effort
    }
  }
  console.log("  [lifecycle] Fixture build warm");
}

export function startDaemon(condition: ConditionDef): void {
  if (condition.daemon === "explicit" && condition.daemon_start) {
    console.log(`  [lifecycle] Starting daemon: ${condition.daemon_start}`);
    try {
      execSync(condition.daemon_start, {
        encoding: "utf-8",
        timeout: 60_000,
        stdio: "pipe",
      });
    } catch (err: unknown) {
      const execErr = err as { stderr?: string };
      console.log(`  [lifecycle] Daemon start note: ${execErr.stderr ?? "already running?"}`);
    }
  }
}

export function stopDaemon(condition: ConditionDef): void {
  if (condition.daemon === "explicit" && condition.daemon_stop) {
    console.log(`  [lifecycle] Stopping daemon: ${condition.daemon_stop}`);
    try {
      execSync(condition.daemon_stop, {
        encoding: "utf-8",
        timeout: 30_000,
        stdio: "pipe",
      });
    } catch {
      console.log(`  [lifecycle] Daemon stop failed (may already be stopped)`);
    }
  }
}
