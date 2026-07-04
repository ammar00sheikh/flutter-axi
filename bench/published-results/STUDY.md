# Flutter AXI Benchmark Study: Agent Interface Comparison

## Overview

This study compares two interfaces AI agents use to drive Flutter mobile apps: **flutter-axi**, an AXI-compliant CLI, and the **raw Dart MCP server** (`dart mcp-server`, the official Dart/Flutter tooling MCP). All tasks target the same deterministic `flutter create` counter app on a booted iOS simulator and are graded by an LLM judge with an anti-hallucination rubric (answers must come from the live app, not source code or memory).

**Agent**: Claude Sonnet 4.6 (`claude-sonnet-4-6`)
**Judge**: Claude Sonnet 4.6
**Repeats**: 3 per condition × task
**Total runs**: 78 (2 conditions × 13 tasks × 3 repeats; 15 cells N/A - see Conditions)
**Date**: 2026-07-05

## Conditions

| Condition     | Interface       | Description                                                                                                                                                                        |
| ------------- | --------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `flutter-axi` | `flutter-axi` CLI | AXI-compliant wrapper over the Dart MCP server + a native device layer. Widget-tree snapshots with `uid=` refs, one-command interactions, TOON output, contextual suggestions.     |
| `dart-mcp`    | Dart MCP server | The official `dart mcp-server` loaded as MCP tools (eager - all schemas in context upfront). The system prompt names the driver-enabled entrypoint so tap tasks are equally possible. |

5 of the 13 tasks are **native-layer tasks** (GPS mocking, permission cycling, deep links, push delivery, app lifecycle) that the Dart MCP server has no capability for. These are recorded as **N/A** for `dart-mcp` and excluded from its success rate and averages - headline numbers are never padded by structurally impossible tasks.

## Key Results

Like-for-like comparison over the 8 tasks both conditions can perform (24 runs each):

| Condition       | Success% | Avg Input Tokens | Avg Cost    | Avg Duration | Avg Turns |
| --------------- | -------- | ---------------- | ----------- | ------------ | --------- |
| **flutter-axi** | **100%** | **99,588**       | **$0.0822** | **32.4s**    | **4.6**   |
| dart-mcp        | 100%     | 336,667          | $0.1598     | 52.6s        | 8.1       |

flutter-axi uses **70% fewer input tokens**, costs **49% less**, takes **43% fewer turns**, and finishes **38% faster** - at success parity. Across all 13 tasks (including the 5 native tasks dart-mcp cannot attempt), flutter-axi passed 39/39 runs.

## Findings

### 1. Success parity, half the cost

Both interfaces completed every graded task across 3 repeats (flutter-axi 39/39 including native tasks; dart-mcp 24/24 on applicable tasks). The differences are entirely in efficiency: $3.30 vs $3.84 total spent despite flutter-axi running 15 more graded cells.

### 2. Token efficiency scales with interaction count

The gap widens with the number of app interactions a task needs:

| Task | flutter-axi | dart-mcp | Cost ratio |
| ---- | ----------- | -------- | ---------- |
| counter_errors_clean (1 read) | $0.071 / 4 turns / 85K | $0.071 / 5 turns / 201K | 1.0× |
| counter_read_initial (launch + read) | $0.050 / 3 turns / 64K | $0.073 / 5 turns / 202K | 1.5× |
| counter_tree_inspect (launch + 2 reads) | $0.061 / 3 turns / 64K | $0.168 / 5 turns / 212K | 2.7× |
| counter_increment_5 (5 taps + read) | $0.099 / 5 turns / 110K | $0.203 / 11 turns / 465K | 2.0× |
| counter_screenshot (capture to file) | $0.071 / 4 turns / 86K | $0.330 / 14 turns / 636K | 4.7× |

Each flutter-axi action is one short Bash command (`tap @g2:7`) whose response is a compact TOON block plus the refreshed tree. Each dart-mcp interaction is a `flutter_driver` tool call with a verbose finder object, and every widget-tree read returns the raw inspector JSON.

### 3. Screenshots are the pathological case for MCP (4.7×)

The Dart MCP `flutter_driver` screenshot returns the image as an MCP content block - there is no save-to-file path - so the agent burns turns and context finding a workaround (636K input tokens, 14 turns). flutter-axi's `screenshot <path>` writes the file bridge-side and returns one line: the absolute path.

### 4. Pre-rendered snapshots beat raw tool output

flutter-axi converts the inspector tree into an indented text snapshot where only actionable widgets carry `uid=` refs (~15 lines for the counter app). dart-mcp agents receive the full inspector JSON (~2K tokens for the same screen) and must derive their own finders from it - visible in counter_tree_inspect's 2.7× cost ratio for a pure-read task.

### 5. Setup knowledge is encoded in the tool, not the agent

The dart-mcp condition needed three workflow hints in its system prompt (register roots via `add_roots`, connect the tooling daemon after launch, use the driver-enabled entrypoint for input) that flutter-axi performs implicitly on `launch`. Even with the hints given for free, dart-mcp averaged 8.1 turns to flutter-axi's 4.6 - the orchestration overhead lands in-context every run.

### 6. The native layer is a capability gap, not an efficiency gap

GPS mocking, permission cycling, deep links, push delivery, and lifecycle control are outside the Dart MCP server's scope entirely (15/39 dart-mcp cells N/A). For mobile E2E flows - location-driven movement, permission-denied paths, push-driven screens - the CLI's hybrid design is the difference between testable and untestable, independent of token economics.

## Methodology

- Sequential execution with randomized condition/task order to prevent ordering bias.
- Per-run isolation: each flutter-axi run gets a fresh named session (bridge + app reaped afterwards); the Dart MCP server is respawned by the agent process per run. The fixture is pre-built once so cold compiles stay out of timings.
- Command policy validation: flutter-axi runs are failed as `policy_violation` if the agent bypassed the CLI with adb/xcrun/flutter/dart.
- Grading: LLM judge over the full trajectory with task-specific known-facts hints; PASS requires values read from the live app.
- Judge limitation encountered and fixed during the study: an early screenshot run was mis-graded because the judge assumed the wrong working directory; the grading prompt now states that relative paths resolve against the agent's workspace, and the affected cells were re-run.
- Infrastructure note: the host disk filled mid-study; affected dart-mcp runs were discarded and the whole condition re-run cleanly.

### Known limitations

- The counter fixture is generated by `flutter create` - deterministic and dependency-free, but not literally pre-installed on the simulator.
- Both conditions ran on the same booted iOS simulator on the same host, sequentially.
- Single agent/judge model (Sonnet 4.6); results may differ across models.
- MCP tool schemas consume input tokens upfront; cost comparisons reflect total API cost including that overhead, which is the cost a user actually pays.

## Files

- `report.md` / `report.csv` - aggregate summary and per-task breakdown
- `flutter-axi.jsonl` / `dart-mcp.jsonl` - per-run records (usage metrics, grades, final agent output)
- Per-run artifacts (full agent trajectories, judge outputs) are produced under `bench/results/<condition>/<task>/runN/` when the harness runs
