/**
 * Live native-layer E2E on the iOS simulator: gps, permissions, deeplink,
 * push, OS screenshot, app lifecycle. Uses its own session and app launch so
 * it can run independently of the single-app suite.
 */

import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { existsSync, mkdtempSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  FIXTURE_ROOT,
  bootedSimulators,
  cli,
  fixtureReady,
} from "./helpers.js";

const sims = bootedSimulators();
const enabled = sims.length >= 1 && fixtureReady();
const device = sims[0];
const SESSION = "e2e-native";

describe.runIf(enabled).sequential("native layer e2e (live simulator)", () => {
  beforeAll(async () => {
    const r = await cli(["launch", FIXTURE_ROOT, "--device", device], {
      session: SESSION,
      timeoutMs: 600_000,
    });
    expect(r.code).toBe(0);
  }, 600_000);

  afterAll(async () => {
    await cli(["stop"], { session: SESSION });
  }, 120_000);

  it("sets a mock GPS location", async () => {
    const r = await cli(["gps", "33.5138", "36.2765"], { session: SESSION });
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("lat: 33.5138");
  });

  it("grants and revokes permissions idempotently", async () => {
    const grant = await cli(["permission", "grant", "location"], {
      session: SESSION,
    });
    expect(grant.code).toBe(0);
    const again = await cli(["permission", "grant", "location"], {
      session: SESSION,
    });
    expect(again.code).toBe(0);
    const revoke = await cli(["permission", "revoke", "location"], {
      session: SESSION,
    });
    expect(revoke.code).toBe(0);
  });

  it("opens a deep link", async () => {
    const r = await cli(["deeplink", "https://example.com"], {
      session: SESSION,
    });
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("deeplink: opened");
  });

  it("delivers a push notification", async () => {
    const r = await cli(
      ["push", "--title", "E2E", "--body", "flutter-axi test"],
      { session: SESSION },
    );
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("push: delivered");
  });

  it("captures an OS-level screenshot", async () => {
    const dir = mkdtempSync(join(tmpdir(), "flutter-axi-e2e-"));
    const path = join(dir, "os.png");
    const r = await cli(["screenshot", path, "--os"], { session: SESSION });
    expect(r.code).toBe(0);
    expect(existsSync(path)).toBe(true);
    expect(statSync(path).size).toBeGreaterThan(1000);
  });

  it("cycles the app through background/foreground/force-stop", async () => {
    for (const action of ["background", "foreground", "force-stop"]) {
      const r = await cli(["applifecycle", action], { session: SESSION });
      expect(r.code, `${action}: ${r.stdout}`).toBe(0);
      expect(r.stdout).toContain("status: ok");
    }
  });
});

describe.runIf(!enabled)("native layer e2e (skipped)", () => {
  it.skip("requires a booted simulator and the counter fixture", () => {});
});
