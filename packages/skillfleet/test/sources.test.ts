import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vite-plus/test";
import {
  http,
  isLink,
  linkOf,
  machine,
  names,
  publishNpm,
  read,
  serveIndexV1,
  serveIndexV2,
  skillMd,
  tgz,
  sha256,
} from "./fixture.ts";

describe("well-known index", () => {
  it("6a. installs skills whose archive matches the digest, from v0.2.0 and v0.1 indexes", async () => {
    const m = machine();
    const v2 = await http();
    serveIndexV2(v2, [
      {
        name: "archived",
        files: { "SKILL.md": skillMd("archived"), "scripts/run.sh": "echo hi\n" },
      },
      { name: "second", files: { "SKILL.md": skillMd("second") } },
    ]);
    const v1 = await http();
    serveIndexV1(v1, [
      { name: "legacy", files: { "SKILL.md": skillMd("legacy"), "extra.md": "extra\n" } },
    ]);
    const manifest = m.manifest({
      agents: ["claude-code", "cursor"],
      sources: [
        { id: "drop", index: v2.url, exclude: ["second"] },
        { id: "old", index: v1.url },
      ],
    });
    const init = await m.run("init", manifest, "--no-timer");
    expect(init.code, init.stdout + init.stderr).toBe(0);
    expect(names(m.at(".claude/skills"))).toEqual(["archived", "legacy"]);
    expect(read(m.at(".cursor/skills/archived/scripts/run.sh"))).toBe("echo hi\n");
    expect(read(m.at(".claude/skills/legacy/extra.md"))).toBe("extra\n");
  });

  it("6b. rejects a tampered archive and keeps the last good copy", async () => {
    const m = machine();
    const site = await http();
    serveIndexV2(site, [{ name: "signed", files: { "SKILL.md": skillMd("signed") } }]);
    const manifest = m.manifest({
      agents: ["claude-code"],
      sources: [{ id: "site", index: site.url }],
    });
    expect((await m.run("init", manifest, "--no-timer")).code).toBe(0);
    expect(read(m.at(".claude/skills/signed/SKILL.md"))).toBe(skillMd("signed"));

    serveIndexV2(site, [
      { name: "signed", files: { "SKILL.md": skillMd("signed", "v2") }, tamper: true },
    ]);
    const result = await m.run("sync", "--json");
    expect(result.code).toBe(1);
    const report = JSON.parse(result.stdout) as { errors: string[]; warnings: string[] };
    expect(report.errors.join("\n")).toMatch(/digest/i);
    expect(report.warnings.join("\n")).toContain("kept the last good copy");
    expect(read(m.at(".claude/skills/signed/SKILL.md"))).toBe(skillMd("signed"));
  });

  it("6c. rejects an archive entry that escapes the skill folder", async () => {
    const m = machine();
    const site = await http();
    serveIndexV2(site, [{ name: "good", files: { "SKILL.md": skillMd("good") } }]);
    // An archive whose digest matches but that writes ../escaped.md.
    const evil = tgz({ "SKILL.md": skillMd("evil"), "../escaped.md": "outside\n" });
    site.routes.set("/.well-known/agent-skills/evil.tar.gz", {
      body: evil,
      type: "application/gzip",
    });
    const index = JSON.parse(
      String(site.routes.get("/.well-known/agent-skills/index.json")!.body),
    ) as { skills: object[] };
    index.skills.push({
      name: "evil",
      type: "archive",
      description: "The evil skill",
      url: "evil.tar.gz",
      digest: `sha256:${sha256(evil)}`,
    });
    site.routes.set("/.well-known/agent-skills/index.json", {
      body: JSON.stringify(index),
      type: "application/json",
    });
    const manifest = m.manifest({
      agents: ["claude-code"],
      sources: [{ id: "site", index: site.url }],
    });
    const init = await m.run("init", manifest, "--no-timer");
    expect(init.code, init.stdout + init.stderr).toBe(0);
    expect(names(m.at(".claude/skills"))).toEqual(["good"]);
    expect(init.stdout).toContain('site: rejected "evil"');
    expect(names(join(m.stateDir, "store", "site"))).not.toContain("escaped.md");
    expect(names(m.at(".claude"))).not.toContain("escaped.md");
  });

  it("6d. keeps the last good copy with a warning when the index is unreachable or --offline is set", async () => {
    const m = machine();
    const site = await http();
    serveIndexV2(site, [{ name: "cached", files: { "SKILL.md": skillMd("cached") } }]);
    const manifest = m.manifest({
      agents: ["claude-code"],
      sources: [{ id: "site", index: site.url }],
    });
    expect((await m.run("init", manifest, "--no-timer")).code).toBe(0);
    await site.close();

    const down = await m.run("sync");
    expect(down.code).toBe(1);
    expect(down.stdout).toContain("warning: site: kept the last good copy");
    expect(read(m.at(".claude/skills/cached/SKILL.md"))).toBe(skillMd("cached"));
    expect(isLink(m.at(".claude/skills/cached"))).toBe(true);

    const offline = await m.json("sync", "--offline");
    expect(offline.ok).toBe(true);
    expect(offline.sources[0]!.status).toBe("offline");
    expect(names(m.at(".claude/skills"))).toEqual(["cached"]);
  });
});

