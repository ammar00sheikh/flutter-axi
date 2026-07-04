import { describe, expect, it } from "vitest";
import {
  aggregateCpuSamples,
  computeFrameStats,
  formatBytes,
  parseFrameEvent,
  parseVmServiceUri,
} from "../src/vmservice.js";

describe("parseVmServiceUri (captured log format)", () => {
  it("extracts the authenticated wsUri from the app.debugPort event", () => {
    const logs = [
      '[stdout] [{"event":"app.start","params":{"appId":"x"}}]',
      '[stdout] [{"event":"app.debugPort","params":{"appId":"x","port":58211,"wsUri":"ws://127.0.0.1:58211/fQNGSvlgPvM=/ws","baseUri":"file:///..."}}]',
    ];
    expect(parseVmServiceUri(logs)).toBe("ws://127.0.0.1:58211/fQNGSvlgPvM=/ws");
  });

  it("falls back to the human-readable VM Service line", () => {
    const logs = [
      "[stdout] A Dart VM Service on iPhone SE is available at: http://127.0.0.1:58211/abc=/",
    ];
    expect(parseVmServiceUri(logs)).toBe("ws://127.0.0.1:58211/abc=/ws");
  });

  it("returns null when nothing matches", () => {
    expect(parseVmServiceUri(["no uris here"])).toBeNull();
  });
});

describe("parseFrameEvent", () => {
  it("converts Flutter.Frame microseconds to ms", () => {
    const sample = parseFrameEvent({
      extensionKind: "Flutter.Frame",
      extensionData: { number: 3, elapsed: 21000, build: 8000, raster: 12000 },
    });
    expect(sample).toEqual({ elapsedMs: 21, buildMs: 8, rasterMs: 12 });
  });

  it("ignores other extension events", () => {
    expect(
      parseFrameEvent({ extensionKind: "Flutter.NavigationEvent" }),
    ).toBeNull();
  });
});

describe("computeFrameStats", () => {
  const frame = (buildMs: number, rasterMs: number) => ({
    elapsedMs: buildMs + rasterMs,
    buildMs,
    rasterMs,
  });

  it("aggregates jank, percentiles, and fps", () => {
    const samples = [
      frame(5, 6),
      frame(8, 7),
      frame(30, 10), // jank: build over budget
      frame(6, 25), // jank: raster over budget
    ];
    const stats = computeFrameStats(samples, 2000, 16.7);
    expect(stats.frameCount).toBe(4);
    expect(stats.jankCount).toBe(2);
    expect(stats.jankPct).toBe(50);
    expect(stats.maxBuildMs).toBe(30);
    expect(stats.maxRasterMs).toBe(25);
    expect(stats.fps).toBe(2);
    expect(stats.budgetMs).toBe(16.7);
  });

  it("handles the empty window", () => {
    const stats = computeFrameStats([], 5000);
    expect(stats.frameCount).toBe(0);
    expect(stats.jankPct).toBe(0);
    expect(stats.fps).toBe(0);
  });

  it("respects a custom budget (120Hz)", () => {
    const stats = computeFrameStats([frame(10, 5)], 1000, 8.3);
    expect(stats.jankCount).toBe(1);
  });
});

describe("aggregateCpuSamples", () => {
  it("ranks functions by exclusive (leaf) samples", () => {
    const profile = aggregateCpuSamples({
      sampleCount: 4,
      samplePeriod: 250,
      functions: [
        { function: { name: "build", owner: { name: "MyWidget" } } },
        { function: { name: "paint" } },
      ],
      samples: [
        { stack: [0, 1] },
        { stack: [0] },
        { stack: [1, 0] },
        { stack: [0, 1] },
      ],
    });
    expect(profile.sampleCount).toBe(4);
    expect(profile.topFunctions[0]).toEqual({
      name: "MyWidget.build",
      exclusivePct: 75,
      samples: 3,
    });
    expect(profile.topFunctions[1].name).toBe("paint");
  });

  it("handles empty sample sets", () => {
    const profile = aggregateCpuSamples({});
    expect(profile.sampleCount).toBe(0);
    expect(profile.topFunctions).toEqual([]);
  });
});

describe("formatBytes", () => {
  it("humanizes sizes", () => {
    expect(formatBytes(512)).toBe("512B");
    expect(formatBytes(2048)).toBe("2.0KB");
    expect(formatBytes(5 * 1024 * 1024)).toBe("5.0MB");
    expect(formatBytes(3 * 1024 * 1024 * 1024)).toBe("3.00GB");
  });
});
