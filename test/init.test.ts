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
import { basename, dirname, join, relative } from "node:path";
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
  const council = remote(m, "tstack", {
    "skills/council/SKILL.md": skillMd("council", "upstream"),
  });
  m.git(
    m.root,
    "config",
    "--global",
    `url.${council.url}.insteadOf`,
    "https://github.com/t3dotgg/tstack.git",
  );
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
      council: { from: "t3dotgg/tstack", path: "skills/council", upstream: "git" },
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

  it.each([
    "plain folder",
    "adjacent Git repository",
    "parent Git repository",
    "unborn HEAD",
    ...(isWindows ? [] : ["symlink followed by .."]),
  ])("keeps a local import with %s as a personal skill without merge hints", async (layout) => {
    const m = machine();
    const upstream = remote(m, "upstream", skills("skills/", "tool"));
    let folder = m.at("plain-folder");
    if (layout === "adjacent Git repository") folder = upstream.url.slice(0, -".git".length);
    if (layout === "parent Git repository") folder = join(upstream.work, "plain-folder");
    if (layout === "unborn HEAD") {
      folder = upstream.work;
      m.git(folder, "branch", "topic/HEAD");
      m.git(folder, "symbolic-ref", "HEAD", "refs/heads/unborn");
    }
    writeFiles(folder, skills("skills/", "tool"));
    if (layout === "symlink followed by ..") {
      const target = m.at("elsewhere/child");
      mkdirSync(target, { recursive: true });
      writeFiles(m.at("elsewhere", basename(upstream.work)), skills("skills/", "tool"));
      const alias = join(dirname(upstream.work), "alias");
      symlinkSync(target, alias, "dir");
      folder = `${alias}/../${basename(upstream.work)}`;
    }
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

  it.each(["work", "url", ...(isWindows ? [] : (["symlink"] as const))] as const)(
    "imports an absolute local Git upstream (%s) as a fork and records its first merge",
    async (kind) => {
      const m = machine();
      const upstream = remote(m, "upstream", skills("skills/", "tool"));
      let from: string;
      if (kind === "symlink") {
        const target = join(dirname(upstream.work), "child");
        mkdirSync(target);
        const alias = m.at("alias");
        symlinkSync(target, alias, "dir");
        from = `${alias}/../${basename(upstream.work)}`;
      } else from = upstream[kind];
      const personal = remote(m, "personal", {
        ...skills("skills/", "tool"),
        "skills-lock.json": JSON.stringify({
          version: 2,
          skills: {
            tool: {
              source: from,
              sourceType: "local",
              skillPath: "skills/tool/SKILL.md",
            },
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
      const fork = { from, path: "skills/tool", upstream: "git" };
      expect(JSON.parse(read(manifest)).forks?.tool).toEqual(fork);
      const status = await m.run("status");
      expect(status.code, status.stderr).toBe(0);
      expect(status.stdout).toContain("`fleetrc merge tool`");

      const base = upstream.commit({ "skills/tool/notes.txt": "upstream note\n" });
      const merged = await m.run("merge", "tool");
      expect(merged.code, merged.stdout + merged.stderr).toBe(0);
      expect(read(join(work, "skills/tool/notes.txt"))).toBe("upstream note\n");
      expect(JSON.parse(read(manifest)).forks?.tool).toEqual({ ...fork, base });
    },
  );

  it("checks ref-only Git imports without assuming their branch is the installed base", async () => {
    const m = machine();
    const upstream = remote(m, "upstream", skills("skills/", "tool"));
    const personal = remote(m, "personal", {
      "skills/tool/SKILL.md": skillMd("tool", "personal edits"),
      "skills-lock.json": JSON.stringify({
        version: 2,
        skills: {
          tool: {
            source: upstream.url,
            sourceType: "git",
            ref: "main",
            skillPath: "skills/tool/SKILL.md",
          },
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
    const head = upstream.commit({ "skills/tool/notes.txt": "upstream note\n" });
    await m.json("sync");
    const status = await m.json<{ forks: Record<string, { files: string[] }> }>("status");
    expect(status.forks.tool).toMatchObject({ upstream: head, files: ["SKILL.md", "notes.txt"] });
    expect(JSON.parse(read(manifest)).forks.tool).toEqual({
      from: upstream.url,
      path: "skills/tool",
      upstream: "git",
    });
    expect((await m.run("status")).stdout).toContain("tool: no recorded merge base");
  });

  it("uses a full commit ID from a legacy lock ref as the fork base", async () => {
    const m = machine();
    const upstream = remote(m, "upstream", skills("skills/", "tool"));
    const base = upstream.head();
    const edited = skillMd("tool", "Local edit");
    const personal = remote(m, "personal", {
      "skills/tool/SKILL.md": edited,
      "skills-lock.json": JSON.stringify({
        version: 2,
        skills: {
          tool: {
            source: upstream.url,
            sourceType: "git",
            ref: base,
            skillPath: "skills/tool/SKILL.md",
          },
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
    expect(JSON.parse(read(manifest)).forks.tool.base).toBe(base);

    const head = upstream.commit({ "skills/tool/notes.txt": "upstream note\n" });
    const merged = await m.run("merge", "tool");
    expect(merged.code, merged.stdout + merged.stderr).toBe(0);
    expect(read(join(work, "skills/tool/SKILL.md"))).toBe(edited);
    expect(read(join(work, "skills/tool/notes.txt"))).toBe("upstream note\n");
    expect(JSON.parse(read(manifest)).forks.tool.base).toBe(head);
  });

  it("does not fetch a local partial clone's missing HEAD during offline init", async () => {
    const m = machine();
    const upstream = remote(m, "upstream", skills("skills/", "tool"));
    const partial = m.at("partial");
    mkdirSync(partial);
    m.git(partial, "init");
    m.git(partial, "remote", "add", "origin", upstream.url);
    m.git(partial, "config", "remote.origin.promisor", "true");
    writeFiles(partial, { ".git/refs/heads/main": `${upstream.head()}\n` });
    const personal = remote(m, "personal", {
      ...skills("skills/", "tool"),
      "skills-lock.json": JSON.stringify({
        version: 2,
        skills: {
          tool: { source: partial, sourceType: "local", skillPath: "skills/tool/SKILL.md" },
        },
      }),
    });
    const work = clone(m, personal, "code/skills");
    const manifest = m.manifest({
      agents: ["claude-code"],
      sources: [{ id: "personal", git: personal.url, path: work, skills: "skills/*" }],
    });

    const dry = await m.json<{ imports: { forks: Record<string, unknown> } }>(
      "init",
      manifest,
      "--dry-run",
      "--offline",
    );
    expect(readdirSync(join(partial, ".git/objects/pack"))).toEqual([]);
    expect(dry.imports.forks.tool).toBeUndefined();
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

  it("links unedited local copies from their source and keeps edited ones as forks", async () => {
    const m = machine({ scheduler: "empty" });
    const upstream = remote(m, "upstream", skills("skills/", "ag-dev", "tool"));
    const entry = (name: string) => ({
      source: upstream.url,
      sourceType: "git",
      skillPath: `skills/${name}/SKILL.md`,
      computedHash: "x",
    });
    const personal = remote(m, "personal", {
      ...skills("skills/", "mine", "ag-dev"),
      "skills/tool/SKILL.md": skillMd("tool", "my edit"),
      "skills-lock.json": JSON.stringify({
        version: 1,
        skills: { "ag-dev": entry("ag-dev"), tool: entry("tool") },
      }),
    });
    const work = clone(m, personal, "code/skills");
    const manifest = m.manifest({
      agents: ["claude-code"],
      sources: [{ id: "personal", git: personal.url, path: work, skills: "skills/*", adopt: true }],
    });
    const dry = await m.json<{
      imports: { sources: object[]; forks: object };
      migrations: { kind: string; path: string }[];
    }>("init", manifest, "--dry-run");
    expect(dry.imports.sources).toEqual([
      { id: "upstream", git: upstream.url, include: ["ag-dev"] },
    ]);
    expect(dry.imports.forks).toEqual({
      tool: { from: upstream.url, path: "skills/tool", upstream: "git" },
    });
    expect(dry.migrations).toContainEqual(
      expect.objectContaining({ kind: "backup", path: join(work, "skills/ag-dev") }),
    );
    expect(existsSync(join(work, "skills/ag-dev"))).toBe(true);

    const init = await m.run("init", manifest, "--no-hooks");
    expect(init.code, init.stdout + init.stderr).toBe(0);
    expect(existsSync(join(work, "skills/ag-dev"))).toBe(false);
    expect(names(m.at(".claude/skills"))).toEqual(["ag-dev", "mine", "tool"]);
    expect(linkOf(m.at(".claude/skills/ag-dev"))).not.toContain(work);
    expect(read(m.at(".claude/skills/tool/SKILL.md"))).toBe(skillMd("tool", "my edit"));
    const saved = JSON.parse(read(manifest));
    expect(saved.sources[1]).toEqual({ id: "upstream", git: upstream.url, include: ["ag-dev"] });
    expect(Object.keys(saved.forks)).toEqual(["tool"]);
  });

  type LockImportPlan = {
    lost: string[];
    imports: { sources: object[]; forks: object };
    migrations: { kind: string; path: string }[];
  };

  it.each(["stable", "main", undefined])(
    "compares ref-only lock copies with stable (configured ref: %s)",
    async (configuredRef) => {
      const m = machine({ scheduler: "empty" });
      const upstream = remote(m, "upstream", skills("skills/", "untouched", "edited"));
      m.git(upstream.work, "push", "origin", "HEAD:refs/heads/stable");
      const edited = skillMd("edited", "local edit matching main");
      upstream.commit({
        "skills/untouched/SKILL.md": skillMd("untouched", "main only"),
        "skills/edited/SKILL.md": edited,
      });
      const entry = (name: string) => ({
        source: upstream.url,
        sourceType: "git",
        ref: "stable",
        skillPath: `skills/${name}/SKILL.md`,
      });
      const personal = remote(m, "personal", {
        ...skills("skills/", "untouched"),
        "skills/edited/SKILL.md": edited,
        "skills-lock.json": JSON.stringify({
          version: 2,
          skills: { untouched: entry("untouched"), edited: entry("edited") },
        }),
      });
      const work = clone(m, personal, "code/skills");
      const manifest = m.manifest({
        agents: ["claude-code"],
        sources: [
          { id: "personal", git: personal.url, path: work, skills: "skills/*", adopt: true },
          ...(configuredRef
            ? [
                {
                  id: "upstream",
                  git: upstream.url,
                  ref: configuredRef,
                  include: ["untouched", "edited"],
                },
              ]
            : []),
        ],
      });

      const init = await m.run("init", manifest, "--no-hooks");
      expect(init.code, init.stdout + init.stderr).toBe(0);
      expect(read(join(work, "skills/edited/SKILL.md"))).toBe(edited);
      expect(existsSync(join(work, "skills/untouched"))).toBe(configuredRef === "main");
      expect(read(m.at(".claude/skills/untouched/SKILL.md"))).toBe(skillMd("untouched"));
      const saved = JSON.parse(read(manifest));
      expect(saved.sources[1]).toMatchObject({ git: upstream.url, ref: configuredRef ?? "stable" });
      expect(saved.forks).toEqual({
        edited: { from: upstream.url, path: "skills/edited", upstream: "git" },
        ...(configuredRef === "main"
          ? { untouched: { from: upstream.url, path: "skills/untouched", upstream: "git" } }
          : {}),
      });
    },
  );

  it.each([
    "commit",
    "hex branch",
    "wrong tracking branch",
    "same-tip tracking branch",
    "right tracking branch",
    "full ref",
    "ambiguous ref",
    "moving branch with lock commit",
  ])("only migrates a ref-specific copy to a verified replacement (%s)", async (scenario) => {
    const m = machine({ scheduler: "empty" });
    const upstream = remote(m, "upstream", skills("skills/", "tool"));
    const base = upstream.head();
    const branch = scenario === "hex branch" ? "deadbee" : "stable";
    const advancedBranch =
      scenario === "ambiguous ref" || scenario === "moving branch with lock commit";
    if (scenario === "ambiguous ref") {
      m.git(upstream.work, "tag", branch);
      m.git(upstream.work, "push", "origin", `refs/tags/${branch}`);
    }
    if (!advancedBranch) m.git(upstream.work, "push", "origin", `HEAD:refs/heads/${branch}`);
    if (scenario !== "same-tip tracking branch")
      upstream.commit({ "skills/tool/SKILL.md": skillMd("tool", "main only") });
    if (advancedBranch) m.git(upstream.work, "push", "origin", `HEAD:refs/heads/${branch}`);
    const ref =
      scenario === "commit" ? base : scenario === "full ref" ? `refs/heads/${branch}` : branch;
    const personal = remote(m, "personal", {
      ...skills("skills/", "tool"),
      "skills-lock.json": JSON.stringify({
        version: 2,
        skills: {
          tool: {
            source: upstream.url,
            ref,
            ...(scenario === "moving branch with lock commit" ? { commit: base } : {}),
            skillPath: "skills/tool/SKILL.md",
          },
        },
      }),
    });
    const work = clone(m, personal, "code/skills");
    const replacement = { id: "upstream", git: upstream.url, ref, path: m.at("code/upstream") };
    if (scenario.endsWith("tracking branch")) {
      clone(m, upstream, "code/upstream");
      if (scenario === "right tracking branch") m.git(replacement.path, "checkout", branch);
    }
    const manifest = m.manifest({
      agents: ["claude-code"],
      sources: [
        { id: "personal", git: personal.url, path: work, skills: "skills/*", adopt: true },
        ...(["commit", "hex branch"].includes(scenario) ? [] : [replacement]),
      ],
    });
    const keep = [
      "wrong tracking branch",
      "same-tip tracking branch",
      "full ref",
      "ambiguous ref",
    ].includes(scenario);
    const plan = await m.json<LockImportPlan>("init", manifest, "--dry-run");
    expect(
      plan.migrations.some(
        (migration) => migration.kind === "backup" && migration.path === join(work, "skills/tool"),
      ),
    ).toBe(!keep);
    const init = await m.run("init", manifest, "--no-hooks");
    expect(init.code, init.stdout + init.stderr).toBe(scenario === "full ref" ? 1 : 0);
    expect(existsSync(join(work, "skills/tool"))).toBe(keep);
    expect(read(m.at(".claude/skills/tool/SKILL.md"))).toBe(
      scenario === "moving branch with lock commit"
        ? skillMd("tool", "main only")
        : skillMd("tool"),
    );
    expect(JSON.parse(read(manifest)).sources[1]).toMatchObject({ git: upstream.url, ref });
  });

  it
    .skipIf(isWindows)
    .each([
      "keeps",
      "moves",
      "links to personal",
      "links through personal",
      "links through uppercase TOOL",
      "links elsewhere",
    ] as const)("checks the replacement after the live checkout hook: %s", async (hook) => {
    const m = machine({ scheduler: "empty" });
    const upstream = remote(m, "upstream", skills("skills/", "tool"));
    const external = m.at("external/SKILL.md");
    const addBridge = (repo: typeof upstream) => {
      symlinkSync(external, join(repo.work, "skills/tool/bridge.md"));
      repo.commit({});
    };
    const uppercase = hook === "links through uppercase TOOL";
    const throughBridge = hook === "links through personal" || uppercase;
    if (throughBridge) addBridge(upstream);
    const ref = upstream.head();
    upstream.commit({ "skills/tool/SKILL.md": skillMd("tool", "main only") });
    const personal = remote(m, "personal", {
      ...skills("skills/", "tool"),
      "skills-lock.json": JSON.stringify({
        version: 2,
        skills: { tool: { source: upstream.url, ref, skillPath: "skills/tool/SKILL.md" } },
      }),
    });
    if (throughBridge) addBridge(personal);
    const work = clone(m, personal, "code/skills");
    const bridgeDir = join(work, "skills", uppercase ? "TOOL" : "tool");
    const throughPersonal = throughBridge && existsSync(bridgeDir);
    if (uppercase && !throughPersonal) {
      mkdirSync(bridgeDir);
      symlinkSync(external, join(bridgeDir, "bridge.md"));
    }
    const linkedSkill =
      hook === "links to personal"
        ? join(work, "skills/tool/SKILL.md")
        : throughBridge
          ? join(bridgeDir, "bridge.md")
          : external;
    if (hook === "links elsewhere" || throughBridge)
      writeFiles(m.home, { "external/SKILL.md": skillMd("tool") });
    const manifest = m.manifest({
      agents: ["claude-code"],
      sources: [
        { id: "personal", git: personal.url, path: work, skills: "skills/*", adopt: true },
        {
          id: "upstream",
          git: upstream.url,
          ref,
          path: m.at("code/upstream"),
          skills: "skills/*",
          followLinks: hook.startsWith("links"),
        },
      ],
    });
    const hooks = m.at("git-hooks");
    writeFiles(hooks, {
      "post-checkout": [
        "#!/bin/sh",
        'echo checkout >> "$HOME/checkouts"',
        ...(hook === "moves" ? [`if [ "$2" = "${ref}" ]; then mv skills/tool ./tool; fi`] : []),
        ...(hook.startsWith("links")
          ? [
              `if [ "$2" = "${ref}" ]; then rm skills/tool/SKILL.md; ln -s "${linkedSkill}" skills/tool/SKILL.md; fi`,
            ]
          : []),
        "",
      ].join("\n"),
    });
    chmodSync(join(hooks, "post-checkout"), 0o755);
    m.git(work, "config", "--global", "core.hooksPath", hooks);

    const plan = await m.json<LockImportPlan>("init", manifest, "--dry-run");
    expect(plan.migrations).toContainEqual(
      expect.objectContaining({ kind: "backup", path: join(work, "skills/tool") }),
    );
    expect(existsSync(m.at("checkouts"))).toBe(false);
    const init = await m.run("init", manifest, "--no-hooks");
    expect(init.code, init.stdout + init.stderr).toBe(0);
    expect(read(m.at("checkouts"))).toBe("checkout\ncheckout\n");
    expect(existsSync(join(work, "skills/tool"))).toBe(
      hook === "moves" || hook === "links to personal" || throughPersonal,
    );
    expect(read(m.at(".claude/skills/tool/SKILL.md"))).toBe(skillMd("tool"));
  });

  it("links commands from the replacement after backing up a matching copy", async () => {
    const m = machine({ scheduler: "empty" });
    const files = {
      ...skills("skills/", "tool"),
      "skills/tool/review.md": "Review the changes.\n",
    };
    const upstream = remote(m, "upstream", files);
    const personal = remote(m, "personal", {
      ...files,
      "skills-lock.json": JSON.stringify({
        version: 1,
        skills: { tool: { source: upstream.url, skillPath: "skills/tool/SKILL.md" } },
      }),
    });
    const work = clone(m, personal, "code/skills");
    const replacement = m.at("code/upstream");
    const manifest = m.manifest({
      agents: ["claude-code"],
      sources: [
        {
          id: "personal",
          git: personal.url,
          path: work,
          skills: "skills/*",
          commands: "skills/*/review.md",
          adopt: true,
        },
        {
          id: "upstream",
          git: upstream.url,
          path: replacement,
          skills: "skills/*",
          commands: "skills/*/review.md",
        },
      ],
    });
    const init = await m.run("init", manifest, "--no-hooks");
    expect(init.code, init.stdout + init.stderr).toBe(0);
    expect(existsSync(join(work, "skills/tool"))).toBe(false);
    expect(read(m.at(".claude/commands/tool/review.md"))).toBe(files["skills/tool/review.md"]);
    expect(linkOf(m.at(".claude/commands/tool/review.md"))).toBe(
      join(replacement, "skills/tool/review.md"),
    );
  });

  it("can migrate a matching copy after adopting an unrelated copied command edit", async () => {
    const m = machine({ scheduler: "empty" });
    const upstream = remote(m, "upstream", skills("skills/", "tool"));
    const personal = remote(m, "personal", {
      ...skills("skills/", "tool"),
      "skills-lock.json": JSON.stringify({
        version: 1,
        skills: { tool: { source: upstream.url, skillPath: "skills/tool/SKILL.md" } },
      }),
    });
    const work = clone(m, personal, "code/skills");
    const commands = m.at("commands-source");
    writeFiles(commands, { "commands/ship.md": "original\n" });
    const agents = ["claude-code"];
    const commandSource = { id: "local-commands", local: commands, commands: "commands/*.md" };
    const initial = m.manifest({ agents, sources: [commandSource] });
    const setup = await m.run("init", initial, "--copy", "--no-hooks");
    expect(setup.code, setup.stdout + setup.stderr).toBe(0);
    writeFileSync(m.at(".claude/commands/ship.md"), "edited\n");

    const manifest = m.manifest({
      agents,
      sources: [
        { id: "personal", git: personal.url, path: work, skills: "skills/*", adopt: true },
        commandSource,
      ],
    });
    const init = await m.run("init", manifest, "--no-hooks");
    expect(init.code, init.stdout + init.stderr).toBe(0);
    expect(read(join(commands, "commands/ship.md"))).toBe("edited\n");
    expect(init.stdout).toContain("tool stays in place while copy edits are pending");
    expect(existsSync(join(work, "skills/tool"))).toBe(true);
    expect(JSON.parse(read(manifest)).forks?.tool).toBeUndefined();

    const retry = await m.run("init", manifest, "--no-hooks");
    expect(retry.code, retry.stdout + retry.stderr).toBe(0);
    expect(existsSync(join(work, "skills/tool"))).toBe(false);
    expect(JSON.parse(read(manifest)).sources).toContainEqual({
      id: "upstream",
      git: upstream.url,
      include: ["tool"],
    });
    expect(read(m.at(".claude/skills/tool/SKILL.md"))).toBe(skillMd("tool"));
  });

  it.each([
    "removed upstream",
    "excluded by the source",
    "in a stale working clone",
    "in an occupied non-Git folder",
  ])("keeps a matching personal copy when the replacement is %s", async (why) => {
    const m = machine({ scheduler: "empty" });
    const upstream = remote(m, "upstream", skills("skills/", "tool", "other"));
    const base = upstream.head();
    const personal = remote(m, "personal", {
      ...skills("skills/", "tool"),
      "skills-lock.json": JSON.stringify({
        version: 2,
        skills: {
          tool: { source: upstream.url, skillPath: "skills/tool/SKILL.md", commit: base },
        },
      }),
    });
    const work = clone(m, personal, "code/skills");
    const stale = why === "in a stale working clone";
    const occupied = why === "in an occupied non-Git folder";
    const replacementPath = stale ? clone(m, upstream, "code/upstream") : m.at("code/upstream");
    if (occupied) writeFiles(replacementPath, skills("skills/", "tool"));
    const tip =
      stale || why === "removed upstream"
        ? upstream.commit({ "skills/tool/SKILL.md": null })
        : base;
    const manifest = m.manifest({
      agents: ["claude-code"],
      sources: [
        { id: "personal", git: personal.url, path: work, skills: "skills/*", adopt: true },
        ...(why === "excluded by the source"
          ? [{ id: "upstream", git: upstream.url, exclude: ["tool"] }]
          : []),
        ...(stale || occupied
          ? [{ id: "upstream", git: upstream.url, path: replacementPath, skills: "skills/*" }]
          : []),
      ],
    });
    const plan = await m.json<LockImportPlan>("init", manifest, "--dry-run");
    expect(plan.lost).toEqual([]);
    expect(plan.imports.sources).toEqual([]);
    expect(plan.imports.forks).toEqual({
      tool: { from: upstream.url, path: "skills/tool", base },
    });
    expect(plan.migrations).not.toContainEqual(
      expect.objectContaining({ path: join(work, "skills/tool") }),
    );
    const init = await m.run("init", manifest, "--no-hooks");
    expect(init.code, init.stdout + init.stderr).toBe(occupied ? 1 : 0);
    if (stale) expect(m.git(replacementPath, "rev-parse", "HEAD")).toBe(tip);
    expect(read(m.at(".claude/skills/tool/SKILL.md"))).toBe(skillMd("tool"));
    expect(existsSync(join(work, "skills/tool"))).toBe(true);
  });

  it("keeps a matching personal copy when an agent edit renames the replacement", async () => {
    const m = machine({ scheduler: "empty" });
    const upstream = remote(m, "upstream", skills("skills/", "tool"));
    const base = upstream.head();
    const replacementPath = clone(m, upstream, "code/upstream");
    const replacement = {
      id: "upstream",
      git: upstream.url,
      path: replacementPath,
      include: ["tool"],
    };
    const agents = ["claude-code", "codex"];
    const initial = m.manifest({ agents, sources: [replacement] });
    const setup = await m.run("init", initial, "--copy", "--no-hooks");
    expect(setup.code, setup.stdout + setup.stderr).toBe(0);
    const renamed = skillMd("renamed");
    writeFileSync(m.at(".claude/skills/tool/SKILL.md"), renamed);

    const personal = remote(m, "personal", {
      ...skills("skills/", "tool"),
      "skills-lock.json": JSON.stringify({
        version: 2,
        skills: {
          tool: { source: upstream.url, skillPath: "skills/tool/SKILL.md", commit: base },
        },
      }),
    });
    const work = clone(m, personal, "code/skills");
    const manifest = m.manifest({
      agents,
      sources: [
        { id: "personal", git: personal.url, path: work, skills: "skills/*", adopt: true },
        replacement,
      ],
    });
    const plan = await m.json<LockImportPlan & { sync: Report }>("init", manifest, "--dry-run");
    expect(plan.sync.previewLimitations).toContainEqual(
      expect.stringContaining("would move the edits"),
    );
    expect(plan.lost).toEqual([]);
    expect(plan.imports.forks).toEqual({});
    expect(plan.migrations).not.toContainEqual(
      expect.objectContaining({ path: join(work, "skills/tool") }),
    );

    const init = await m.run("init", manifest, "--no-hooks");
    expect(init.code, init.stdout + init.stderr).toBe(0);
    expect(read(join(replacementPath, "skills/tool/SKILL.md"))).toBe(renamed);
    expect(read(join(work, "skills/tool/SKILL.md"))).toBe(skillMd("tool"));
    expect(read(m.at(".claude/skills/tool/SKILL.md"))).toBe(skillMd("tool"));
    expect(read(m.at(".agents/skills/tool/SKILL.md"))).toBe(skillMd("tool"));
    expect(JSON.parse(read(manifest)).forks?.tool).toBeUndefined();
  });

  it("plans one backup for duplicate lock entries and preserves copies with conflicting entries", async () => {
    const m = machine({ scheduler: "empty" });
    const upstream = remote(m, "upstream", skills("skills/", "tool", "conflict"));
    const other = remote(m, "other", {
      "skills/conflict/SKILL.md": skillMd("conflict", "different"),
    });
    const lock = (source: string) =>
      JSON.stringify({
        version: 1,
        skills: {
          tool: { source: upstream.url, skillPath: "skills/tool/SKILL.md" },
          conflict: { source, skillPath: "skills/conflict/SKILL.md" },
        },
      });
    const personal = remote(m, "personal", {
      ...skills("skills/", "tool", "conflict"),
      "skills-lock.json": lock(upstream.url),
    });
    const work = clone(m, personal, "code/skills");
    const extra = m.at("extra");
    writeFiles(extra, { "skills-lock.json": lock(other.url) });
    const manifest = m.manifest({
      agents: ["claude-code"],
      sources: [
        { id: "personal", git: personal.url, path: work, skills: "skills/*", adopt: true },
        { id: "extra", local: extra },
      ],
    });
    const plan = await m.json<LockImportPlan>("init", manifest, "--dry-run");
    expect(plan.migrations.filter(({ kind }) => kind === "backup")).toEqual([
      expect.objectContaining({ path: join(work, "skills/tool") }),
    ]);
    expect(plan.imports.forks).toHaveProperty("conflict");
    const init = await m.run("init", manifest, "--no-hooks");
    expect(init.code, init.stdout + init.stderr).toBe(0);
    expect(names(m.at(".claude/skills"))).toEqual(["conflict", "tool"]);
    expect(existsSync(join(work, "skills/conflict"))).toBe(true);
    expect(existsSync(join(work, "skills/tool"))).toBe(false);
  });

  it.skipIf(isWindows)("preserves local executable-mode edits to a lock copy", async () => {
    const m = machine({ scheduler: "empty" });
    const files = { ...skills("skills/", "tool"), "skills/tool/helper.sh": "#!/bin/sh\n" };
    const upstream = remote(m, "upstream", files);
    const personal = remote(m, "personal", {
      ...files,
      "skills-lock.json": JSON.stringify({
        version: 1,
        skills: { tool: { source: upstream.url, skillPath: "skills/tool/SKILL.md" } },
      }),
    });
    const work = clone(m, personal, "code/skills");
    chmodSync(join(work, "skills/tool/helper.sh"), 0o755);
    const plan = await m.json<LockImportPlan>(
      "init",
      m.manifest({
        agents: ["claude-code"],
        sources: [
          { id: "personal", git: personal.url, path: work, skills: "skills/*", adopt: true },
        ],
      }),
      "--dry-run",
    );
    expect(plan.imports.forks).toHaveProperty("tool");
    expect(plan.migrations).not.toContainEqual(
      expect.objectContaining({ path: join(work, "skills/tool") }),
    );
  });

  it("does not plan a backup through a skills folder linked outside the personal clone", async () => {
    const m = machine({ scheduler: "empty" });
    const upstream = remote(m, "upstream", skills("skills/", "tool"));
    const personal = remote(m, "personal", {
      "skills-lock.json": JSON.stringify({
        version: 1,
        skills: { tool: { source: upstream.url, skillPath: "skills/tool/SKILL.md" } },
      }),
    });
    const work = clone(m, personal, "code/skills");
    const outside = m.at("outside");
    writeFiles(outside, skills("", "tool"));
    symlinkSync(outside, join(work, "skills"), linkKind);
    const manifest = m.manifest({
      agents: ["claude-code"],
      sources: [{ id: "personal", git: personal.url, path: work, skills: "skills/*", adopt: true }],
    });
    const plan = await m.json<LockImportPlan>("init", manifest, "--dry-run");
    expect(plan.migrations.filter(({ kind }) => kind === "backup")).toEqual([]);
    expect(read(join(outside, "tool/SKILL.md"))).toBe(skillMd("tool"));
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
