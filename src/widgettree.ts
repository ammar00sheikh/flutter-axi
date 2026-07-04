/**
 * Widget-tree parsing and uid-ref snapshot rendering.
 *
 * `get_widget_tree` returns a JSON tree of inspector nodes. flutter-axi
 * flattens it into a token-efficient indented text snapshot, minting a `uid=`
 * ref for every node it can address with a *simple* flutter_driver finder
 * (ByValueKey / ByText / ByType). Nodes that cannot be uniquely addressed
 * render without a uid - agents can still target them with the
 * `text:`/`key:`/`type:`/`tooltip:`/`label:` finder escape hatch.
 *
 * Nested Descendant/Ancestor finders are deliberately not derived: the Dart
 * MCP server (as of SDK 3.11.5) forwards nested finder maps to the driver in
 * Dart toString() form, which the driver's jsonDecode rejects (see
 * test/fixtures/mcp-outputs.md).
 */

import type { Finder } from "./refs.js";

export interface WidgetNode {
  /** Local uid (numeric suffix of the inspector valueId). */
  uid: string;
  /** Widget runtime type, e.g. "Text", "FloatingActionButton". */
  type: string;
  /** Inspector description, e.g. "Text" or "Text-[<'counter'>]". */
  description: string;
  /** Text content preview for Text widgets. */
  text: string | null;
  /** ValueKey string parsed from the description, when present. */
  keyValue: string | null;
  depth: number;
  createdByLocalProject: boolean;
  children: WidgetNode[];
}

interface RawInspectorNode {
  description?: unknown;
  widgetRuntimeType?: unknown;
  valueId?: unknown;
  textPreview?: unknown;
  createdByLocalProject?: unknown;
  children?: unknown;
}

/**
 * Parse a ValueKey annotation out of an inspector description.
 * `Text-[<'counter'>]` -> "counter"; keys rendered from non-string values
 * (`[<3>]`, GlobalKeys) are left unparsed (null) since ByValueKey needs the
 * exact key type and only int/String are supported by the driver.
 */
export function parseKeyFromDescription(description: string): string | null {
  const m = description.match(/-\[<'(.+?)'>\]$/);
  return m ? m[1] : null;
}

function parseUidFromValueId(valueId: string): string {
  const m = valueId.match(/(\d+)$/);
  return m ? m[1] : valueId;
}

function parseNode(raw: RawInspectorNode, depth: number): WidgetNode {
  const description =
    typeof raw.description === "string" ? raw.description : "";
  const type =
    typeof raw.widgetRuntimeType === "string"
      ? raw.widgetRuntimeType
      : description;
  const children = Array.isArray(raw.children)
    ? raw.children.map((c) => parseNode(c as RawInspectorNode, depth + 1))
    : [];
  return {
    uid:
      typeof raw.valueId === "string" ? parseUidFromValueId(raw.valueId) : "",
    type,
    description,
    text: typeof raw.textPreview === "string" ? raw.textPreview : null,
    keyValue: parseKeyFromDescription(description),
    depth,
    createdByLocalProject: raw.createdByLocalProject === true,
    children,
  };
}

/**
 * Parse the JSON text returned by get_widget_tree into a root node.
 * Throws on malformed input (callers translate to a structured error).
 */
export function parseWidgetTree(json: string): WidgetNode {
  const raw = JSON.parse(json) as RawInspectorNode;
  return parseNode(raw, 0);
}

/** Flatten a tree depth-first. */
export function flattenTree(root: WidgetNode): WidgetNode[] {
  const out: WidgetNode[] = [];
  const walk = (node: WidgetNode) => {
    out.push(node);
    for (const child of node.children) walk(child);
  };
  walk(root);
  return out;
}

/**
 * Derive the best simple finder for each node, checking uniqueness across the
 * whole tree. Priority: ByValueKey (keys are unique by construction in
 * correct Flutter code) > unique ByText > unique ByType. Returns a map of
 * node uid -> finder; nodes with no entry are display-only.
 */
