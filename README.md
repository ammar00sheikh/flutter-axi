<h1 align="center">flutter-axi</h1>

<p align="center">
  <a href="https://github.com/ammar00sheikh/flutter-axi/actions/workflows/ci.yml"><img alt="CI" src="https://github.com/ammar00sheikh/flutter-axi/actions/workflows/ci.yml/badge.svg" /></a>
  <a href="https://github.com/ammar00sheikh/flutter-axi/actions/workflows/release-please.yml"><img alt="Release" src="https://github.com/ammar00sheikh/flutter-axi/actions/workflows/release-please.yml/badge.svg" /></a>
  <a href="#"><img alt="Platform" src="https://img.shields.io/badge/apps-iOS%20sim%20%7C%20Android%20emu-blue?style=flat-square" /></a>
</p>

<h3 align="center">The most agent-ergonomic Flutter app automation</h3>

`flutter-axi` wraps the [Dart MCP server](https://dart.dev/tools/mcp-server) with an [AXI](https://github.com/kunchenguid/axi)-compliant CLI, plus a native device layer (adb / xcrun simctl) for everything the Flutter tooling can't reach.

- **Token-efficient** — TOON-encoded output and pre-rendered widget-tree snapshots cut input tokens ~70% vs raw MCP
- **Combined operations** — one command launches, connects, snapshots, and suggests next steps
- **Contextual suggestions** — every response includes actionable next-step hints
- **Beyond the widget tree** — GPS mocking, permissions, deep links, push notifications, app lifecycle
- **Multi-app native** — named sessions and a script runner drive two apps at once (e.g. a rider and a driver app)

## Benchmarks

Agent ergonomics is measurable.
The benchmark harness in [`bench/`](bench/) replicates the [axi](https://github.com/kunchenguid/axi) methodology: 13 real app-automation tasks (launch-and-read, interaction flows, hot reload, log investigation, screenshots, GPS/permissions/push/lifecycle) run through both interfaces — 3 repeats each, with `claude-sonnet-4-6` as the agent and an LLM judge scoring task success against the live app.

flutter-axi posts the lowest input tokens, cost, duration, and turn count, with 100% task success:

| Condition            | Avg Input Tokens | Avg Cost/Task | Avg Duration | Avg Turns | Success  |
| -------------------- | ---------------- | ------------- | ------------ | --------- | -------- |
| **flutter-axi**      | **99,588**       | **$0.082**    | **32.4s**    | **4.6**   | **100%** |
| dart-mcp (raw MCP)   | 336,667          | $0.160        | 52.6s        | 8.1       | 100%     |

Against the raw Dart MCP server — the very server this CLI wraps — that is **70% fewer input tokens, 49% lower cost, and 43% fewer agent turns** on the 8 tasks both can perform.
The other 5 tasks (GPS, permissions, deep links, push, lifecycle) are outside the Dart MCP server's capability entirely; flutter-axi passed all of them and they are reported N/A for MCP rather than counted as wins.

The gap widens with interaction count — screenshots are the pathological case (4.7× cost for MCP, which has no save-to-file path):

| Task | flutter-axi | dart-mcp | Cost ratio |
| ---- | ----------- | -------- | ---------- |
| read counter (launch + 1 read) | $0.050 / 3 turns | $0.073 / 5 turns | 1.5× |
| inspect tree (launch + 2 reads) | $0.061 / 3 turns | $0.168 / 5 turns | 2.7× |
| tap increment ×5 | $0.099 / 5 turns | $0.203 / 11 turns | 2.0× |
| screenshot to file | $0.071 / 4 turns | $0.330 / 14 turns | 4.7× |

Full analysis, per-task tables, methodology, and fairness caveats: [`bench/published-results/STUDY.md`](bench/published-results/STUDY.md).

## Quick Start

Install from source (not yet published to npm):

```sh
git clone https://github.com/ammar00sheikh/flutter-axi.git
cd flutter-axi
npm install
npm run build
npm link        # puts `flutter-axi` on PATH
```

Then, once per Flutter project, enable driver input:

```sh
flutter-axi setup driver ~/my-app && (cd ~/my-app && flutter pub get)
```

And drive the app:

```sh
flutter-axi devices
flutter-axi launch ~/my-app --device <id>     # first launch compiles — be patient
```

Requirements: Node >= 20, Dart SDK >= 3.9 (`dart` on PATH, or set `FLUTTER_AXI_DART_BIN`), a booted iOS simulator or Android emulator.

## What Agent Sees

```sh
$ flutter-axi launch bench/fixtures/counter_app --device 00920CD6-...
app:
  pid: 83714
  device: 00920CD6-2DFD-4A6F-9339-709459BBEE60
  platform: ios
  appId: dev.flutteraxi.counterApp
  driver: enabled
app:
  title: Flutter Demo Home Page
  refs: 8
tree:
uid=g1:1 MyApp
  MaterialApp
    uid=g1:3 MyHomePage
      Scaffold
        Center
          Column
            uid=g1:11 Text "You have pushed the button this many times:"
            uid=g1:12 Text "0"
        uid=g1:6 AppBar
          uid=g1:9 Text "Flutter Demo Home Page"
        uid=g1:7 FloatingActionButton
          uid=g1:10 Icon
help[2]:
  Run `flutter-axi tap @g1:7` to tap the FloatingActionButton
  Widgets without a uid can be targeted directly: `flutter-axi tap text:<visible text>` (also key:, type:, tooltip:, label:)

$ flutter-axi tap @g1:7
app:
  title: Flutter Demo Home Page
  refs: 8
tree:
...
            uid=g2:12 Text "1"
...
```

Refs carry a `g<N>:` generation prefix that bumps on every fresh snapshot. Pass refs back exactly as printed — if the tree re-rendered between snapshot and action, the action fails loudly with `STALE_REF` instead of silently acting on a stale tree, so the agent re-snapshots and retries.
Widgets without a uid can be targeted with finder strings: `text:`, `key:`, `type:`, `tooltip:`, `label:`.

## Other Ways to Install

### Agent Skill

Install the flutter-axi skill in the [Agent Skills](https://agentskills.io) format with [`npx skills`](https://github.com/vercel-labs/skills):

```sh
npx skills add ammar00sheikh/flutter-axi --skill flutter-axi -g
```

The skill (`skills/flutter-axi/SKILL.md`, generated from the CLI's own guidance) teaches your agent when and how to use flutter-axi; it loads on demand when the agent recognizes a mobile-app task. `-g` installs for all projects; drop it for the current project only.

### Session hook

Want ambient app-session context fed into every agent session instead of loading on demand?

```sh
flutter-axi setup hooks
```

This installs a `SessionStart` hook for **Claude Code**, **Codex**, and **OpenCode** that surfaces the active app session (device, screen title, ref count) and usage guidance at the start of each session.
**Restart your agent session after running this.** Development entrypoints (`npm run dev`) are guarded from accidental hook installation.

## How It Works

```
flutter-axi CLI  (axi-sdk-js: TOON output, structured errors, suggestions)
  ├─► HTTP bridge (one per session)  ─►  dart mcp-server  ─►  running Flutter app
  └─► native layer (adb / xcrun simctl)  ─►  emulator / simulator
```

Every CLI invocation is a short-lived process; a detached per-session bridge holds the persistent MCP connection to `dart mcp-server`, which drives the app through the Dart Tooling Daemon and the flutter_driver extension.
Because the Dart MCP driver addresses widgets with *finders* rather than uids, flutter-axi mints its own generation-stamped uids at snapshot time and keeps a uid→finder registry per session.
Native commands (GPS, permissions, deep links, push, lifecycle, OS screenshots) go straight to `adb` / `xcrun simctl` — no bridge involved.

## Native Device Control

```sh
flutter-axi gps 33.5138 36.2765               # mock location (or --route file.jsonl)
flutter-axi permission grant location         # no OS permission dialogs
flutter-axi deeplink myapp://ride/123
flutter-axi push --title "New ride" --body "Pickup at Main St"   # real APNs on iOS sims
flutter-axi applifecycle force-stop           # install/uninstall/clear/background/foreground
flutter-axi screenshot ./screen.png --os      # OS-level capture (system UI included)
```

## Performance Monitoring

Profiling goes straight to the app's Dart VM service (discovered automatically from the run logs) — every result is a pre-aggregated, decision-ready summary:

```sh
flutter-axi perf                                          # memory: heap/external per isolate + process RSS
flutter-axi perf frames --duration 5000 --scroll type:ListView
# frames: {count: 230, fps: 57.5, jank: "1 (0.4% over 16.7ms budget)",
#          build: "avg 2.2ms, p95 3.7ms, max 34.2ms", raster: "avg 0.8ms, ..."}
flutter-axi perf trace start && flutter-axi tap @g1:7 && flutter-axi perf trace stop --file ./trace.json
# timeline JSON loadable in https://ui.perfetto.dev
flutter-axi perf cpu --duration 3000                      # top functions by exclusive samples
```

`perf frames` measures frames rendered during the window — pass `--tap <ref>` or `--scroll <ref>` and the CLI generates the load itself (e.g. jank-test a list with one command). Use `--budget 8.3` for 120Hz displays.

## Multi-App Orchestration

One session = one app + device. Add `--app <name>` to any command, or script several apps at once:

```sh
flutter-axi --app user   launch ~/user-app   --device <sim-1>
flutter-axi --app driver launch ~/driver-app --device <sim-2>

flutter-axi run <<'EOF'
const user = apps.user, driver = apps.driver;
await driver.gps(33.5138, 36.2765);
await user.tap("text:Request Ride");
await driver.waitFor("New ride request", { timeout: 30000 });
await driver.tap("text:Accept");
await user.waitFor("Driver assigned");
console.log("ride flow OK");
EOF
```

See [`examples/ride-flow.mjs`](examples/ride-flow.mjs) for a full rider–driver E2E example.

## Development

```sh
npm install
npm test          # unit suite (no devices needed)
npm run test:e2e  # live suite — needs a booted simulator (two for multi-app tests)
npm run build     # compile to dist/
```

Architecture notes for coding agents: [`AGENTS.md`](AGENTS.md). Contribution conventions: [`CONTRIBUTING.md`](CONTRIBUTING.md).

## Limitations

- Driver input requires the app to be launched by flutter-axi through the driver shim (`setup driver`); `attach --dtd <uri>` is inspection-only.
- Android needs adb (`ANDROID_HOME`); iOS simulators need Xcode CLI tools; physical iOS devices are not supported in v1.
- Android push is a local-notification approximation (no FCM injection on stock emulators); iOS `simctl push` delivers real APNs payloads.
