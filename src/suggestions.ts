import type { RefSummary } from "./widgettree.js";

export interface SuggestionContext {
  command: string;
  refs?: RefSummary[];
  /** Active session name when not "default" - carried into suggested commands. */
  session?: string;
}

const BUTTON_TYPES = new Set([
  "FloatingActionButton",
  "ElevatedButton",
  "TextButton",
  "OutlinedButton",
  "IconButton",
  "FilledButton",
  "CupertinoButton",
  "ListTile",
  "InkWell",
  "GestureDetector",
  "Checkbox",
  "Switch",
  "Radio",
]);

const INPUT_TYPES = new Set([
  "TextField",
  "TextFormField",
  "CupertinoTextField",
  "EditableText",
]);

export function isButtonType(type: string): boolean {
  return BUTTON_TYPES.has(type);
}

export function isInputType(type: string): boolean {
  return INPUT_TYPES.has(type);
}

export function getSuggestions(ctx: SuggestionContext): string[] {
  // Carry the session selector forward so multi-app suggestions stay scoped.
  const app = ctx.session && ctx.session !== "default" ? ` --app ${ctx.session}` : "";
  const cli = `flutter-axi${app}`;

  // Commands without an auto-snapshot - point back at app state.
  if (ctx.command === "wait" || ctx.command === "logs" || ctx.command === "errors") {
    return [`Run \`${cli} snapshot\` to see current app state`];
  }

  const refs = ctx.refs ?? [];
  const buttons = refs.filter((r) => isButtonType(r.type));
  const inputs = refs.filter((r) => isInputType(r.type));
  const lines: string[] = [];

  // After filling a field, suggest submitting.
  if (ctx.command === "fill" || ctx.command === "type") {
    lines.push(
      `Run \`${cli} press done\` to submit the field (actions: done, search, go, next)`,
    );
  }

  // Suggest filling inputs (unless we just filled one).
  if (inputs.length > 0 && ctx.command !== "fill" && ctx.command !== "type") {
    const inp = inputs[0];
    const label = inp.text ? `the "${inp.text}" field` : "the text field";
    lines.push(`Run \`${cli} fill @${inp.uid} "text"\` to fill ${label}`);
  }

  // Suggest tapping buttons.
  if (buttons.length > 0) {
    const btn = buttons[0];
    const label = btn.text ? `"${btn.text}" ` : "";
    lines.push(`Run \`${cli} tap @${btn.uid}\` to tap the ${label}${btn.type}`);
  }

  // Suggest scrolling when the screen is busy.
  if (refs.length > 8) {
    lines.push(
      `Run \`${cli} scroll @<uid> --dy -300\` to scroll a list, or \`${cli} scrollinto @<uid>\` to reveal a widget`,
    );
  }

  // Teach the finder escape hatch - works even for widgets without a uid.
  lines.push(
    `Widgets without a uid can be targeted directly: \`${cli} tap text:<visible text>\` (also key:, type:, tooltip:, label:)`,
  );

  return lines;
}
