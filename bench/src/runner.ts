/**
 * Benchmark runner — executes Flutter app-automation tasks and grades results.
 *
 * Per RunSpec:
 * 1. Create artifact dir: results/{condition}/{task}/{runN}/
 * 2. Create workspace with condition-specific CLAUDE.md content
 * 3. Run Claude agent with MCP isolation (--strict-mcp-config)
 * 4. Parse JSONL output -> usage metrics
 * 5. Run grader -> grade.json
 * 6. Append to per-condition results jsonl
 *
 * Adapted from axi's bench-browser runner. flutter-axi runs get an isolated
 * FLUTTER_AXI_SESSION per run so state never leaks between runs; tasks whose
 * applicable_conditions exclude the condition are recorded as not_applicable
 * without spending an agent run.
 */

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync, appendFileSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";

import type { RunSpec, RunResult, ConditionDef, TaskDef } from "./types.js";
import { parseClaudeJsonl } from "./usage.js";
import { grade } from "./grader.js";
import { validateCommandPolicy } from "./validation.js";

const BENCH_ROOT = resolve(import.meta.dirname, "..");
const RESULTS_DIR = join(BENCH_ROOT, "results");
export const FIXTURE_ROOT = join(BENCH_ROOT, "fixtures", "counter_app");

/** First launch of a run compiles the app - allow well beyond 5 minutes. */
const AGENT_TIMEOUT_MS = 10 * 60 * 1000;

function makeSessionName(spec: Pick<RunSpec, "condition" | "task" | "run">): string {
  const raw = `bench-${spec.condition}-${spec.task}-run${spec.run}`;
  return raw.replace(/[^a-zA-Z0-9._-]/g, "-").slice(0, 64);
}

/** Substitute task placeholders: fixture root and target device id. */
export function renderPrompt(prompt: string, deviceId: string): string {
  return prompt
    .replaceAll("__FIXTURE_ROOT__", FIXTURE_ROOT)
    .replaceAll("__DEVICE__", deviceId);
}

export function isApplicable(task: TaskDef, conditionId: string): boolean {
  return (
    !task.applicable_conditions ||
    task.applicable_conditions.includes(conditionId as TaskDef["applicable_conditions"] extends (infer T)[] | undefined ? T : never)
  );
}

/** Record a not-applicable cell without running the agent. */
export function recordNotApplicable(
  spec: RunSpec,
  task: TaskDef,
): RunResult {
  const result: RunResult = {
    condition: spec.condition,
    task: spec.task,
    run: spec.run,
    model: spec.model,
    timestamp: new Date().toISOString(),
    usage: {
      input_tokens: 0,
      input_tokens_cached: 0,
      input_tokens_uncached: 0,
      output_tokens: 0,
      reasoning_tokens: 0,
      total_cost_usd: 0,
      wall_clock_seconds: 0,
      turn_count: 0,
      command_count: 0,
      error_count: 0,
      command_log: [],
    },
    grade: {
      task_success: false,
      details: `Task ${task.id} does not apply to condition ${spec.condition} (native-layer capability).`,
      failure_reason: "not_applicable",
    },
    agent_output: "",
  };
  upsertResult(result);
  return result;
}

export function runOne(
  spec: RunSpec,
  condition: ConditionDef,
  task: TaskDef,
  deviceId: string,
): RunResult {
  if (!isApplicable(task, spec.condition)) {
    return recordNotApplicable(spec, task);
  }

  // 1. Create artifact dir
  const artifactDir = join(RESULTS_DIR, spec.condition, spec.task, `run${spec.run}`);
  mkdirSync(artifactDir, { recursive: true });

  // 2. Set up workspace: a directory with CLAUDE.md (auditability only)
  const workspaceDir = join(artifactDir, "workspace");

  try {
    mkdirSync(workspaceDir, { recursive: true });
    const agentsMd = condition.agents_md;
    // Written for workspace auditability only — not read by Claude
    // (--setting-sources "" disables auto-discovery). Agent receives this
    // content via --append-system-prompt instead.
    writeFileSync(join(workspaceDir, "CLAUDE.md"), agentsMd);

    if (condition.mcp_config) {
      writeFileSync(
        join(artifactDir, ".mcp-config.json"),
        JSON.stringify(condition.mcp_config),
      );
    }

    // Empty MCP config for CLI conditions (used with --strict-mcp-config to
    // prevent the user's local MCP servers from leaking in)
    const emptyMcpConfigPath = join(artifactDir, ".empty-mcp-config.json");
    writeFileSync(emptyMcpConfigPath, JSON.stringify({ mcpServers: {} }));

    const prompt = renderPrompt(task.prompt, deviceId);

    // 3. Run agent
    let agentOutput: string;
    let wallClockSeconds: number;
    try {
      ({ agentOutput, wallClockSeconds } = runAgent(
        spec,
        condition,
        prompt,
        artifactDir,
        workspaceDir,
        agentsMd,
      ));
    } finally {
      // Reap the run's flutter-axi session (bridge + launched app) so state
      // never leaks into the next run. No-op for the MCP condition.
      if (condition.id === "flutter-axi") {
        stopFlutterAxiSession(makeSessionName(spec));
      }
    }

    writeFileSync(join(artifactDir, "agent_output.txt"), agentOutput);

    // 4. Parse usage
    const usage = parseClaudeJsonl(agentOutput, { model: spec.model, wallClockSeconds });

    const finalOutput = extractClaudeFinalOutput(agentOutput);

    // 5. Grade — pass raw JSONL so the judge sees the full trajectory
    const usageValidationError = validateCommandPolicy(condition, usage.command_log, agentOutput);
    const gradeResult = usageValidationError
      ? {
          task_success: false,
          details: usageValidationError,
          failure_reason: "policy_violation" as const,
        }
      : grade(task.grading, prompt, agentOutput, artifactDir);
    writeFileSync(join(artifactDir, "grade.json"), JSON.stringify(gradeResult, null, 2));

    // 6. Build result
    const result: RunResult = {
      condition: spec.condition,
      task: spec.task,
      run: spec.run,
      model: spec.model,
      timestamp: new Date().toISOString(),
      usage,
      grade: gradeResult,
      agent_output: finalOutput.slice(0, 2000), // Truncate for JSONL
    };

    // 7. Upsert into per-condition results file
    upsertResult(result);

    return result;
  } finally {
    if (existsSync(workspaceDir)) {
      rmSync(workspaceDir, { recursive: true, force: true });
    }
  }
}

