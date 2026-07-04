# flutter-axi

**Agent-ergonomic Flutter app automation.** An [AXI](https://github.com/kunchenguid/axi)-compliant CLI that lets coding agents launch, inspect, and drive Flutter apps on emulators, simulators, and devices — widget-tree snapshots with stable refs, driver interactions, hot reload, and native device control (GPS, permissions, deep links, push), all with token-efficient TOON output and contextual next-step suggestions.

Architecturally a sibling of [chrome-devtools-axi](https://github.com/kunchenguid/chrome-devtools-axi): a thin CLI over a persistent per-session HTTP bridge that owns a [Dart MCP server](https://dart.dev/tools/mcp-server) (`dart mcp-server`) child, plus a direct `adb` / `xcrun simctl` layer for everything the Flutter tooling can't reach.

```
flutter-axi CLI  (axi-sdk-js: TOON output, structured errors, suggestions)
  ├─► HTTP bridge (one per session)  ─►  dart mcp-server  ─►  running Flutter app
  └─► native layer (adb / xcrun simctl)  ─►  emulator / simulator
```

## Quick start

```sh
# One-time per Flutter project: enable driver input
flutter-axi setup driver ~/my-app && (cd ~/my-app && flutter pub get)

flutter-axi devices
flutter-axi launch ~/my-app --device <id>     # first launch compiles — be patient
flutter-axi snapshot                          # widget tree; interactive widgets carry uid= refs
flutter-axi tap @g1:7                         # or: tap text:Accept / key:submit / tooltip:Increment
flutter-axi fill @g1:3 "hello"
flutter-axi text @g1:12
flutter-axi errors && flutter-axi logs
flutter-axi screenshot ./app.png
flutter-axi stop
```

Refs are generation-tagged (`@g3:12`); pass them back exactly as printed. If the tree re-rendered since the snapshot, actions fail loudly with `STALE_REF` — re-snapshot and retry. Widgets without a uid can be targeted with finder strings: `text:`, `key:`, `type:`, `tooltip:`, `label:`.

## Native device control

Things the Flutter tooling layer cannot do, via `adb` / `xcrun simctl`:

```sh
flutter-axi gps 33.5138 36.2765               # mock location (or --route file.jsonl)
flutter-axi permission grant location         # no OS permission dialogs
flutter-axi deeplink myapp://ride/123
flutter-axi push --title "New ride" --body "Pickup at Main St"   # real APNs on iOS sims
flutter-axi applifecycle force-stop           # install/uninstall/clear/background/foreground
flutter-axi screenshot ./screen.png --os      # OS-level capture (system UI included)
```

## Multi-app orchestration

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

See `examples/ride-flow.mjs` for a full rider-driver E2E example.

## Agent integration

- `flutter-axi setup hooks` — install SessionStart hooks (Claude Code, Codex, OpenCode) for ambient context.
- `skills/flutter-axi/SKILL.md` — installable agent skill (generated from the CLI's own help; `npm run build:skill`).
- Running `flutter-axi` with no arguments shows live app state, not help text.

## Requirements

- Node >= 20; Dart SDK >= 3.9 (`dart mcp-server`) — set `FLUTTER_AXI_DART_BIN` if dart isn't on PATH
- Driver input requires the app to be launched by flutter-axi through the driver shim (`setup driver`); `attach --dtd <uri>` is inspection-only
- Native layer: Android needs adb (`ANDROID_HOME`), iOS simulators need Xcode CLI tools; physical iOS devices are not supported in v1

## Development

```sh
npm install
npm test          # unit suite (no devices needed)
npm run test:e2e  # live suite — needs a booted simulator (two for multi-app tests)
npm run build     # compile to dist/
```

## Benchmark

`bench/` replicates the [axi](https://github.com/kunchenguid/axi) bench-browser methodology (YAML tasks/conditions, LLM-as-Judge grading, randomized order, per-run isolation) comparing **flutter-axi** against the **raw Dart MCP server**. See `bench/README.md`.
