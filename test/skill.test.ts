import { describe, expect, it } from "vitest";
import {
  SKILL_DESCRIPTION,
  createSkillMarkdown,
  extractCommandsBlock,
} from "../src/skill.js";

describe("extractCommandsBlock", () => {
  it("extracts the commands block from TOP_HELP", () => {
    const block = extractCommandsBlock();
    expect(block).toMatch(/^commands\[\d+\]:/);
    expect(block).toContain("snapshot");
    expect(block).toContain("gps");
  });
});

describe("createSkillMarkdown", () => {
  const markdown = createSkillMarkdown();

  it("has trigger-shaped frontmatter", () => {
    expect(markdown).toMatch(/^---\nname: flutter-axi\n/);
    expect(markdown).toContain(JSON.stringify(SKILL_DESCRIPTION));
  });

  it("rewrites invocations to npx -y form", () => {
    expect(markdown).toContain("npx -y flutter-axi");
  });

  it("documents the multi-app model and the driver setup", () => {
    expect(markdown).toContain("--app");
    expect(markdown).toContain("setup driver");
    expect(markdown).toContain("STALE_REF");
  });

  it("embeds the commands block and SDK built-ins", () => {
    expect(markdown).toContain(extractCommandsBlock());
    expect(markdown).toContain("update --check");
  });
});