function upsertResult(result: RunResult): void {
  mkdirSync(RESULTS_DIR, { recursive: true });
  const conditionJsonl = join(RESULTS_DIR, `${result.condition}.jsonl`);
  if (existsSync(conditionJsonl)) {
    const kept = readFileSync(conditionJsonl, "utf-8")
      .split("\n")
      .filter((l) => {
        if (!l.trim()) return false;
        try {
          const r = JSON.parse(l) as { task: string; run: number };
          return !(r.task === result.task && r.run === result.run);
        } catch { return true; }
      });
    writeFileSync(conditionJsonl, kept.length > 0 ? kept.join("\n") + "\n" : "");
  }
  appendFileSync(conditionJsonl, JSON.stringify(result) + "\n");
}

/** Extract the agent's final text output from Claude stream-json output. */
function extractClaudeFinalOutput(jsonl: string): string {
  const parts: string[] = [];
  for (const line of jsonl.split("\n")) {
    if (!line.trim()) continue;
    try {
      const entry = JSON.parse(line) as Record<string, unknown>;
      if (entry.type === "result" && typeof entry.result === "string") {
        return entry.result;
      }
      if (entry.type === "assistant") {
        const msg = entry.message as Record<string, unknown> | undefined;
        if (msg && Array.isArray(msg.content)) {
          for (const block of msg.content) {
            const b = block as Record<string, unknown>;
            if (b.type === "text" && typeof b.text === "string") {
              parts.push(b.text);
            }
          }
        }
      }
    } catch {
      continue;
    }
  }
  return parts.length > 0 ? parts.join("\n") : jsonl;
}

/** PATH with the bench shim first, so `flutter-axi` resolves for agents. */
export function benchPath(): string {
  return `${join(BENCH_ROOT, "bin")}:${process.env.PATH ?? ""}`;
}

function stopFlutterAxiSession(sessionName: string): void {
  try {
    execFileSync(join(BENCH_ROOT, "bin", "flutter-axi"), ["stop"], {
      encoding: "utf-8",
      timeout: 60_000,
      stdio: "pipe",
      env: { ...process.env, FLUTTER_AXI_SESSION: sessionName, PATH: benchPath() },
    });
  } catch {
    // Bridge may never have started - fine.
  }
}

function runAgent(
  spec: RunSpec,
  condition: ConditionDef,
  prompt: string,
  artifactDir: string,
  workspaceDir: string,
  agentsMd: string,
): { agentOutput: string; wallClockSeconds: number } {
  const args: string[] = [
    "--setting-sources", "",
    "-p", prompt,
    "--model", spec.model,
    "--output-format", "stream-json",
    "--verbose",
    "--dangerously-skip-permissions",
    "--no-session-persistence",
    "--append-system-prompt", agentsMd,
    "--disable-slash-commands",
  ];

  // All conditions: disallow WebFetch/WebSearch so agents must use the
  // designated tool rather than researching around it.
  const disallowedTools: string[] = ["WebFetch", "WebSearch"];

  if (condition.id === "dart-mcp") {
    // MCP condition: tools loaded upfront into context (no ToolSearch),
    // mirroring bench-browser's chrome-devtools-mcp condition.
    const mcpConfigPath = join(artifactDir, ".mcp-config.json");
    disallowedTools.push("ToolSearch");
    args.push(
      "--strict-mcp-config",
      "--mcp-config", mcpConfigPath,
      "--allowedTools", "Read,Write",
      "--disallowedTools", disallowedTools.join(","),
    );
  } else {
    // CLI condition: empty MCP config prevents local MCP servers leaking in.
    const emptyMcpConfigPath = join(artifactDir, ".empty-mcp-config.json");
    args.push(
      "--strict-mcp-config",
      "--mcp-config", emptyMcpConfigPath,
      "--allowedTools", "Bash,Read,Write",
      "--disallowedTools", disallowedTools.join(","),
    );
  }

  const startTime = Date.now();
  let agentOutput = "";
  try {
    agentOutput = execFileSync("claude", args, {
      encoding: "utf-8",
      timeout: AGENT_TIMEOUT_MS,
      maxBuffer: 50 * 1024 * 1024, // 50MB — screenshots produce large base64 output
      stdio: ["pipe", "pipe", "pipe"],
      env: {
        ...process.env,
        // Isolate flutter-axi state per run; harmless for the MCP condition.
        FLUTTER_AXI_SESSION: makeSessionName(spec),
        // Expose the repo's flutter-axi as a PATH binary for Bash commands.
        PATH: benchPath(),
      },
      cwd: workspaceDir,
    });
  } catch (err: unknown) {
    const execErr = err as { stdout?: string; stderr?: string };
    agentOutput = execErr.stdout ?? "";
    const stderr = execErr.stderr ?? "";
    writeFileSync(join(artifactDir, "stderr.txt"), stderr);
  }
  return { agentOutput, wallClockSeconds: (Date.now() - startTime) / 1000 };
}
