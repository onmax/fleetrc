// schema.json documents the manifest for editors; the parser is what enforces it. They must agree.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vite-plus/test";
import { parseManifest } from "../src/manifest.ts";

interface Schema {
  properties: Record<string, unknown>;
  $defs: { source: { oneOf: { required: string[]; properties: Record<string, unknown> }[] } };
}
const schema = JSON.parse(readFileSync("schema.json", "utf8")) as Schema;

const samples: Record<string, unknown> = {
  $schema: "https://unpkg.com/skillfleet/schema.json",
  extends: ["./team.json"],
  agents: "all",
  sources: [],
  forks: { x: { from: "a/b", path: "skills/x", base: "abc" } },
  hooks: [{ name: "h", run: "true", on: ["personal:**"] }],
  fleet: ["host"],
  hub: "https://hub.example",
  report: { run: "true" },
  timer: { cron: "0 * * * *", timeZone: "UTC" },
};

const sourceSamples: Record<string, unknown> = {
  id: "x",
  skills: "skills/*",
  include: ["a"],
  exclude: ["b"],
  update: "review",
  git: "a/b",
  ref: "main",
  path: "/tmp/x",
  adopt: true,
  index: "https://example.com",
  npm: "pkg",
  registry: "https://registry.example",
  local: "/tmp/y",
};

describe("schema.json", () => {
  it("lists exactly the root fields the parser accepts", () => {
    for (const key of Object.keys(schema.properties))
      expect(() => parseManifest("m.json", { [key]: samples[key] }), key).not.toThrow();
    expect(() => parseManifest("m.json", { unknown: 1 })).toThrow(
      "unknown is not a manifest field",
    );
    expect(Object.keys(schema.properties).sort()).toEqual(Object.keys(samples).sort());
  });

  it("lists exactly the source fields the parser accepts for each kind", () => {
    for (const variant of schema.$defs.source.oneOf) {
      const kind = variant.required[0]!;
      const source = Object.fromEntries(
        Object.keys(variant.properties).map((key) => [key, sourceSamples[key]]),
      );
      expect(() => parseManifest("m.json", { sources: [source] }), kind).not.toThrow();
      for (const key of Object.keys(sourceSamples)) {
        if (key in variant.properties) continue;
        expect(
          () => parseManifest("m.json", { sources: [{ ...source, [key]: sourceSamples[key] }] }),
          `${kind}.${key}`,
        ).toThrow();
      }
    }
  });
});
