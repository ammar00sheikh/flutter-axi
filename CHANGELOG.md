# Changelog

## [0.1.1](https://github.com/ammar00sheikh/flutter-axi/compare/flutter-axi-v0.1.0...flutter-axi-v0.1.1) (2026-07-04)


### Features

* **bench:** published results — flutter-axi vs raw Dart MCP study ([2ab29ef](https://github.com/ammar00sheikh/flutter-axi/commit/2ab29ef33be196865d1d7bcdf843daadb6e7c1fc))
* initial release of flutter-axi ([7511eaf](https://github.com/ammar00sheikh/flutter-axi/commit/7511eaf19feec527e06b9676260b933f2e32742b))
* **perf:** performance monitoring via the Dart VM service ([3cb41c9](https://github.com/ammar00sheikh/flutter-axi/commit/3cb41c999dc3af429c0e9217d55d01a1799314d8))

## 0.1.0 (2026-07-05)

Initial release.

### Features

- AXI-compliant CLI over the Dart MCP server: launch/attach/stopapp, widget-tree snapshots with generation-stamped `uid=` refs and a uid→finder registry, tap/fill/type/press/scroll/scrollinto/back/text/waitfor, hot reload/restart, logs, runtime errors, driver + OS screenshots
- Driver enablement: `setup driver <root>` writes the `enableFlutterDriverExtension()` shim entrypoint and dev-dependency; `launch` auto-targets it
- Native device layer (adb / xcrun simctl): GPS mocking with route playback, permission grant/revoke/reset, deep links, push notifications (real APNs on iOS simulators), app lifecycle, OS screenshots
- Named sessions (`--app <name>`) with per-session bridges, ports, and state; multi-app `run` script command with `apps.<name>` handles for cross-app E2E flows
- Agent integration: SessionStart hooks (`setup hooks`), generated installable Agent Skill, content-first home view, contextual suggestions
- Benchmark harness (`bench/`) replicating axi's bench-browser: flutter-axi vs raw Dart MCP, LLM-as-Judge grading, N/A-aware reporting
- Test suites: 137 unit tests (device-free) and a gated live e2e suite (single-app, native layer, two-simulator multi-app)
