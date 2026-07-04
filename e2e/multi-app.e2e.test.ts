/**
 * Live multi-app E2E: two sessions on two booted simulators, driven both by
 * per-command --app selectors and by one `run` script with apps.<name>
 * handles. Skips unless two simulators are booted.
 */

import { describe, expect, it, afterAll } from "vitest";
import {
  FIXTURE_ROOT,
  bootedSimulators,
  cli,
  fixtureReady,
} from "./helpers.js";

const sims = bootedSimulators();
const enabled = sims.length >= 2 && fixtureReady();

describe.runIf(enabled).sequential("multi-app e2e (two simulators)", () => {
  afterAll(async () => {
    await cli(["stop"], { session: "e2e-a" });
    await cli(["stop"], { session: "e2e-b" });
  }, 120_000);

  it("orchestrates two apps from one run script", async () => {
    const r = await cli(["run"], {
      session: "e2e-a",
      timeoutMs: 900_000,
      stdin: `
        const a = apps["e2e-a"], b = apps["e2e-b"];
        await a.launch(${JSON.stringify(FIXTURE_ROOT)}, { device: ${JSON.stringify(sims[0])} });
        await b.launch(${JSON.stringify(FIXTURE_ROOT)}, { device: ${JSON.stringify(sims[1])} });
        await a.tap("tooltip:Increment");
        await b.tap("tooltip:Increment");
        await b.tap("tooltip:Increment");
        await a.wait(400);
        const countA = (await a.snapshot()).match(/Text "(\\d+)"/)[1];
        const countB = (await b.snapshot()).match(/Text "(\\d+)"/)[1];
        console.log("a=" + countA, "b=" + countB);
      `,
    });
    expect(r.code, r.stdout + r.stderr).toBe(0);
    expect(r.stdout.trim()).toBe("a=1 b=2");
  });

  it("targets each session with --app on plain commands", async () => {
    const a = await cli(["--app", "e2e-a", "snapshot"], {});
    const b = await cli(["--app", "e2e-b", "snapshot"], {});
    expect(a.stdout).toContain('Text "1"');
    expect(b.stdout).toContain('Text "2"');
  });
});

describe.runIf(!enabled)("multi-app e2e (skipped)", () => {
  it.skip("requires two booted simulators and the counter fixture", () => {});
});
