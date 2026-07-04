import { describe, expect, it } from "vitest";
import {
  checkUidGeneration,
  countRefs,
  parseStampedUid,
  stampSnapshotGeneration,
  truncateSnapshot,
  truncateText,
} from "../src/snapshot.js";

describe("parseStampedUid", () => {
  it("parses stamped refs with @ prefix", () => {
    expect(parseStampedUid("@g7:12")).toEqual({ uid: "12", generation: 7 });
  });

  it("parses unstamped refs", () => {
    expect(parseStampedUid("@12")).toEqual({ uid: "12", generation: null });
    expect(parseStampedUid("g3:abc")).toEqual({ uid: "abc", generation: 3 });
  });
});

describe("stampSnapshotGeneration", () => {
  it("stamps every uid and is idempotent", () => {
    const snap = "uid=12 Text \"0\"\n  uid=7 FloatingActionButton";
    const stamped = stampSnapshotGeneration(snap, 3);
    expect(stamped).toContain("uid=g3:12");
    expect(stamped).toContain("uid=g3:7");
    expect(stampSnapshotGeneration(stamped, 4)).toBe(stamped);
  });
});

describe("checkUidGeneration", () => {
  it("flags stale refs", () => {
    expect(checkUidGeneration("@g2:12", 5)).toEqual({
      uid: "12",
      stale: true,
      refGeneration: 2,
    });
  });

  it("accepts current and untagged refs", () => {
    expect(checkUidGeneration("@g5:12", 5).stale).toBe(false);
    expect(checkUidGeneration("@12", 5).stale).toBe(false);
  });
});

describe("countRefs", () => {
  it("counts uid tokens", () => {
    expect(countRefs('uid=g1:1 Text "a"\nuid=g1:2 Text "b"\nColumn')).toBe(2);
    expect(countRefs("Column")).toBe(0);
  });
});

describe("truncateSnapshot", () => {
  it("passes through under the limit and with --full", () => {
    expect(truncateSnapshot("short", false).truncated).toBe(false);
    const long = "x".repeat(20000);
    expect(truncateSnapshot(long, true).truncated).toBe(false);
  });

  it("cuts at a line boundary", () => {
    const long = Array.from({ length: 2000 }, (_, i) => `line ${i}`).join("\n");
    const tr = truncateSnapshot(long, false, 100);
    expect(tr.truncated).toBe(true);
    expect(tr.text.endsWith("\n")).toBe(false);
    expect(tr.text.length).toBeLessThanOrEqual(100);
  });
});

describe("truncateText", () => {
  it("keeps head and tail with an omission marker", () => {
    const text = Array.from({ length: 1000 }, (_, i) => `line ${i}`).join("\n");
    const tr = truncateText(text, 500);
    expect(tr.truncated).toBe(true);
    expect(tr.text).toContain("chars omitted");
    expect(tr.text).toContain("line 0");
    expect(tr.text).toContain("line 999");
  });
});
