import { describe, expect, it } from "vitest";
import { getSuggestions, isButtonType, isInputType } from "../src/suggestions.js";

describe("type classification", () => {
  it("classifies buttons and inputs", () => {
    expect(isButtonType("FloatingActionButton")).toBe(true);
    expect(isButtonType("Text")).toBe(false);
    expect(isInputType("TextField")).toBe(true);
    expect(isInputType("Column")).toBe(false);
  });
});

describe("getSuggestions", () => {
  it("suggests submitting after fill", () => {
    const lines = getSuggestions({ command: "fill", refs: [] });
    expect(lines.join(" ")).toContain("press done");
  });

  it("suggests filling visible inputs", () => {
    const lines = getSuggestions({
      command: "snapshot",
      refs: [{ uid: "3", type: "TextField", text: "Email" }],
    });
    expect(lines.join(" ")).toContain("fill @3");
  });

  it("suggests tapping visible buttons", () => {
    const lines = getSuggestions({
      command: "snapshot",
      refs: [{ uid: "7", type: "FloatingActionButton", text: null }],
    });
    expect(lines.join(" ")).toContain("tap @7");
  });

  it("carries the session selector into suggestions", () => {
    const lines = getSuggestions({
      command: "snapshot",
      refs: [{ uid: "7", type: "ElevatedButton", text: "Go" }],
      session: "driver",
    });
    expect(lines.join(" ")).toContain("--app driver");
  });

  it("hides the selector for the default session", () => {
    const lines = getSuggestions({ command: "wait", session: "default" });
    expect(lines.join(" ")).not.toContain("--app");
  });

  it("always teaches the finder escape hatch", () => {
    const lines = getSuggestions({ command: "snapshot", refs: [] });
    expect(lines.join(" ")).toContain("text:");
  });
});
