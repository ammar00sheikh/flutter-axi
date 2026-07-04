# flutter-axi benchmark harness

Compares agent performance driving a Flutter app through **flutter-axi** (AXI-compliant CLI) versus the **raw Dart MCP server**, replicating the methodology of [axi's bench-browser](https://github.com/kunchenguid/axi): YAML-defined tasks and conditions, sequential execution with randomized order, per-run isolation, stream-json usage parsing, and LLM-as-Judge grading.

## Prerequisites

- A booted iOS simulator (`open -a Simulator`) or Android emulator
- `claude` CLI authenticated
- `dart` on PATH (Dart SDK >= 3.9)
- The counter fixture: `bench/scripts/setup-fixture.sh` (runs `flutter create` + `flutter-axi setup driver`)

## Usage

```sh
npm install

# Single condition x task
npm run bench -- run --condition flutter-axi --task counter_read_initial
npm run bench -- run --condition dart-mcp --task counter_read_initial

# Full matrix
npm run bench -- matrix --repeat 5

# Summary report (results/report.md + report.csv)
npm run bench -- report
```

## Conditions

| Condition | What the agent gets |
|---|---|
| `flutter-axi` | The `flutter-axi` CLI on PATH, used via Bash. Command policy forbids bypassing it with adb/xcrun/flutter/dart. |
| `dart-mcp` | The Dart MCP server (`dart mcp-server`) loaded as MCP tools (no ToolSearch — schemas in context up front). |

## Tasks

8 Flutter-layer tasks (both conditions) against the `flutter create` counter app: read initial value, increment ×5, tree inspection, hot-reload edit, log investigation, definitive no-errors answer, screenshot, restart-resets-state. Plus 5 native-layer tasks (`flutter-axi` only): GPS mock, permission grant/revoke, deep link, push delivery, lifecycle cycle.

## Metrics

Per run: input/output tokens, cache hit %, cost (USD), wall-clock seconds, turn count, command count, LLM-judged success. Judge model: `claude-sonnet-4-6`, pass/fail with anti-hallucination rubric (answers must come from the live app, not memory).

## Fairness caveats (read before quoting results)

1. **The counter fixture is generated, not literally pre-installed.** It is the stock `flutter create` template — deterministic and dependency-free — built once before the matrix so cold compiles don't skew timings.
2. **Native tasks are structurally impossible for raw dart-mcp** (it has no device-level GPS/permission/push/deeplink capability). They are recorded as **N/A** for dart-mcp and excluded from its success rate and averages — headline numbers are never padded by tasks a condition cannot attempt.
3. flutter-axi runs get a fresh session (bridge + app) per run; the Dart MCP server is respawned by the agent process per run — both start cold.
4. Driver input requires a driver-enabled entrypoint in both conditions. flutter-axi uses its shim automatically; the dart-mcp condition's system prompt explicitly names the same entrypoint (`lib/flutter_axi_main.dart`) so tap-dependent tasks are equally *possible* under both — the comparison measures ergonomics and token cost, not hidden knowledge.
