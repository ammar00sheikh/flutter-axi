import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  parseDriverResponse,
  resolveFinderArg,
} from "../src/actions.js";
import { FlutterAxiError } from "../src/client.js";
import { bumpGeneration } from "../src/generation.js";
import { writeRefs } from "../src/refs.js";

let tmpHome: string;
let savedHome: string | undefined;

beforeEach(() => {
  savedHome = process.env.HOME;
  tmpHome = mkdtempSync(join(tmpdir(), "flutter-axi-actions-"));
  process.env.HOME = tmpHome;
});

afterEach(() => {
  if (savedHome === undefined) delete process.env.HOME;
  else process.env.HOME = savedHome;
  rmSync(tmpHome, { recursive: true, force: true });
});

describe("parseDriverResponse (captured formats)", () => {
  it("returns the response payload on success", () => {
    expect(
      parseDriverResponse(
        '{"isError":false,"response":{"status":"ok"},"type":"_extensionType","method":"ext.flutter.driver"}',
      ),
    ).toEqual({ status: "ok" });
    expect(
      parseDriverResponse('{"isError":false,"response":{"text":"1"}}'),
    ).toEqual({ text: "1" });
  });

  it("throws DRIVER_ERROR with the first line of a driver error", () => {
    try {
      parseDriverResponse(
        '{"isError":true,"response":"Uncaught extension error while executing get_text: boom\\n#0 stack..."}',
      );
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(FlutterAxiError);
      expect((error as FlutterAxiError).code).toBe("DRIVER_ERROR");
      expect((error as FlutterAxiError).message).not.toContain("#0");
    }
  });

  it("passes through non-JSON output", () => {
    expect(parseDriverResponse("plain text")).toBe("plain text");
  });
});

describe("resolveFinderArg", () => {
  it("resolves finder strings without touching state", () => {
    expect(resolveFinderArg("text:Accept")).toEqual({
      finderType: "ByText",
      text: "Accept",
    });
  });

  it("resolves current-generation uids from the registry", () => {
    const generation = bumpGeneration();
    writeRefs(generation, { "12": { finderType: "ByText", text: "0" } });
    expect(resolveFinderArg(`@g${generation}:12`)).toEqual({
      finderType: "ByText",
      text: "0",
    });
  });

  it("throws STALE_REF for old generations", () => {
    bumpGeneration();
    const generation = bumpGeneration();
    writeRefs(generation, { "12": { finderType: "ByText", text: "0" } });
    try {
      resolveFinderArg("@g1:12");
      expect.unreachable();
    } catch (error) {
      expect((error as FlutterAxiError).code).toBe("STALE_REF");
      expect((error as FlutterAxiError).suggestions.join(" ")).toContain(
        "snapshot",
      );
    }
  });

  it("throws REF_NOT_FOUND for unknown uids", () => {
    const generation = bumpGeneration();
    writeRefs(generation, {});
    try {
      resolveFinderArg(`@g${generation}:99`);
      expect.unreachable();
    } catch (error) {
      expect((error as FlutterAxiError).code).toBe("REF_NOT_FOUND");
    }
  });
});
