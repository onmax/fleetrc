import { describe, expect, it } from "vite-plus/test";
import { editJsonText } from "../src/jsonedit.ts";

/** Applies `change` to the parsed text and returns the edited text, which must parse to the result. */
function edit(text: string, change: (raw: Record<string, unknown>) => void) {
  const before = JSON.parse(text) as Record<string, unknown>;
  const after = JSON.parse(text) as Record<string, unknown>;
  change(after);
  const out = editJsonText(text, before, after);
  expect(out).toBeDefined();
  expect(JSON.parse(out!)).toEqual(after);
  return out!;
}

describe("editJsonText", () => {
  it("returns undefined when valid JSON is too deeply nested for an offset tree", () => {
    const depth = 12_000;
    const text = `{"keep":${"[".repeat(depth)}0${"]".repeat(depth)},"remove":true}`;
    const before = JSON.parse(text) as Record<string, unknown>;
    expect(editJsonText(text, before, { keep: before.keep })).toBeUndefined();
  });

  it("appends to a one-line array on the same line", () => {
    const text = `{\n  "agents": ["claude-code"],\n  "sources": [{ "id": "a", "git": "x" }]\n}\n`;
    expect(
      edit(text, (raw) => {
        raw.sources = [...(raw.sources as unknown[]), { id: "b", git: "y" }];
      }),
    ).toBe(
      `{\n  "agents": ["claude-code"],\n  "sources": [{ "id": "a", "git": "x" }, { "id": "b", "git": "y" }]\n}\n`,
    );
  });

  it("appends to a multi-line array as its items are laid out", () => {
    const text = `{\n  "sources": [\n    {\n      "id": "a",\n      "git": "x"\n    }\n  ],\n  "fleet": [\n    "one"\n  ]\n}\n`;
    expect(
      edit(text, (raw) => {
        raw.sources = [...(raw.sources as unknown[]), { id: "b", git: "y" }];
        raw.fleet = ["one", "two"];
      }),
    ).toBe(
      `{\n  "sources": [\n    {\n      "id": "a",\n      "git": "x"\n    },\n    {\n      "id": "b",\n      "git": "y"\n    }\n  ],\n  "fleet": [\n    "one",\n    "two"\n  ]\n}\n`,
    );
  });

  it("adds a member to an object, and fills an empty array", () => {
    const text = `{\n  "agents": "all",\n  "sources": []\n}\n`;
    expect(
      edit(text, (raw) => {
        raw.sources = [{ id: "b", git: "y" }];
        raw.fleet = ["h"];
      }),
    ).toBe(
      `{\n  "agents": "all",\n  "sources": [\n    {\n      "id": "b",\n      "git": "y"\n    }\n  ],\n  "fleet": ["h"]\n}\n`,
    );
  });

  it("removes items with their commas, and edits nested values in place", () => {
    const text = `{\n  "sources": [\n    { "id": "a", "git": "x" },\n    { "id": "b", "git": "y", "exclude": ["k"] },\n    { "id": "c", "git": "z" }\n  ],\n  "fleet": ["h"]\n}\n`;
    const removed = edit(text, (raw) => {
      raw.sources = (raw.sources as Record<string, unknown>[]).filter((s) => s.id === "b");
      delete raw.fleet;
    });
    expect(removed).toBe(
      `{\n  "sources": [\n    { "id": "b", "git": "y", "exclude": ["k"] }\n  ]\n}\n`,
    );
    expect(
      edit(removed, (raw) => {
        (raw.sources as Record<string, unknown>[])[0]!.exclude = ["k", "l"];
      }),
    ).toBe(`{\n  "sources": [\n    { "id": "b", "git": "y", "exclude": ["k", "l"] }\n  ]\n}\n`);
  });

  it("keeps CRLF line endings and tabs", () => {
    const text = `{\r\n\t"sources": [\r\n\t\t{ "id": "a", "git": "x" }\r\n\t]\r\n}\r\n`;
    expect(
      edit(text, (raw) => {
        raw.sources = [...(raw.sources as unknown[]), { id: "b", git: "y" }];
      }),
    ).toBe(
      `{\r\n\t"sources": [\r\n\t\t{ "id": "a", "git": "x" },\r\n\t\t{ "id": "b", "git": "y" }\r\n\t]\r\n}\r\n`,
    );
  });

  it("gives up on text it can't follow, so the caller writes the whole file", () => {
    const text = `{ "sources": [] } // note`;
    expect(editJsonText(text, { sources: [] }, { sources: [1] })).toBeUndefined();
  });
});
