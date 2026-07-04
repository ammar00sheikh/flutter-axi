import { describe, expect, it } from "vitest";
import { createAppsProxy } from "../src/run.js";

describe("createAppsProxy", () => {
  it("lazily creates and caches helpers per session name", () => {
    const apps = createAppsProxy();
    const user = apps.user;
    const driver = apps.driver;
    expect(user).toBeDefined();
    expect(driver).toBeDefined();
    expect(user).not.toBe(driver);
    expect(apps.user).toBe(user);
  });

  it("exposes the full helper API", () => {
    const helper = createAppsProxy().someapp;
    for (const method of [
      "launch",
      "stop",
      "snapshot",
      "tap",
      "fill",
      "type",
      "press",
      "scroll",
      "scrollInto",
      "back",
      "text",
      "waitFor",
      "wait",
      "reload",
      "restart",
      "logs",
      "errors",
      "screenshot",
      "gps",
      "permission",
      "deeplink",
      "push",
    ]) {
      expect(typeof (helper as Record<string, unknown>)[method]).toBe(
        "function",
      );
    }
  });
});