describe("npm and local sources", () => {
  it("7a. installs skills from an npm package and follows its dist-tag", async () => {
    const m = machine();
    const registry = await http();
    publishNpm(
      registry,
      "@acme/skills",
      {
        "1.0.0": { "skills/npm-skill/SKILL.md": skillMd("npm-skill", "v1") },
        "1.1.0": {
          "skills/npm-skill/SKILL.md": skillMd("npm-skill", "v1.1"),
          "skills/npm-extra/SKILL.md": skillMd("npm-extra"),
        },
      },
      "1.0.0",
    );
    const manifest = m.manifest({
      agents: ["claude-code", "opencode"],
      sources: [{ id: "acme", npm: "@acme/skills", registry: registry.url }],
    });
    const init = await m.run("init", manifest, "--no-timer");
    expect(init.code, init.stdout + init.stderr).toBe(0);
    expect(names(m.at(".config/opencode/skills"))).toEqual(["npm-skill"]);
    expect(read(m.at(".claude/skills/npm-skill/SKILL.md"))).toBe(skillMd("npm-skill", "v1"));

    publishNpm(
      registry,
      "@acme/skills",
      {
        "1.0.0": { "skills/npm-skill/SKILL.md": skillMd("npm-skill", "v1") },
        "1.1.0": {
          "skills/npm-skill/SKILL.md": skillMd("npm-skill", "v1.1"),
          "skills/npm-extra/SKILL.md": skillMd("npm-extra"),
        },
      },
      "1.1.0",
    );
    const report = await m.json("sync");
    expect(report.ok).toBe(true);
    expect(report.sources[0]).toMatchObject({ status: "updated", from: "1.0.0", to: "1.1.0" });
    expect(names(m.at(".claude/skills"))).toEqual(["npm-extra", "npm-skill"]);
    expect(read(m.at(".claude/skills/npm-skill/SKILL.md"))).toBe(skillMd("npm-skill", "v1.1"));
  });

  it("7b. rejects an npm tarball whose integrity does not match", async () => {
    const m = machine();
    const registry = await http();
    publishNpm(registry, "bad-pkg", { "1.0.0": { "skills/x/SKILL.md": skillMd("x") } }, "1.0.0");
    registry.routes.set("/bad-pkg-1.0.0.tgz", {
      body: tgz({ "package/skills/x/SKILL.md": skillMd("x", "swapped") }),
      type: "application/octet-stream",
    });
    const manifest = m.manifest({
      agents: ["claude-code"],
      sources: [{ npm: "bad-pkg", registry: registry.url }],
    });
    const init = await m.run("init", manifest, "--no-timer");
    expect(init.stdout).toContain("integrity mismatch");
    expect(names(m.at(".claude/skills"))).toEqual([]);
  });

  it("7c. links a local folder in place, and picks up new skills in it", async () => {
    const m = machine();
    const folder = join(m.root, "my-skills");
    mkdirSync(join(folder, "local-one"), { recursive: true });
    writeFileSync(join(folder, "local-one/SKILL.md"), skillMd("local-one"));
    const manifest = m.manifest({
      agents: ["claude-code", "github-copilot"],
      sources: [{ id: "here", local: folder }],
    });
    expect((await m.run("init", manifest, "--no-timer")).code).toBe(0);
    expect(linkOf(m.at(".copilot/skills/local-one"))).toBe(join(folder, "local-one"));
    mkdirSync(join(folder, "local-two"));
    writeFileSync(join(folder, "local-two/SKILL.md"), skillMd("local-two"));
    const report = await m.json("sync");
    expect(report.skills.added).toEqual(["local-two"]);
    expect(names(m.at(".claude/skills"))).toEqual(["local-one", "local-two"]);
  });
});
