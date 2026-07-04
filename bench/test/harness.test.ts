import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { parse as parseYaml } from "yaml";
import { buildGradingPrompt, extractVerdict, formatTrajectory } from "../src/grader.js";
import { isApplicable, renderPrompt, FIXTURE_ROOT } from "../src/runner.js";
import { summarize, markdownReport } from "../src/reporter.js";
import { validateCommandPolicy } from "../src/validation.js";
import type { RunResult, TaskDef, ConditionDef } from "../src/types.js";

const CONFIG_DIR = join(resolve(import.meta.dirname, ".."), "config");

function loadTasks(): TaskDef[] {
  const doc = parseYaml(readFileSync(join(CONFIG_DIR, "tasks.yaml"), "utf-8")) as {
    tasks: Record<string, Omit<TaskDef, "id">>;
  };
  return Object.entries(doc.tasks).map(([id, def]) => ({ ...def, id }));
}

function loadConditions(): ConditionDef[] {
  const doc = parseYaml(
    readFileSync(join(CONFIG_DIR, "conditions.yaml"), "utf-8"),
  ) as { conditions: Record<string, Omit<ConditionDef, "id">> };
  return Object.entries(doc.conditions).map(([id, def]) => ({
    ...def,
    id: id as ConditionDef["id"],
  }));
}

describe("config files", () => {
  it("loads both conditions", () => {
    const conditions = loadConditions();
    expect(conditions.map((c) => c.id).sort()).toEqual([
      "dart-mcp",
      "flutter-axi",
    ]);
    const mcp = conditions.find((c) => c.id === "dart-mcp");
    expect(mcp?.mcp_config?.mcpServers).toHaveProperty("dart");
  });

  it("loads 13 tasks with native ones flutter-axi-only", () => {
    const tasks = loadTasks();
    expect(tasks.length).toBe(13);
    for (const task of tasks) {
      expect(task.prompt.length).toBeGreaterThan(20);
      if (task.category === "native") {
        expect(task.applicable_conditions).toEqual(["flutter-axi"]);
      } else {
        expect(task.applicable_conditions).toBeUndefined();
      }
    }
  });
});

describe("isApplicable", () => {
  const tasks = loadTasks();

  it("both conditions run counter tasks; only flutter-axi runs native tasks", () => {
    const counter = tasks.find((t) => t.id === "counter_read_initial")!;
    const native = tasks.find((t) => t.id === "native_gps_set")!;
    expect(isApplicable(counter, "flutter-axi")).toBe(true);
    expect(isApplicable(counter, "dart-mcp")).toBe(true);
    expect(isApplicable(native, "flutter-axi")).toBe(true);
    expect(isApplicable(native, "dart-mcp")).toBe(false);
  });
});

describe("renderPrompt", () => {
  it("substitutes fixture root and device placeholders", () => {
    const rendered = renderPrompt(
      "Launch __FIXTURE_ROOT__ on __DEVICE__ (__DEVICE__)",
      "emulator-5554",
    );
    expect(rendered).toContain(FIXTURE_ROOT);
    expect(rendered).not.toContain("__FIXTURE_ROOT__");
    expect(rendered).not.toContain("__DEVICE__");
    expect(rendered.match(/emulator-5554/g)).toHaveLength(2);
  });
});

describe("grader", () => {
  it("extracts verdicts from plain and fenced JSON", () => {
    expect(extractVerdict('{"pass": true, "reason": "ok"}')).toEqual({
      pass: true,
      reason: "ok",
    });
    expect(
      extractVerdict('```json\n{"pass": false, "reason": "hallucinated"}\n```'),
    ).toEqual({ pass: false, reason: "hallucinated" });
    expect(extractVerdict("no json here")).toBeNull();
  });

  it("formats Bash commands and results into a trajectory", () => {
    const jsonl = [
      JSON.stringify({
        type: "assistant",
        message: {
          content: [
            { type: "tool_use", name: "Bash", input: { command: "flutter-axi snapshot" } },
          ],
        },
      }),
      JSON.stringify({
        type: "user",
        message: { content: [{ type: "tool_result", content: 'uid=g1:12 Text "0"' }] },
      }),
      JSON.stringify({ type: "result", result: "The counter is 0" }),
    ].join("\n");
    const trajectory = formatTrajectory(jsonl);
    expect(trajectory).toContain("COMMAND: flutter-axi snapshot");
    expect(trajectory).toContain('OUTPUT: uid=g1:12 Text "0"');
    expect(trajectory).toContain("AGENT: The counter is 0");
  });

  it("builds a mobile-rubric grading prompt", () => {
    const prompt = buildGradingPrompt("Tap 5 times", "COMMAND: ...", "final is 5");
    expect(prompt).toContain("mobile app automation");
    expect(prompt).toContain("KNOWN FACTS: final is 5");
    expect(prompt).toContain('{"pass": true');
  });
});

describe("command policy", () => {
  const condition = loadConditions().find((c) => c.id === "flutter-axi")!;

  it("passes when flutter-axi was used", () => {
    expect(
      validateCommandPolicy(condition, ["flutter-axi snapshot"]),
    ).toBeNull();
  });

  it("fails when the agent bypassed the CLI", () => {
    expect(
      validateCommandPolicy(condition, [
        "flutter-axi snapshot",
        "adb shell input tap 100 200",
      ]),
    ).toMatch(/forbidden/);
    expect(validateCommandPolicy(condition, ["echo hi"])).toMatch(
      /no Bash command used a required/,
    );
  });
});

function fakeResult(overrides: Partial<RunResult>): RunResult {
  return {
    condition: "flutter-axi",
    task: "t",
    run: 1,
    model: "m",
    timestamp: "2026-07-04T00:00:00Z",
    usage: {
      input_tokens: 1000,
      input_tokens_cached: 500,
      input_tokens_uncached: 500,
      output_tokens: 100,
      reasoning_tokens: 0,
      total_cost_usd: 0.01,
      wall_clock_seconds: 10,
      turn_count: 3,
      command_count: 2,
      error_count: 0,
      command_log: [],
    },
    grade: { task_success: true, details: "" },
    agent_output: "",
    ...overrides,
  };
}

describe("reporter N/A handling", () => {
  it("excludes not_applicable runs from rates and marks them N/A", () => {
    const results: RunResult[] = [
      fakeResult({ condition: "flutter-axi", task: "native_gps_set" }),
      fakeResult({
        condition: "dart-mcp",
        task: "native_gps_set",
        grade: {
          task_success: false,
          details: "n/a",
          failure_reason: "not_applicable",
        },
      }),
      fakeResult({ condition: "dart-mcp", task: "counter_read_initial" }),
    ];
    const summaries = summarize(results);
    const mcp = summaries.find((s) => s.condition === "dart-mcp")!;
    expect(mcp.not_applicable).toBe(1);
    expect(mcp.total_tasks).toBe(1);
    expect(mcp.success_rate).toBe(1);

    const md = markdownReport(results);
    expect(md).toContain("| dart-mcp | N/A |");
    expect(md).toContain("reported N/A, not failed");
  });
});
