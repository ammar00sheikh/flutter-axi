import { HOME_DESCRIPTION, TOP_HELP } from "./cli.js";

// Trigger string Claude Code (and other agents) match against to auto-load the skill.
// Kept terse and outcome-focused so it fires on "needs to drive a mobile app" intents.
export const SKILL_DESCRIPTION =
  "Control a Flutter app on an emulator, simulator, or device through the flutter-axi CLI - " +
  "launch, widget-tree snapshots, tap, fill text fields, scroll, hot reload, read logs and " +
  "runtime errors, screenshots, mock GPS, grant permissions, deep links, push notifications, " +
  "and performance profiling (frame timings/jank, memory, CPU, timeline traces). " +
  "Use whenever a task needs to run, drive, test, or profile a Flutter mobile app, including " +
  "multi-app flows across two devices.";

function yamlDoubleQuote(value: string): string {
  return JSON.stringify(value);
}

/**
 * Extract the project-owned `commands[N]:` block from top-level help.
 * SDK built-in commands are documented separately in the skill body because
 * runAxiCli appends them at runtime.
 */
export function extractCommandsBlock(): string {
  const match = TOP_HELP.match(/^(commands\[\d+\]:\n(?: {2}.*\n)+)/m);
  if (!match) {
    throw new Error("Could not find commands block in TOP_HELP");
  }
  return match[1].trimEnd();
}

const SDK_BUILT_IN_COMMANDS_BLOCK = `built-in:
  update: Upgrade flutter-axi to the latest published npm version
  "update --check": Report current vs latest without installing`;

export const SKILL_AUTHOR = "Waselni";
export const SKILL_HERMES_TAGS = [
  "flutter",
  "mobile",
  "automation",
  "emulator",
] as const;
export const SKILL_HERMES_CATEGORY = "automation";

/**
 * Render the installable SKILL.md for the flutter-axi skill. The body is
 * built from the same shared guidance the CLI prints (home description and
 * top-level help) plus documented SDK built-ins, rewriting invocations to
 * non-interactive `npx -y flutter-axi ...` so the CLI comes along on demand.
 */
export function createSkillMarkdown(): string {
  return `---
name: flutter-axi
description: ${yamlDoubleQuote(SKILL_DESCRIPTION)}
user-invocable: false
author: ${SKILL_AUTHOR}
metadata:
  hermes:
    tags: [${SKILL_HERMES_TAGS.join(", ")}]
    category: ${SKILL_HERMES_CATEGORY}
---

# flutter-axi

${HOME_DESCRIPTION}

You do not need flutter-axi installed globally - invoke it with \`npx -y flutter-axi <command>\`.
If flutter-axi output shows a follow-up command starting with \`flutter-axi\`, run it as \`npx -y flutter-axi ...\` instead.

## When to use

Use flutter-axi whenever a task needs to run or drive a Flutter app: launching on an emulator/simulator, tapping through a flow, filling forms, asserting on the widget tree, debugging runtime errors or logs, taking screenshots, mocking GPS movement, granting permissions, opening deep links, or delivering push notifications. It drives multiple apps at once via named sessions (\`--app user\`, \`--app driver\`) for end-to-end multi-app flows.

Skip it for pure Dart/Flutter code tasks (analysis, tests, formatting) that don't need a running app.

## Workflow

1. One-time per project: \`npx -y flutter-axi setup driver <root>\` (enables driver input), then \`flutter pub get\`.
2. \`npx -y flutter-axi devices\` to find a device id, then \`npx -y flutter-axi launch <root> --device <id>\`. Output includes the widget tree; interactive widgets carry \`uid=\` refs.
3. Interact by ref: \`tap @<uid>\`, \`fill @<uid> <text>\`, \`scroll @<uid>\`, \`text @<uid>\`. Pass refs back exactly as printed, including the \`g<N>:\` generation prefix. If the tree re-rendered since the snapshot, the action fails loudly with \`STALE_REF\` - run \`snapshot\` again and retry with fresh refs.
4. Widgets without a uid can be targeted directly with finder strings: \`tap text:Accept\`, \`fill key:email "a@b.c"\`, \`tap tooltip:Increment\`, \`tap type:FloatingActionButton\`.
5. After a state-changing action, confirm the outcome with the returned snapshot (or \`text @<uid>\` / \`screenshot <path>\`) before reporting success.
6. Re-orient anytime with \`snapshot\`; debug with \`logs\` and \`errors\`; iterate on code with \`reload\` / \`restart\`.
7. Native device control: \`gps <lat> <lon>\` (or \`--route\`), \`permission grant|revoke <name>\`, \`deeplink <url>\`, \`push --title ... --body ...\`, \`applifecycle force-stop|background|...\`, \`screenshot <path> --os\`.
8. Performance: \`perf\` (memory), \`perf frames --duration 5000 --scroll <ref>\` (frame timings + jank under load - frames only render while the UI moves, so pass \`--tap\`/\`--scroll\` to generate load), \`perf trace start\`/\`perf trace stop --file <path>\` (timeline for Perfetto), \`perf cpu --duration <ms>\` (top functions).
9. Multi-app flows: add \`--app <name>\` to any command to target a named session (one session = one app+device), or script both apps at once with \`run\` (globals \`apps.user\`, \`apps.driver\`).
10. Every response ends with contextual next-step hints - follow them. The first command auto-starts a persistent per-session bridge; run \`stop\` when you are done.

## Commands

\`\`\`
${extractCommandsBlock()}

${SDK_BUILT_IN_COMMANDS_BLOCK}
\`\`\`

Run \`npx -y flutter-axi --help\` for flags and environment variables, or \`npx -y flutter-axi <command> --help\` for per-command usage.

## Tips

- Add \`--full\` to snapshot-producing commands to disable truncation; pipe output through grep/head for large trees.
- \`launch\` compiles the app on first run - it can take minutes; later launches are fast. The launch timeout already allows for this.
- Driver input needs the app launched by flutter-axi through the driver shim; \`attach --dtd <uri>\` is inspection-only.
- Stable automation prefers ValueKeys: suggest adding \`key: ValueKey('name')\` to widgets that must be targeted reliably, then use \`key:name\` finders.
- Relative output paths for \`screenshot\` resolve against the directory where you run the CLI; output reports the absolute path.
`;
}
