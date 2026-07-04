/**
 * Live single-app E2E: the full launch -> snapshot -> interact -> native ->
 * teardown loop against the counter fixture on a booted iOS simulator.
 * Skips when no simulator is booted or the fixture is missing.
 */

import { describe, expect, it, afterAll } from "vitest";
import { existsSync, mkdtempSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  FIXTURE_ROOT,
  bootedSimulators,
  cli,
  counterValue,
  findUid,
  fixtureReady,
} from "./helpers.js";

const sims = bootedSimulators();
const enabled = sims.length >= 1 && fixtureReady();
const device = sims[0];
const SESSION = "e2e";

describe.runIf(enabled).sequential("single-app e2e (live simulator)", () => {
  afterAll(async () => {
    await cli(["stop"], { session: SESSION });
  }, 120_000);

  let snapshotText = "";

  it("starts the bridge", async () => {
    const r = await cli(["start"], { session: SESSION });
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("status: ready");
  });

  it("lists the booted device", async () => {
    const r = await cli(["devices"], { session: SESSION });
    expect(r.code).toBe(0);
    expect(r.stdout).toContain(device);
  });

  it("launches the counter app with driver enabled", async () => {
    const r = await cli(["launch", FIXTURE_ROOT, "--device", device], {
      session: SESSION,
      timeoutMs: 600_000,
    });
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("driver: enabled");
    expect(r.stdout).toContain("uid=");
  });

  it("snapshots the widget tree with refs", async () => {
    const r = await cli(["snapshot"], { session: SESSION });
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("FloatingActionButton");
    expect(counterValue(r.stdout)).toBe("0");
    snapshotText = r.stdout;
  });

  it("taps by stamped uid and sees the counter change", async () => {
    const fab = findUid(snapshotText, "FloatingActionButton");
    expect(fab).toBeTruthy();
    const r = await cli(["tap", `@${fab}`], { session: SESSION });
    expect(r.code).toBe(0);
    expect(counterValue(r.stdout)).toBe("1");
  });

  it("taps by finder string", async () => {
    const r = await cli(["tap", "tooltip:Increment"], { session: SESSION });
    expect(r.code).toBe(0);
    expect(counterValue(r.stdout)).toBe("2");
  });

  it("reads text through the driver", async () => {
    const r = await cli(["text", "text:2"], { session: SESSION });
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('text: "2"');
  });

  it("rejects stale refs loudly", async () => {
    const fab = findUid(snapshotText, "FloatingActionButton");
    const r = await cli(["tap", `@${fab}`], { session: SESSION });
    expect(r.code).toBe(1);
    expect(r.stdout).toContain("STALE_REF");
    expect(r.stdout).toContain("snapshot");
  });

  it("waits for visible text", async () => {
    const r = await cli(["waitfor", "2", "--timeout", "5000"], {
      session: SESSION,
    });
    expect(r.code).toBe(0);
  });

  it("reports no runtime errors definitively", async () => {
    const r = await cli(["errors"], { session: SESSION });
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("errors: none");
  });

  it("shows app logs", async () => {
    const r = await cli(["logs", "--lines", "50"], { session: SESSION });
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("logs:");
    expect(r.stdout).toContain("app.start");
  });

  it("hot restart resets state", async () => {
    const r = await cli(["restart"], { session: SESSION, timeoutMs: 120_000 });
    expect(r.code).toBe(0);
    expect(counterValue(r.stdout)).toBe("0");
  });

  it("reports a perf memory snapshot", async () => {
    const r = await cli(["perf"], { session: SESSION });
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("heapUsed:");
    expect(r.stdout).toContain("isolates");
  });

  it("records frame stats under tap load", async () => {
    const r = await cli(
      ["perf", "frames", "--duration", "3000", "--tap", "tooltip:Increment"],
      { session: SESSION },
    );
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("fps:");
    expect(r.stdout).toContain("jank:");
    const count = Number(r.stdout.match(/count: (\d+)/)?.[1] ?? 0);
    expect(count).toBeGreaterThan(10);
  });

  it("captures a VM timeline trace to a file", async () => {
    const start = await cli(["perf", "trace", "start"], { session: SESSION });
    expect(start.code).toBe(0);
    await cli(["tap", "tooltip:Increment"], { session: SESSION });
    const dir = mkdtempSync(join(tmpdir(), "flutter-axi-e2e-"));
    const path = join(dir, "trace.json");
    const stop = await cli(["perf", "trace", "stop", "--file", path], {
      session: SESSION,
    });
    expect(stop.code).toBe(0);
    expect(existsSync(path)).toBe(true);
    const trace = JSON.parse(readFileSync(path, "utf-8")) as {
      traceEvents: unknown[];
    };
    expect(trace.traceEvents.length).toBeGreaterThan(100);
  });

  it("saves a driver screenshot", async () => {
    const dir = mkdtempSync(join(tmpdir(), "flutter-axi-e2e-"));
    const path = join(dir, "driver.png");
    const r = await cli(["screenshot", path], { session: SESSION });
    expect(r.code).toBe(0);
    expect(existsSync(path)).toBe(true);
    expect(statSync(path).size).toBeGreaterThan(1000);
  });

  it("runs a script with the app helper", async () => {
    // State-independent: earlier tests (frame-load taps) move the counter,
    // so assert the delta rather than an absolute value.
    const r = await cli(["run"], {
      session: SESSION,
      stdin: `
        const read = async () => Number((await app.snapshot()).match(/Text "(\\d+)"/)[1]);
        const before = await read();
        await app.tap("tooltip:Increment");
        await app.wait(400);
        const after = await read();
        console.log("delta:", after - before);
      `,
    });
    expect(r.code).toBe(0);
    expect(r.stdout.trim()).toBe("delta: 1");
  });

  it("stops the app idempotently", async () => {
    const first = await cli(["stopapp"], { session: SESSION });
    expect(first.code).toBe(0);
    expect(first.stdout).toContain("stopped");
    const second = await cli(["stopapp"], { session: SESSION });
    expect(second.code).toBe(0);
    expect(second.stdout).toContain("no-op");
  });
});

describe.runIf(!enabled)("single-app e2e (skipped)", () => {
  it.skip("requires a booted simulator and the counter fixture", () => {});
});
