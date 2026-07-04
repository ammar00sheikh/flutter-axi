import { describe, expect, it, beforeEach, afterEach } from "vitest";
import {
  TOP_HELP,
  extractAppFlag,
  getCommandHelp,
  main,
  parseFlags,
} from "../src/cli.js";

const savedSession = process.env.FLUTTER_AXI_SESSION;

afterEach(() => {
  if (savedSession === undefined) delete process.env.FLUTTER_AXI_SESSION;
  else process.env.FLUTTER_AXI_SESSION = savedSession;
  process.exitCode = 0;
});

function capture(): { stdout: { write: (c: string) => boolean }; text: () => string } {
  let buffer = "";
  return {
    stdout: {
      write(chunk: string) {
        buffer += chunk;
        return true;
      },
    },
    text: () => buffer,
  };
}

describe("TOP_HELP / per-command help", () => {
  const COMMANDS = [
    "devices",
    "launch",
    "attach",
    "apps",
    "stopapp",
    "snapshot",
    "tap",
    "fill",
    "type",
    "press",
    "scroll",
    "scrollinto",
    "back",
    "text",
    "wait",
    "waitfor",
    "reload",
    "restart",
    "logs",
    "errors",
    "screenshot",
    "gps",
    "permission",
    "deeplink",
    "push",
    "applifecycle",
    "run",
    "start",
    "stop",
    "setup",
  ];

  it("documents every command in TOP_HELP", () => {
    for (const command of COMMANDS) {
      expect(TOP_HELP).toContain(command);
    }
  });

  it("has per-command help for every registered command", () => {
    for (const command of COMMANDS) {
      const help = getCommandHelp(command);
      expect(help, `help for ${command}`).toBeTruthy();
      expect(help).toContain(`flutter-axi ${command}`);
    }
  });

  it("returns null for unknown commands", () => {
    expect(getCommandHelp("bogus")).toBeNull();
  });
});

describe("extractAppFlag", () => {
  beforeEach(() => {
    delete process.env.FLUTTER_AXI_SESSION;
  });

  it("strips --app <name> anywhere in argv and exports the session", () => {
    expect(extractAppFlag(["--app", "driver", "snapshot"])).toEqual([
      "snapshot",
    ]);
    expect(process.env.FLUTTER_AXI_SESSION).toBe("driver");
    expect(extractAppFlag(["tap", "@g1:2", "--app", "user"])).toEqual([
      "tap",
      "@g1:2",
    ]);
    expect(process.env.FLUTTER_AXI_SESSION).toBe("user");
  });

  it("leaves argv untouched without the flag", () => {
    expect(extractAppFlag(["snapshot", "--full"])).toEqual([
      "snapshot",
      "--full",
    ]);
    expect(process.env.FLUTTER_AXI_SESSION).toBeUndefined();
  });
});

describe("parseFlags", () => {
  it("splits positionals, value flags, bool flags, repeated flags", () => {
    const parsed = parseFlags(
      ["grant", "location", "--app-id", "com.x", "--os", "--data", "a=1", "--data", "b=2"],
      ["--app-id", "--data"],
      ["--os"],
    );
    expect(parsed.positional).toEqual(["grant", "location"]);
    expect(parsed.values["app-id"]).toBe("com.x");
    expect(parsed.bools["os"]).toBe(true);
    expect(parsed.repeated["data"]).toEqual(["a=1", "b=2"]);
  });
});

describe("main", () => {
  it("renders top-level help", async () => {
    const cap = capture();
    await main({ argv: ["--help"], stdout: cap.stdout });
    expect(cap.text()).toContain("usage: flutter-axi");
    expect(cap.text()).toContain("--app <name>");
  });

  it("renders version", async () => {
    const cap = capture();
    await main({ argv: ["-v"], stdout: cap.stdout });
    expect(cap.text().trim()).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it("renders per-command help without a bridge", async () => {
    const cap = capture();
    await main({ argv: ["tap", "--help"], stdout: cap.stdout });
    expect(cap.text()).toContain("usage: flutter-axi tap");
  });

  it("rejects unknown commands with exit code 2", async () => {
    const cap = capture();
    await main({ argv: ["bogus"], stdout: cap.stdout });
    expect(cap.text()).toContain("Unknown command: bogus");
    expect(process.exitCode).toBe(2);
  });

  it("rejects validation errors with exit code 2 without a bridge", async () => {
    const cap = capture();
    await main({ argv: ["wait"], stdout: cap.stdout });
    expect(cap.text()).toContain("VALIDATION_ERROR");
    expect(process.exitCode).toBe(2);
  });
});
