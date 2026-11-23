import {
  chmodSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readlinkSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, relative } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vite-plus/test";
import type { Report } from "../src/report.ts";
import {
  AGENT_DIRS,
  clone,
  isLink,
  isWindows,
  linkOf,
  machine,
  type Machine,
  names,
  read,
  remote,
  skillMd,
  skills,
  writeFiles,
} from "./fixture.ts";

const linkKind = isWindows ? "junction" : "dir";

/** Every path under `dir` with what it is, so a dry run can be shown to change nothing. */
function snapshot(dir: string): string[] {
  const out: string[] = [];
  const walk = (current: string) => {
    for (const name of readdirSync(current).sort()) {
      const path = join(current, name);
      const rel = relative(dir, path);
      if (rel === ".git" || rel.includes(`${join(".git", "")}`)) continue;
      if (isLink(path)) out.push(`${rel} -> ${readlinkSync(path)}`);
      else if (statSync(path).isDirectory()) {
        out.push(`${rel}/`);
        walk(path);
      } else out.push(`${rel} ${read(path).length}`);
    }
  };
  walk(dir);
  return out;
}

/**
 * Today's layout on Maxi's machines: ~/.claude/skills and ~/.agents/skills are links to the whole
 * skills folder of the personal clone, and ~/.codex/skills is a real folder with links into that
 * clone, copies an old installer listed in .nuxt-skills-managed, a stray hand-made skill and .system.
 */
function legacyLayout(m: Machine) {
  const personal = remote(m, "skills-private", {
    ...skills("skills/", "check-your-work", "council", "unslop"),
    "skills-lock.json": JSON.stringify({
      version: 1,
      skills: {
        council: {
          source: "t3dotgg/tstack",
          sourceType: "github",
          skillPath: "skills/council/SKILL.md",
          computedHash: "abc",
        },
      },
    }),
  });
  const work = clone(m, personal, "onmax/skills");
  const nuxt = remote(m, "nuxt-skills", skills("skills/", "nuxt", "vue"));
  symlinkSync(join(work, "skills"), m.at(".claude/skills"), linkKind);
  mkdirSync(m.at(".agents"), { recursive: true });
  symlinkSync(join(work, "skills"), m.at(".agents/skills"), linkKind);
  const codex = m.at(".codex/skills");
  mkdirSync(join(codex, ".system/skill-creator"), { recursive: true });
  writeFileSync(join(codex, ".system/skill-creator/SKILL.md"), skillMd("skill-creator"));
  symlinkSync(join(work, "skills/unslop"), join(codex, "unslop"), linkKind);
  for (const name of ["nuxt", "vue"]) {
    mkdirSync(join(codex, name));
    writeFileSync(join(codex, name, "SKILL.md"), skillMd(name, "old copy"));
  }
  writeFileSync(join(codex, ".nuxt-skills-managed"), "nuxt\nvue\n");
  mkdirSync(join(codex, "conversation-video"));
  writeFileSync(join(codex, "conversation-video/SKILL.md"), skillMd("conversation-video"));
  const manifest = m.manifest({
    agents: "all",
    sources: [
      { id: "personal", git: personal.url, path: work, skills: "skills/*", adopt: true },
      { id: "nuxt", git: nuxt.url },
    ],
  });
  return { work, manifest, codex };
}