export function deriveFinders(root: WidgetNode): Record<string, Finder> {
  const nodes = flattenTree(root);

  const textCounts = new Map<string, number>();
  const typeCounts = new Map<string, number>();
  for (const n of nodes) {
    if (n.text !== null) {
      textCounts.set(n.text, (textCounts.get(n.text) ?? 0) + 1);
    }
    typeCounts.set(n.type, (typeCounts.get(n.type) ?? 0) + 1);
  }

  const finders: Record<string, Finder> = {};
  for (const n of nodes) {
    if (!n.uid) continue;
    if (n.keyValue !== null) {
      finders[n.uid] = {
        finderType: "ByValueKey",
        keyValueString: n.keyValue,
        keyValueType: "String",
      };
    } else if (n.text !== null && textCounts.get(n.text) === 1) {
      finders[n.uid] = { finderType: "ByText", text: n.text };
    } else if (typeCounts.get(n.type) === 1 && !isStructuralType(n.type)) {
      finders[n.uid] = { finderType: "ByType", type: n.type };
    }
  }
  return finders;
}

/**
 * Structural/layout types that are pointless tap targets even when unique -
 * suppressing their uids keeps the snapshot's ref count meaningful.
 */
const STRUCTURAL_TYPES = new Set([
  "RootWidget",
  "MaterialApp",
  "CupertinoApp",
  "WidgetsApp",
  "Scaffold",
  "SafeArea",
  "Center",
  "Padding",
  "Column",
  "Row",
  "Stack",
  "Expanded",
  "Flexible",
  "SizedBox",
  "Container",
  "DecoratedBox",
  "ConstrainedBox",
  "Align",
  "Positioned",
  "Spacer",
  "Divider",
]);

function isStructuralType(type: string): boolean {
  return STRUCTURAL_TYPES.has(type);
}

export interface RenderedTree {
  /** Indented text snapshot with uid= refs (unstamped - caller stamps generation). */
  text: string;
  /** uid -> finder registry for every ref that appears in the text. */
  refs: Record<string, Finder>;
  /** Number of interactive refs minted. */
  refCount: number;
  /** Best-effort screen title (first AppBar text, else first text). */
  title: string;
}

/**
 * Render a parsed widget tree as an indented uid-ref snapshot:
 *
 *   MyApp
 *     Scaffold
 *       uid=12 Text "0"
 *       uid=7 FloatingActionButton
 *
 * Only nodes with a derivable finder get a uid. The `[root]` wrapper is
 * dropped. Depth is re-based so the first rendered node starts at indent 0.
 */
export function renderWidgetTree(root: WidgetNode): RenderedTree {
  const finders = deriveFinders(root);
  const lines: string[] = [];
  let title = "";

  const emit = (node: WidgetNode, depth: number, inAppBar: boolean) => {
    const isRoot = node.type === "RootWidget" || node.description === "[root]";
    let childDepth = depth;
    if (!isRoot) {
      const indent = "  ".repeat(depth);
      const uidPart = finders[node.uid] ? `uid=${node.uid} ` : "";
      const keyPart = node.keyValue !== null ? ` key='${node.keyValue}'` : "";
      const textPart = node.text !== null ? ` "${node.text}"` : "";
      lines.push(`${indent}${uidPart}${node.type}${keyPart}${textPart}`);
      if (!title && node.text !== null && (inAppBar || depth <= 1)) {
        title = node.text;
      }
      childDepth = depth + 1;
    }
    const childInAppBar = inAppBar || node.type === "AppBar";
    for (const child of node.children) emit(child, childDepth, childInAppBar);
  };

  // Prefer an AppBar text as the title: walk once to find it.
  for (const n of flattenTree(root)) {
    if (n.type === "AppBar") {
      const texts = flattenTree(n).filter((c) => c.text !== null);
      if (texts.length > 0) title = texts[0].text as string;
      break;
    }
  }

  emit(root, 0, false);

  return {
    text: lines.join("\n"),
    refs: finders,
    refCount: Object.keys(finders).length,
    title,
  };
}

export interface RefSummary {
  uid: string;
  type: string;
  text: string | null;
}

/** List the referenced (interactive) nodes of a tree - used by suggestions. */
export function listRefs(root: WidgetNode): RefSummary[] {
  const finders = deriveFinders(root);
  return flattenTree(root)
    .filter((n) => finders[n.uid])
    .map((n) => ({ uid: n.uid, type: n.type, text: n.text }));
}
