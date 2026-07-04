import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  deriveFinders,
  flattenTree,
  listRefs,
  parseKeyFromDescription,
  parseWidgetTree,
  renderWidgetTree,
} from "../src/widgettree.js";

const FIXTURE = readFileSync(
  join(import.meta.dirname, "fixtures", "widget-tree-counter.json"),
  "utf-8",
);

describe("parseWidgetTree (captured counter-app fixture)", () => {
  it("parses the inspector JSON into nodes", () => {
    const root = parseWidgetTree(FIXTURE);
    const flat = flattenTree(root);
    expect(flat.map((n) => n.type)).toContain("FloatingActionButton");
    const counter = flat.find((n) => n.text === "0");
    expect(counter?.type).toBe("Text");
    expect(counter?.uid).toBe("12");
  });

  it("throws on malformed input", () => {
    expect(() => parseWidgetTree("not json")).toThrow();
  });
});

describe("parseKeyFromDescription", () => {
  it("extracts string ValueKeys", () => {
    expect(parseKeyFromDescription("Text-[<'counter'>]")).toBe("counter");
    expect(parseKeyFromDescription("Text")).toBeNull();
    expect(parseKeyFromDescription("Text-[<3>]")).toBeNull();
  });
});

describe("deriveFinders", () => {
  it("prefers ValueKey, then unique text, then unique type", () => {
    const root = parseWidgetTree(
      JSON.stringify({
        description: "[root]",
        widgetRuntimeType: "RootWidget",
        valueId: "inspector-0",
        children: [
          {
            description: "ElevatedButton-[<'submit'>]",
            widgetRuntimeType: "ElevatedButton",
            valueId: "inspector-1",
            children: [],
          },
          {
            description: "Text",
            widgetRuntimeType: "Text",
            valueId: "inspector-2",
            textPreview: "unique text",
            children: [],
          },
          {
            description: "Text",
            widgetRuntimeType: "Text",
            valueId: "inspector-3",
            textPreview: "dup",
            children: [],
          },
          {
            description: "Text",
            widgetRuntimeType: "Text",
            valueId: "inspector-4",
            textPreview: "dup",
            children: [],
          },
          {
            description: "ListView",
            widgetRuntimeType: "ListView",
            valueId: "inspector-5",
            children: [],
          },
        ],
      }),
    );
    const finders = deriveFinders(root);
    expect(finders["1"]).toEqual({
      finderType: "ByValueKey",
      keyValueString: "submit",
      keyValueType: "String",
    });
    expect(finders["2"]).toEqual({ finderType: "ByText", text: "unique text" });
    // Duplicated text, non-unique type -> no uid.
    expect(finders["3"]).toBeUndefined();
    expect(finders["4"]).toBeUndefined();
    expect(finders["5"]).toEqual({ finderType: "ByType", type: "ListView" });
  });

  it("suppresses structural types even when unique", () => {
    const finders = deriveFinders(parseWidgetTree(FIXTURE));
    const types = Object.values(finders).map((f) => f.type);
    expect(types).not.toContain("Scaffold");
    expect(types).not.toContain("Column");
  });
});

describe("renderWidgetTree (fixture)", () => {
  it("renders an indented uid snapshot with a registry to match", () => {
    const rendered = renderWidgetTree(parseWidgetTree(FIXTURE));
    expect(rendered.text).toContain('uid=12 Text "0"');
    expect(rendered.text).toContain("uid=7 FloatingActionButton");
    // Structural nodes render without uid.
    expect(rendered.text).toMatch(/^\s*Scaffold$/m);
    // Every uid in the text exists in the registry.
    for (const m of rendered.text.matchAll(/uid=(\S+)/g)) {
      expect(rendered.refs[m[1]]).toBeDefined();
    }
    expect(rendered.refCount).toBe(Object.keys(rendered.refs).length);
    expect(rendered.title).toBe("Flutter Demo Home Page");
  });

  it("drops the [root] wrapper", () => {
    const rendered = renderWidgetTree(parseWidgetTree(FIXTURE));
    expect(rendered.text).not.toContain("[root]");
    expect(rendered.text.split("\n")[0]).toContain("MyApp");
  });
});

describe("listRefs", () => {
  it("lists only nodes with finders", () => {
    const refs = listRefs(parseWidgetTree(FIXTURE));
    expect(refs.length).toBeGreaterThan(0);
    expect(refs.every((r) => r.uid.length > 0)).toBe(true);
    expect(refs.some((r) => r.type === "FloatingActionButton")).toBe(true);
  });
});