describe("init", () => {
  it("previews skill replacements using saved copy mode and explicit overrides", async () => {
    const m = machine();
    const repo = remote(m, "mine", skills("skills/", "example"));
    const working = clone(m, repo, "mine");
    const manifest = m.manifest({
      agents: ["claude-code"],
      sources: [{ id: "mine", git: repo.url, path: working }],
    });
    await m.json("init", manifest, "--no-hooks", "--copy");
    const replaced = (sync: Report) => sync.targets.flatMap((target) => target.replaced);
    for (const flags of [[], ["--copy"], ["--no-copy"]]) {
      const preview = await m.json<{ sync: Report }>(
        "init",
        manifest,
        "--no-hooks",
        "--dry-run",
        ...flags,
      );
      expect(preview.sync.ok).toBe(true);
      expect(replaced(preview.sync)).toEqual(flags.includes("--no-copy") ? ["example"] : []);
    }
    const applied = await m.json<{ sync: Report }>("init", manifest, "--no-hooks");
    expect(replaced(applied.sync)).toEqual([]);
  });

  it("flags a copied skill update whose destinations the preview cannot establish", async () => {
    const machineSetup = machine();
    const repo = remote(machineSetup, "upstream-skills", skills("skills/", "example"));
    const manifest = machineSetup.manifest({
      agents: ["claude-code", "codex"],
      sources: [{ id: "shared", git: repo.url }],
    });
    await machineSetup.json("init", manifest, "--no-hooks", "--copy");
    const preview = async () => {
      const { sync } = await machineSetup.json<{ sync: Report }>(
        "init",
        manifest,
        "--no-hooks",
        "--dry-run",
      );
      return sync;
    };
    expect(await preview()).toMatchObject({ ok: true, previewLimitations: [] });

    const updated = skillMd("example", "incoming update");
    repo.commit({ "skills/example/SKILL.md": updated });
    const destinations = [
      machineSetup.at(".claude/skills/example/SKILL.md"),
      machineSetup.at(".agents/skills/example/SKILL.md"),
    ];
    for (let attempt = 0; attempt < 2; attempt++) {
      const report = await preview();
      expect(report.ok).toBe(true);
      expect(report.skills.updated).toEqual(["example"]);
      expect(report.targets.flatMap((target) => target.replaced)).toEqual([]);
      expect(report).toMatchObject({ previewLimitations: [expect.stringContaining("example")] });
      for (const path of destinations) expect(read(path)).not.toBe(updated);
    }
    await machineSetup.json("init", manifest, "--no-hooks");
    for (const path of destinations) expect(read(path)).toBe(updated);
    expect(await preview()).toMatchObject({ ok: true, previewLimitations: [] });
  });

  it("flags copy-edit adoption that would propagate to another agent", async () => {
    const machineSetup = machine();
    const repo = remote(machineSetup, "mine", { "instructions.md": "original\n" });
    const working = clone(machineSetup, repo, "mine");
    const manifest = machineSetup.manifest({
      agents: ["claude-code", "codex"],
      sources: [{ id: "mine", git: repo.url, path: working, instructions: "instructions.md" }],
    });
    await machineSetup.json("init", manifest, "--no-hooks", "--copy");
    const edited = machineSetup.at(".claude/CLAUDE.md");
    const other = machineSetup.at(".codex/AGENTS.md");
    writeFileSync(edited, "local edit\n");
    for (let attempt = 0; attempt < 2; attempt++) {
      const { sync } = await machineSetup.json<{ sync: Report }>(
        "init",
        manifest,
        "--no-hooks",
        "--dry-run",
      );
      expect(sync.ok).toBe(true);
      expect(sync.files.replaced).toEqual([]);
      expect(sync).toMatchObject({ previewLimitations: [expect.stringContaining("CLAUDE.md")] });
      expect(read(join(working, "instructions.md"))).toBe("original\n");
      expect(read(other)).toBe("original\n");
    }
    const { sync } = await machineSetup.json<{ sync: Report }>("init", manifest, "--no-hooks");
    expect(sync.files.replaced).toEqual([other]);
    expect(read(other)).toBe("local edit\n");
  });

  it("flags a working clone update before and after fetching it", async () => {
    const setup = machine();
    const originalSkill = skillMd("example");
    const repo = remote(setup, "mine", {
      "skills/example/SKILL.md": originalSkill,
      "instructions.md": "original\n",
    });
    const working = clone(setup, repo, "mine");
    const manifest = setup.manifest({
      agents: ["claude-code", "codex"],
      sources: [{ id: "mine", git: repo.url, path: working, instructions: "instructions.md" }],
    });
    await setup.json("init", manifest, "--no-hooks", "--copy");
    const preview = async () => {
      const { sync } = await setup.json<{ sync: Report }>(
        "init",
        manifest,
        "--no-hooks",
        "--dry-run",
      );
      return sync;
    };
    expect(await preview()).toMatchObject({ ok: true, previewLimitations: [] });
    const before = setup.git(working, "rev-parse", "HEAD");
    const updatedSkill = skillMd("example", "incoming update");
    const incoming = repo.commit({
      "skills/example/SKILL.md": updatedSkill,
      "instructions.md": "updated\n",
    });
    const skillCopies = [
      setup.at(".claude/skills/example/SKILL.md"),
      setup.at(".agents/skills/example/SKILL.md"),
    ];
    const fileCopies = [setup.at(".claude/CLAUDE.md"), setup.at(".codex/AGENTS.md")];
    for (const trackingTip of [before, incoming]) {
      expect(await preview()).toMatchObject({
        ok: true,
        previewLimitations: [expect.stringContaining("working clone")],
      });
      expect(setup.git(working, "rev-parse", "HEAD")).toBe(before);
      expect(setup.git(working, "rev-parse", "@{u}")).toBe(trackingTip);
      for (const path of skillCopies) expect(read(path)).toBe(originalSkill);
      for (const path of fileCopies) expect(read(path)).toBe("original\n");
      if (trackingTip === before) setup.git(working, "fetch", "--quiet");
    }
    await setup.json("init", manifest, "--no-hooks");
    expect(setup.git(working, "rev-parse", "HEAD")).toBe(incoming);
    for (const path of skillCopies) expect(read(path)).toBe(updatedSkill);
    for (const path of fileCopies) expect(read(path)).toBe("updated\n");
    expect(await preview()).toMatchObject({ ok: true, previewLimitations: [] });
  });

  it("previews a published working clone without refreshing its stale tracking ref", async () => {
    const setup = machine();
    const repo = remote(setup, "mine", { "instructions.md": "original\n" });
    const working = clone(setup, repo, "mine");
    const manifest = setup.manifest({
      agents: ["claude-code"],
      sources: [{ id: "mine", git: repo.url, path: working, instructions: "instructions.md" }],
    });
    const cached = setup.git(working, "rev-parse", "@{u}");
    writeFileSync(join(working, "instructions.md"), "published\n");
    setup.git(working, "add", "instructions.md");
    setup.git(working, "commit", "--quiet", "-m", "Publish setup");
    const published = setup.git(working, "rev-parse", "HEAD");
    setup.git(working, "push", "--quiet", pathToFileURL(repo.url).href, "HEAD:refs/heads/main");

    const args = ["init", manifest, "--no-hooks", "--copy"];
    const { sync: preview } = await setup.json<{ sync: Report }>(...args, "--dry-run");
    expect(setup.git(working, "rev-parse", "HEAD")).toBe(published);
    expect(setup.git(working, "rev-parse", "@{u}")).toBe(cached);
    expect(existsSync(setup.at(".claude/CLAUDE.md"))).toBe(false);

    const { sync: applied } = await setup.json<{ sync: Report }>(...args);
    expect(applied.ok).toBe(true);
    expect(setup.git(working, "rev-parse", "HEAD")).toBe(published);
    expect(setup.git(working, "rev-parse", "@{u}")).toBe(published);
    expect(read(setup.at(".claude/CLAUDE.md"))).toBe("published\n");
    expect(preview).toMatchObject({ ok: true, previewLimitations: [] });
  });

  it("previews an unchanged working clone with fetch-all and only its tracked remote", async () => {
    const setup = machine();
    const repo = remote(setup, "mine", { "instructions.md": "original\n" });
    const working = clone(setup, repo, "mine");
    const manifest = setup.manifest({
      agents: ["claude-code"],
      sources: [{ id: "mine", git: repo.url, path: working, instructions: "instructions.md" }],
    });
    const args = ["init", manifest, "--no-hooks", "--copy"];
    await setup.json(...args);
    setup.git(working, "config", "fetch.all", "true");
    const before = repo.head();
    const copy = setup.at(".claude/CLAUDE.md");
    const expectUnchanged = () => {
      expect(setup.git(working, "rev-parse", "HEAD")).toBe(before);
      expect(setup.git(working, "rev-parse", "@{u}")).toBe(before);
      expect(read(copy)).toBe("original\n");
    };

    const { sync: preview } = await setup.json<{ sync: Report }>(...args, "--dry-run");
    expectUnchanged();
    const { sync: applied } = await setup.json<{ sync: Report }>(...args);
    expectUnchanged();
    expect(applied).toMatchObject({ ok: true, files: { replaced: [] } });
    expect(preview).toMatchObject({ ok: true, previewLimitations: [], files: { replaced: [] } });

    setup.git(working, "remote", "add", "other", repo.url);
    const { sync: multipleRemotes } = await setup.json<{ sync: Report }>(...args, "--dry-run");
    expect(multipleRemotes).toMatchObject({
      ok: true,
      previewLimitations: [expect.stringContaining("working clone")],
    });
    expectUnchanged();
  });

  it("flags a newer cached upstream that fetch can skip even when the advertised tip matches HEAD", async () => {
    const setup = machine();
    const repo = remote(setup, "mine", { "instructions.md": "original\n" });
    const working = clone(setup, repo, "mine");
    const manifest = setup.manifest({
      agents: ["claude-code"],
      sources: [{ id: "mine", git: repo.url, path: working, instructions: "instructions.md" }],
    });
    await setup.json("init", manifest, "--no-hooks", "--copy");
    const before = repo.head();
    const incoming = repo.commit({ "instructions.md": "updated\n" });
    setup.git(working, "fetch", "--quiet");
    setup.git(repo.work, "push", "--quiet", "--force", "origin", `${before}:refs/heads/main`);
    const expectIncompletePreview = async () => {
      const { sync } = await setup.json<{ sync: Report }>(
        "init",
        manifest,
        "--no-hooks",
        "--dry-run",
      );
      expect(sync).toMatchObject({
        ok: true,
        previewLimitations: [expect.stringContaining("working clone")],
      });
      expect(setup.git(working, "rev-parse", "HEAD")).toBe(before);
      expect(setup.git(working, "rev-parse", "@{u}")).toBe(incoming);
      expect(read(setup.at(".claude/CLAUDE.md"))).toBe("original\n");
    };

    setup.git(working, "config", "fetch.all", "true");
    for (const key of ["remote.origin.skipFetchAll", "remote.origin.skipDefaultUpdate"]) {
      setup.git(working, "config", key, "true");
      await expectIncompletePreview();
      setup.git(working, "config", "--unset", key);
    }
    setup.git(working, "config", "--unset", "fetch.all");

    setup.git(working, "config", "--add", "remote.origin.fetch", "^refs/heads/main");
    await expectIncompletePreview();

    await setup.json("init", manifest, "--no-hooks");
    expect(setup.git(working, "rev-parse", "HEAD")).toBe(incoming);
    expect(read(setup.at(".claude/CLAUDE.md"))).toBe("updated\n");
  });

  it("flags an unfetched tip without fetching missing objects into a partial clone", async () => {
    const setup = machine();
    const repo = remote(setup, "mine", skills("skills/", "example"));
    setup.git(repo.url, "config", "uploadpack.allowFilter", "true");
    setup.git(repo.url, "config", "uploadpack.allowReachableSHA1InWant", "true");
    const url = pathToFileURL(repo.url).href;
    const working = setup.at("mine");
    setup.git(setup.home, "clone", "--quiet", "--filter=blob:none", url, working);
    const manifest = setup.manifest({
      agents: ["claude-code"],
      sources: [{ id: "mine", git: url, path: working }],
    });
    repo.commit({ "skills/example/SKILL.md": skillMd("example", "incoming update") });
    const packDir = join(working, ".git", "objects", "pack");
    const packs = readdirSync(packDir).sort();
    expect(packs.some((name) => name.endsWith(".promisor"))).toBe(true);

    const { sync } = await setup.json<{ sync: Report }>(
      "init",
      manifest,
      "--no-hooks",
      "--dry-run",
    );
    expect(sync).toMatchObject({
      ok: true,
      previewLimitations: [expect.stringContaining("working clone")],
    });
    expect(readdirSync(packDir).sort()).toEqual(packs);
  });

  it.skipIf(isWindows)(
    "reports rewriting a managed copy from a different same-byte source",
    async () => {
      const m = machine();
      const repo = remote(m, "mine", { "old.md": "instructions\n", "new.md": "instructions\n" });
      const working = clone(m, repo, "mine");
      chmodSync(join(working, "new.md"), 0o644);
      const writeManifest = (instructions: string) =>
        m.manifest({
          agents: ["claude-code"],
          sources: [{ id: "mine", git: repo.url, path: working, instructions }],
        });
      const manifest = writeManifest("old.md");
      await m.json("init", manifest, "--no-hooks", "--copy");
      const destination = m.at(".claude/CLAUDE.md");
      chmodSync(destination, 0o600);
      writeManifest("new.md");
      const preview = await m.json<{ sync: Report }>("init", manifest, "--no-hooks", "--dry-run");
      expect(preview.sync.ok).toBe(true);
      expect(preview.sync.files).toMatchObject({
        added: [],
        updated: [],
        removed: [],
        replaced: [destination],
      });
      expect(statSync(destination).mode & 0o777).toBe(0o600);
      const applied = await m.json<{ sync: Report }>("init", manifest, "--no-hooks");
      expect(applied.sync.files.replaced).toEqual([destination]);
      expect(read(destination)).toBe("instructions\n");
      expect(statSync(destination).mode & 0o777).toBe(0o644);
    },
  );

  it("9. migrates the legacy layout: a dry run changes nothing, the real run keeps every name and empties ~/.codex/skills", async () => {
    const m = machine({ scheduler: "empty" });
    const { work, manifest, codex } = legacyLayout(m);
    const cache = m.at(".cache");
    expect(existsSync(cache)).toBe(false);
    const before = snapshot(m.root);
    const namesBefore = [
      ...new Set([
        ...names(m.at(".claude/skills")),
        ...names(m.at(".agents/skills")),
        ...names(codex),
      ]),
    ].sort();
    expect(namesBefore).toEqual([
      "check-your-work",
      "conversation-video",
      "council",
      "nuxt",
      "unslop",
      "vue",
    ]);

    const dry = await m.run("init", manifest, "--dry-run");
    expect(dry.code, dry.stdout + dry.stderr).toBe(0);
    expect(dry.stdout).toContain(
      `replace the link ${join("~", ".claude", "skills")} -> ${join("~", "onmax", "skills", "skills")} with one link per skill`,
    );
    expect(dry.stdout).toContain(
      `adopt ${join("~", ".codex", "skills", "conversation-video")} into ${join("~", "onmax", "skills", "skills", "conversation-video")}`,
    );
    expect(dry.stdout).toContain(
      `move ${join("~", ".codex", "skills", ".nuxt-skills-managed")} to the backup folder`,
    );
    expect(dry.stdout).toContain(`remove the link ${join("~", ".codex", "skills", "unslop")}`);
    expect(dry.stdout).toContain("record fork council: t3dotgg/tstack skills/council");
    expect(dry.stdout).toContain("skill names: 6 before, 6 after; none lost");
    expect(existsSync(cache)).toBe(false);
    expect(snapshot(m.root)).toEqual(before);

    const real = await m.run("init", manifest, "--no-hooks");
    expect(real.code, real.stdout + real.stderr).toBe(0);
    for (const dir of AGENT_DIRS) {
      expect(isLink(m.at(dir)), dir).toBe(false);
      expect(names(m.at(dir)), dir).toEqual(namesBefore);
    }
    expect(readdirSync(codex)).toEqual([".system"]);
    expect(linkOf(m.at(".claude/skills/conversation-video"))).toBe(
      join(work, "skills/conversation-video"),
    );
    expect(read(join(work, "skills/conversation-video/SKILL.md"))).toBe(
      skillMd("conversation-video"),
    );
    expect(linkOf(m.at(".agents/skills/unslop"))).toBe(join(work, "skills/unslop"));
    expect(read(m.at(".agents/skills/nuxt/SKILL.md"))).toBe(skillMd("nuxt"));
    expect(JSON.parse(read(manifest)).forks).toEqual({
      council: { from: "t3dotgg/tstack", path: "skills/council" },
    });
    const status = await m.run("status");
    expect(status.code, status.stderr).toBe(0);
    expect(status.stdout).toContain("council: no recorded merge base");
    expect(status.stdout).toContain("`fleetrc merge council`");
    // The old copies are in the backup folder, not deleted.
    const backups = readdirSync(join(m.stateDir, "backup"));
    expect(backups).toHaveLength(1);
    expect(readdirSync(join(m.stateDir, "backup", backups[0]!, ".codex", "skills")).sort()).toEqual(
      [".nuxt-skills-managed", "nuxt", "vue"],
    );
    expect(
      read(join(m.stateDir, "backup", backups[0]!, ".codex", "skills", "nuxt", "SKILL.md")),
    ).toBe(skillMd("nuxt", "old copy"));
    // Running init again is a no-op.
    const again = await m.run("init", manifest, "--no-hooks");
    expect(again.code).toBe(0);
    expect(again.stdout).not.toContain("replace the link");
    expect(names(m.at(".claude/skills"))).toEqual(namesBefore);
  });

  it("9b. refuses a plan that would lose skill names unless forced", async () => {
    const m = machine();
    const vendor = remote(m, "vendor", skills("skills/", "kept"));
    mkdirSync(m.at(".codex/skills/orphan"), { recursive: true });
    writeFileSync(m.at(".codex/skills/orphan/SKILL.md"), skillMd("orphan"));
    mkdirSync(m.at(".claude/skills/hand"), { recursive: true });
    writeFileSync(m.at(".claude/skills/hand/notes.txt"), "no SKILL.md here\n");
    // No adopt source: the orphan has nowhere to go, so it stays where it is and is not lost.
    const manifest = m.manifest({
      agents: ["claude-code"],
      sources: [{ id: "vendor", git: vendor.url }],
    });
    const dry = await m.run("init", manifest, "--dry-run");
    expect(dry.code).toBe(0);
    expect(dry.stdout).toContain("none lost");
    expect(dry.stdout).toContain(`${join("~", ".codex", "skills", "orphan")} stays`);
  });

  it("keeps imports from plain local folders as personal skills without merge hints", async () => {
    const m = machine();
    const folder = m.at("plain-folder");
    writeFiles(folder, skills("skills/", "tool"));
    const personal = remote(m, "personal", {
      ...skills("skills/", "tool"),
      "skills-lock.json": JSON.stringify({
        version: 2,
        skills: {
          tool: { source: folder, sourceType: "local", skillPath: "skills/tool/SKILL.md" },
        },
      }),
    });
    const work = clone(m, personal, "code/skills");
    const manifest = m.manifest({
      agents: ["claude-code"],
      sources: [{ id: "personal", git: personal.url, path: work, skills: "skills/*" }],
    });
    const initialized = await m.run("init", manifest, "--no-hooks");
    expect(initialized.code, initialized.stdout + initialized.stderr).toBe(0);
    expect(read(m.at(".claude/skills/tool/SKILL.md"))).toBe(skillMd("tool"));
    const status = await m.run("status");
    expect(status.code, status.stderr).toBe(0);
    expect(status.stdout).not.toContain("`fleetrc diff tool`");
    expect(status.stdout).not.toContain("`fleetrc merge tool`");
    expect(JSON.parse(read(manifest)).forks?.tool).toBeUndefined();
  });

  it("imports skills-lock.json version 2 entries that are not on disk as sources", async () => {
    const m = machine();
    const upstream = remote(m, "upstream", skills("skills/", "ag-dev", "ag-update", "ag-other"));
    const personal = remote(m, "personal", {
      ...skills("skills/", "mine"),
      "skills-lock.json": JSON.stringify({
        version: 2,
        skills: {
          "ag-dev": {
            source: upstream.url,
            sourceType: "git",
            ref: "main",
            skillPath: "skills/ag-dev/SKILL.md",
            computedHash: "x",
          },
          "ag-update": {
            source: upstream.url,
            sourceType: "git",
            skillPath: "skills/ag-update/SKILL.md",
            computedHash: "y",
          },
        },
      }),
    });
    const work = clone(m, personal, "code/skills");
    const manifest = m.manifest({
      agents: ["claude-code"],
      sources: [{ id: "personal", git: personal.url, path: work, skills: "skills/*", adopt: true }],
    });
    const dry = await m.json<{ imports: { sources: object[] }; after: string[] }>(
      "init",
      manifest,
      "--dry-run",
    );
    expect(dry.imports.sources).toEqual([
      { id: "upstream", git: upstream.url, include: ["ag-dev", "ag-update"] },
    ]);
    expect(dry.after).toEqual(["ag-dev", "ag-update", "mine"]);
    expect((await m.run("init", manifest, "--no-hooks")).code).toBe(0);
    expect(names(m.at(".claude/skills"))).toEqual(["ag-dev", "ag-update", "mine"]);
    expect(JSON.parse(read(manifest)).sources[1]).toEqual({
      id: "upstream",
      git: upstream.url,
      include: ["ag-dev", "ag-update"],
    });
  });

  describe("R2-1. agent folders linked to one another are one folder", () => {
    // [the link, the folder it points to]. Codex reads ~/.agents/skills and ~/.codex/skills.
    const layouts: [string, string][] = [
      [".codex/skills", ".agents/skills"],
      [".agents/skills", ".codex/skills"],
      [".claude/skills", ".agents/skills"],
      [".agents/skills", ".claude/skills"],
    ];
    for (const [link, folder] of layouts)
      it.skipIf(isWindows)(`${link} -> ${folder}`, async () => {
        const m = machine({ scheduler: "empty" });
        const vendor = remote(m, "vendor", skills("skills/", "tool"));
        mkdirSync(m.at(folder, "handmade"), { recursive: true });
        writeFileSync(m.at(folder, "handmade/SKILL.md"), skillMd("handmade"));
        rmSync(m.at(link), { recursive: true, force: true });
        mkdirSync(dirname(m.at(link)), { recursive: true });
        symlinkSync(m.at(folder), m.at(link));
        const manifest = m.manifest({
          agents: "all",
          sources: [{ id: "vendor", git: vendor.url }],
        });
        const dry = await m.json<{ lost: string[]; migrations: object[] }>(
          "init",
          manifest,
          "--dry-run",
        );
        expect(dry.lost).toEqual([]);
        expect(dry.migrations).toEqual([]);
        const init = await m.run("init", manifest, "--no-hooks");
        expect(init.stdout).not.toContain("LOST");
        expect(init.code, init.stdout + init.stderr).toBe(0);
        // The link stays, and both agents see the hand-made skill and the synced one, once.
        expect(isLink(m.at(link))).toBe(true);
        expect(names(m.at(folder))).toEqual(["handmade", "tool"]);
        expect(names(m.at(link))).toEqual(["handmade", "tool"]);
        expect(isLink(m.at(folder, "tool"))).toBe(true);
        const doctor = await m.run("doctor");
        expect(doctor.stdout).toMatch(/^ok {3}duplicate skills:/m);
        expect(doctor.stdout).toMatch(/^ok {3}agents agree:/m);
        const sync = await m.json("sync");
        expect(sync.errors).toEqual([]);
        expect(sync.targets.filter((target) => target.skipped)).toEqual([]);
      });
  });

  it("R3-8. a remote manifest is reported as the user named it, not as a cache or a deleted scratch copy", async () => {
    const m = machine();
    const vendor = remote(m, "vendor", skills("skills/", "tool"));
    const team = remote(m, "team", {
      ".fleetrc/manifest.json": JSON.stringify({
        agents: ["claude-code"],
        sources: [{ id: "vendor", git: vendor.url }],
      }),
    });
    const spec = `${team.url}//.fleetrc/manifest.json`;
    const dry = await m.json<{ manifestFile: string; sync: { manifest: string } }>(
      "init",
      team.url,
      "--dry-run",
    );
    expect(dry.sync.manifest).toBe(spec);
    expect(dry.manifestFile).toBe(spec);
    const text = await m.run("init", team.url, "--dry-run");
    expect(text.stdout).toMatch(
      new RegExp(`^fleetrc init: manifest ${spec.replace(/[\\^$.*+?()[\]{}|]/g, "\\$&")}$`, "m"),
    );
    expect((await m.run("init", team.url, "--no-hooks")).code).toBe(0);
    expect((await m.json("sync", "--dry-run")).manifest).toBe(spec);
    expect((await m.json("sync")).manifest).toBe(spec);
  });

  describe("R3-1. init adopts hand-made skills into a clone it has not made yet", () => {
    /** The README's new-machine flow: a personal manifest repository whose clone adopts skills. */
    function newMachine(m: Machine, { reachable = true } = {}) {
      const mine = remote(m, "mine", skills("skills/", "kept"));
      const team = remote(m, "team", {
        ".fleetrc/manifest.json": JSON.stringify({
          agents: ["claude-code"],
          sources: [
            { id: "mine", git: mine.url, path: "~/code/mine", skills: "skills/*", adopt: true },
          ],
        }),
      });
      mkdirSync(m.at(".claude/skills/handmade"), { recursive: true });
      writeFileSync(m.at(".claude/skills/handmade/SKILL.md"), skillMd("handmade"));
      if (!reachable) rmSync(mine.url, { recursive: true, force: true });
      return team;
    }

    it("clones first, then adopts, and the dry run says so in that order", async () => {
      const m = machine();
      const team = newMachine(m);
      const dry = await m.run("init", team.url, "--dry-run", "--no-hooks");
      expect(dry.code, dry.stdout + dry.stderr).toBe(0);
      const clone = dry.stdout.indexOf("clone ");
      const adopt = dry.stdout.indexOf(
        `adopt ${join("~", ".claude", "skills", "handmade")} into ${join("~", "code", "mine", "skills", "handmade")}`,
      );
      expect(clone).toBeGreaterThan(-1);
      expect(adopt).toBeGreaterThan(clone);
      const init = await m.run("init", team.url, "--no-hooks");
      expect(init.code, init.stdout + init.stderr).toBe(0);
      expect(read(m.at("code/mine/skills/handmade/SKILL.md"))).toBe(skillMd("handmade"));
      expect(isLink(m.at(".claude/skills/handmade"))).toBe(true);
      expect(names(m.at(".claude/skills"))).toEqual(["handmade", "kept"]);
      expect((await m.json("sync")).errors).toEqual([]);
    });

    it("leaves the hand-made skill where it is when the clone fails", async () => {
      const m = machine();
      const team = newMachine(m, { reachable: false });
      const init = await m.run("init", team.url, "--no-hooks");
      const said = init.stdout + init.stderr;
      expect(said).toContain(`could not clone mine into ${join("~", "code", "mine")} (`);
      expect(said).toContain("so nothing is adopted");
      expect(read(m.at(".claude/skills/handmade/SKILL.md"))).toBe(skillMd("handmade"));
      expect(isLink(m.at(".claude/skills/handmade"))).toBe(false);
      expect(existsSync(m.at("code/mine"))).toBe(false);
    });

    it("adopts nothing into a folder at the clone's path that is not a clone", async () => {
      const m = machine();
      const team = newMachine(m);
      mkdirSync(m.at("code/mine/notes"), { recursive: true });
      const dry = await m.json<{
        migrations: { kind: string }[];
        lost: string[];
        warnings: string[];
      }>("init", team.url, "--dry-run", "--no-hooks");
      expect(dry.migrations.map((migration) => migration.kind)).toEqual([]);
      expect(dry.lost).toEqual([]);
      expect(dry.warnings.join("\n")).toContain(
        `${join("~", "code", "mine")} exists and is not a git repository`,
      );
      await m.run("init", team.url, "--no-hooks");
      expect(read(m.at(".claude/skills/handmade/SKILL.md"))).toBe(skillMd("handmade"));
      expect(existsSync(m.at("code/mine/skills"))).toBe(false);
    });
  });
});
