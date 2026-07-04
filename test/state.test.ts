/**
 * Generation counter, refs registry, and app state persistence - exercised
 * against a temp HOME so nothing touches the real ~/.flutter-axi.
 */
import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  bumpGeneration,
  getCurrentGeneration,
  resetGeneration,
} from "../src/generation.js";
import {
  lookupRef,
  parseFinderString,
  readRefs,
  writeRefs,
  describeFinder,
} from "../src/refs.js";
import {
  clearAppState,
  platformForDeviceId,
  readAppState,
  writeAppState,
} from "../src/appstate.js";

let tmpHome: string;
let savedHome: string | undefined;

beforeEach(() => {
  savedHome = process.env.HOME;
  tmpHome = mkdtempSync(join(tmpdir(), "flutter-axi-test-"));
  process.env.HOME = tmpHome;
});

afterEach(() => {
  if (savedHome === undefined) delete process.env.HOME;
  else process.env.HOME = savedHome;
  rmSync(tmpHome, { recursive: true, force: true });
});

describe("generation counter", () => {
  it("starts at 0 and increments across calls", () => {
    expect(getCurrentGeneration()).toBe(0);
    expect(bumpGeneration()).toBe(1);
    expect(bumpGeneration()).toBe(2);
    expect(getCurrentGeneration()).toBe(2);
  });

  it("is isolated per session", () => {
    bumpGeneration("a");
    bumpGeneration("a");
    expect(getCurrentGeneration("a")).toBe(2);
    expect(getCurrentGeneration("b")).toBe(0);
  });

  it("resets", () => {
    bumpGeneration();
    resetGeneration();
    expect(getCurrentGeneration()).toBe(0);
  });
});

describe("refs registry", () => {
  it("round-trips finders and reads back by uid", () => {
    writeRefs(3, {
      "12": { finderType: "ByText", text: "0" },
      "7": { finderType: "ByType", type: "FloatingActionButton" },
    });
    expect(readRefs()?.generation).toBe(3);
    expect(lookupRef("12")).toEqual({ finderType: "ByText", text: "0" });
    expect(lookupRef("nope")).toBeNull();
  });

  it("is isolated per session", () => {
    writeRefs(1, { a: { finderType: "ByText", text: "x" } }, "user");
    expect(lookupRef("a", "driver")).toBeNull();
    expect(lookupRef("a", "user")).not.toBeNull();
  });

  it("returns null for missing/corrupt files", () => {
    expect(readRefs()).toBeNull();
  });
});

describe("parseFinderString", () => {
  it("parses each finder kind", () => {
    expect(parseFinderString("text:Accept")).toEqual({
      finderType: "ByText",
      text: "Accept",
    });
    expect(parseFinderString("key:submit")).toEqual({
      finderType: "ByValueKey",
      keyValueString: "submit",
      keyValueType: "String",
    });
    expect(parseFinderString("type:ListView")).toEqual({
      finderType: "ByType",
      type: "ListView",
    });
    expect(parseFinderString("tooltip:Increment")).toEqual({
      finderType: "ByTooltipMessage",
      text: "Increment",
    });
    expect(parseFinderString("label:Sign in")).toEqual({
      finderType: "BySemanticsLabel",
      label: "Sign in",
    });
  });

  it("keeps colons in the value", () => {
    expect(parseFinderString("text:a:b")).toEqual({
      finderType: "ByText",
      text: "a:b",
    });
  });

  it("returns null for uids and plain strings", () => {
    expect(parseFinderString("@g3:12")).toBeNull();
    expect(parseFinderString("hello")).toBeNull();
  });

  it("describes finders", () => {
    expect(describeFinder({ finderType: "ByText", text: "Go" })).toBe(
      'text "Go"',
    );
  });
});

describe("app state", () => {
  it("round-trips and clears", () => {
    writeAppState({
      pid: 42,
      dtdUri: "ws://x",
      deviceId: "emulator-5554",
      platform: "android",
      appId: "com.example.app",
      projectRoot: "/tmp/app",
      launchedAt: "2026-07-04T00:00:00Z",
    });
    expect(readAppState()?.pid).toBe(42);
    clearAppState();
    expect(readAppState()).toBeNull();
  });

  it("is isolated per session", () => {
    writeAppState(
      {
        pid: 1,
        dtdUri: null,
        deviceId: null,
        platform: "unknown",
        appId: null,
        projectRoot: null,
        launchedAt: null,
      },
      "user",
    );
    expect(readAppState("driver")).toBeNull();
    expect(readAppState("user")?.pid).toBe(1);
  });
});

describe("platformForDeviceId", () => {
  it("classifies device ids", () => {
    expect(platformForDeviceId("emulator-5554")).toBe("android");
    expect(platformForDeviceId("00920CD6-2DFD-4A6F-9339-709459BBEE60")).toBe(
      "ios",
    );
    expect(platformForDeviceId("R58M12ABCDE")).toBe("android");
  });
});
