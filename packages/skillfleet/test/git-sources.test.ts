// Git sources on every file system: names macOS and Windows fold together, refs that name a
// commit, manifest links copied from a browser, hook paths and the last-run report of a partial sync.
// On macOS (APFS folds case and Unicode normalization) these reproduce what happens there for real;
// on Linux and Windows they check that every machine of a fleet ends up with the same skills.
import { execFileSync } from "node:child_process";
import { appendFileSync, existsSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vite-plus/test";
import { collisions } from "../src/gitcache.ts";
import {
  clone,
  type Machine,
  machine,
  names,
  read,
  type Remote,
  remote,
  skillMd,
  skills,
  writeFiles,
} from "./fixture.ts";

/**
 * Replaces the tree of the remote's main branch with `files`, written with git plumbing, so names
 * that macOS would fold on disk (Foo and foo, NFC and NFD) reach the commit as given, as when they
 * were committed on Linux.
 */
function commitRaw(m: Machine, r: Remote, files: Record<string, string>): string {
  const index = join(m.root, "raw-index");
  rmSync(index, { force: true });
  const run = (args: string[], input?: string) =>
    execFileSync("git", ["-c", "core.precomposeunicode=false", ...args], {
      cwd: r.url,
      env: { ...m.env, GIT_INDEX_FILE: index },
      input,
      encoding: "utf8",
    }).trim();
  const entries = Object.entries(files).map(
    ([path, content]) => `100644 ${run(["hash-object", "-w", "--stdin"], content)}\t${path}`,
  );
  run(["update-index", "--index-info"], `${entries.join("\n")}\n`);
  const tree = run(["write-tree"]);
  const commit = run(["commit-tree", tree, "-p", "refs/heads/main", "-m", "raw"]);
  run(["update-ref", "refs/heads/main", commit]);
  return commit;
}

const nfc = (list: string[]) => list.map((name) => name.normalize("NFC"));

/** A hook script that appends SKILLFLEET_CHANGED to `log`, one JSON line per run. */
function changedLog(m: Machine) {
  const log = join(m.root, "changed.jsonl");
  const script = join(m.root, "changed.mjs");
  writeFileSync(
    script,
    `import { appendFileSync } from "node:fs";
appendFileSync(${JSON.stringify(log)}, JSON.stringify(process.env.SKILLFLEET_CHANGED.split("\\n")) + "\\n");`,
  );
  return {
    run: `"${process.execPath}" "${script}"`,
    runs: (): string[][] =>
      existsSync(log)
        ? read(log)
            .trim()
            .split("\n")
            .filter(Boolean)
            .map((line) => JSON.parse(line) as string[])
        : [],
  };
}

describe("names macOS and Windows fold together", () => {
  it("MAC2. a skill folder named in NFD stays linked across syncs", async () => {
    const m = machine();
    const vendor = remote(m, "vendor", skills("skills/", "plain"));
    const nfd = "cafe\u0301";
    commitRaw(m, vendor, {
      ...skills("skills/", "plain"),
      [`skills/${nfd}/SKILL.md`]: skillMd(nfd),
      [`skills/${nfd}/notes.md`]: "notes\n",
    });
    const manifest = m.manifest({
      agents: ["claude-code"],
      sources: [{ id: "vendor", git: vendor.url }],
    });
    const init = await m.run("init", manifest, "--no-timer");
    expect(init.code, init.stdout + init.stderr).toBe(0);
    expect(nfc(names(m.at(".claude/skills")))).toEqual(["café", "plain"]);

    // On macOS the second sync used to `git clean` the folder away as untracked.
    for (let run = 0; run < 2; run++) {
      const report = await m.json("sync");
      expect(report.ok, JSON.stringify(report.errors)).toBe(true);
      expect(nfc(report.skills.names)).toEqual(["café", "plain"]);
      expect(report.skills.removed).toEqual([]);
      expect(report.skills.added).toEqual([]);
      expect(report.edited).toEqual([]);
    }
    const linked = names(m.at(".claude/skills")).find((name) => name.normalize("NFC") === "café")!;
    expect(read(m.at(".claude/skills", linked, "notes.md"))).toBe("notes\n");
  });

  it("MAC3. of Foo and foo in one repository, Foo is linked on every system and stays linked", async () => {
    const m = machine();
    const vendor = remote(m, "vendor", skills("skills/", "other"));
    const files = {
      ...skills("skills/", "other"),
      "skills/Foo/SKILL.md": skillMd("Foo"),
      "skills/foo/SKILL.md": skillMd("foo"),
      "skills/foo/extra.md": "only in foo\n",
    };
    commitRaw(m, vendor, files);
    const manifest = m.manifest({
      agents: ["claude-code"],
      sources: [{ id: "vendor", git: vendor.url }],
    });
    const init = await m.run("init", manifest, "--no-timer");
    expect(init.code, init.stdout + init.stderr).toBe(0);
    expect(init.stdout).toContain(
      "vendor: left out skills/foo: macOS and Windows keep it in the same folder as skills/Foo",
    );
    expect(names(m.at(".claude/skills"))).toEqual(["Foo", "other"]);
    expect(read(m.at(".claude/skills/Foo/SKILL.md"))).toBe(skillMd("Foo"));
    expect(existsSync(m.at(".claude/skills/Foo/extra.md"))).toBe(false);

    for (let run = 0; run < 3; run++) {
      const report = await m.json("sync");
      expect(report.ok, JSON.stringify(report.errors)).toBe(true);
      expect(report.skills.names).toEqual(["Foo", "other"]);
      expect(report.skills.added).toEqual([]);
      expect(report.skills.removed).toEqual([]);
      expect(report.edited).toEqual([]);
      expect(report.targets.flatMap((target) => target.warnings)).toEqual([]);
      expect(report.warnings).toEqual([
        "vendor: left out skills/foo: macOS and Windows keep it in the same folder as skills/Foo",
      ]);
    }
    const listed = JSON.parse((await m.run("list", "--json")).stdout) as Record<
      string,
      { dir: string }
    >;
    expect(Object.keys(listed)).toEqual(["Foo", "other"]);
    expect(read(join(listed.Foo!.dir, "SKILL.md"))).toBe(skillMd("Foo"));

    // An upstream change to Foo is an update, not a local edit.
    commitRaw(m, vendor, { ...files, "skills/Foo/SKILL.md": skillMd("Foo", "v2") });
    const updated = await m.json("sync");
    expect(updated.skills.updated).toEqual(["Foo"]);
    expect(updated.edited).toEqual([]);
    expect(read(m.at(".claude/skills/Foo/SKILL.md"))).toBe(skillMd("Foo", "v2"));
  });

  it("MAC3. collisions keep the first path in byte order, by folder", () => {
    expect(
      collisions([
        "skills/foo/SKILL.md",
        "skills/Foo/SKILL.md",
        "skills/Foo/a.md",
        "skills/foo/b.md",
        "skills/cafe\u0301/SKILL.md",
        "skills/caf\u00e9/SKILL.md",
        "skills/bar./SKILL.md",
        "skills/bar/SKILL.md",
        "README.md",
      ]),
    ).toEqual([
      { path: "skills/bar.", kept: "skills/bar" },
      { path: "skills/caf\u00e9", kept: "skills/cafe\u0301" },
      { path: "skills/foo", kept: "skills/Foo" },
    ]);
  });
});

describe("refs that name a commit", () => {
  it("D8. a vendored source pinned to a short or full commit id stays on it", async () => {
    const m = machine();
    const vendor = remote(m, "vendor", skills("skills/", "tool"));
    const pinned = vendor.commit({ "skills/tool/SKILL.md": skillMd("tool", "pinned") });
    vendor.commit({ "skills/tool/SKILL.md": skillMd("tool", "later") });
    const manifest = m.manifest({
      agents: ["claude-code"],
      sources: [
        { id: "short", git: vendor.url, ref: pinned.slice(0, 7), include: ["tool"] },
        { id: "full", git: vendor.url, ref: pinned, skills: "skills/*" },
      ],
    });
    const init = await m.run("init", manifest, "--no-timer");
    expect(init.code, init.stdout + init.stderr).toBe(0);
    expect(read(m.at(".claude/skills/tool/SKILL.md"))).toBe(skillMd("tool", "pinned"));

    vendor.commit({ "skills/tool/SKILL.md": skillMd("tool", "latest") });
    const report = await m.json("sync");
    expect(report.ok, JSON.stringify(report.errors)).toBe(true);
    expect(report.sources.map((source) => [source.id, source.status, source.to])).toEqual([
      ["short", "unchanged", pinned],
      ["full", "unchanged", pinned],
    ]);
    expect(read(m.at(".claude/skills/tool/SKILL.md"))).toBe(skillMd("tool", "pinned"));
  });

  it("D8. a ref that is no branch, tag or commit says so", async () => {
    const m = machine();
    const vendor = remote(m, "vendor", skills("skills/", "tool"));
    const manifest = m.manifest({
      agents: ["claude-code"],
      sources: [{ id: "vendor", git: vendor.url, ref: "abcdef1" }],
    });
    await m.run("init", manifest, "--no-timer");
    const report = await m.json("sync");
    expect(report.errors.join("\n")).toContain("has no branch, tag or commit abcdef1");
  });

  it("D8. a working clone pinned to a commit is cloned detached there and stays until the pin moves", async () => {
    const m = machine();
    const personal = remote(m, "personal", skills("skills/", "mine"));
    const first = personal.commit({ "skills/mine/SKILL.md": skillMd("mine", "first") });
    const second = personal.commit({ "skills/mine/SKILL.md": skillMd("mine", "second") });
    personal.commit({ "skills/mine/SKILL.md": skillMd("mine", "third") });
    const work = m.at("code/skills");
    const write = (ref: string) =>
      m.manifest({
        agents: ["claude-code"],
        sources: [{ id: "personal", git: personal.url, path: work, ref }],
      });
    const init = await m.run("init", write(first.slice(0, 7)), "--no-timer");
    expect(init.code, init.stdout + init.stderr).toBe(0);
    expect(m.git(work, "rev-parse", "HEAD")).toBe(first);
    expect(read(m.at(".claude/skills/mine/SKILL.md"))).toBe(skillMd("mine", "first"));

    personal.commit({ "skills/mine/SKILL.md": skillMd("mine", "fourth") });
    const stay = await m.json("sync");
    expect(stay.ok, JSON.stringify(stay.errors)).toBe(true);
    expect(stay.warnings).toEqual([]);
    expect(stay.sources[0]).toMatchObject({ status: "unchanged", to: first });
    expect(m.git(work, "rev-parse", "HEAD")).toBe(first);

    write(second);
    const moved = await m.json("sync");
    expect(moved.ok, JSON.stringify(moved.errors)).toBe(true);
    expect(moved.sources[0]).toMatchObject({ status: "updated", from: first, to: second });
    expect(moved.sources[0]!.changed).toEqual(["skills/mine/SKILL.md"]);
    expect(read(m.at(".claude/skills/mine/SKILL.md"))).toBe(skillMd("mine", "second"));
  });

  it("D8. a working clone pinned to a full commit id is cloned at it", async () => {
    const m = machine();
    const personal = remote(m, "personal", skills("skills/", "mine"));
    const pinned = personal.head();
    personal.commit({ "skills/mine/SKILL.md": skillMd("mine", "later") });
    const work = m.at("code/skills");
    const manifest = m.manifest({
      agents: ["claude-code"],
      sources: [{ id: "personal", git: personal.url, path: work, ref: pinned }],
    });
    const init = await m.run("init", manifest, "--no-timer");
    expect(init.code, init.stdout + init.stderr).toBe(0);
    expect(m.git(work, "rev-parse", "HEAD")).toBe(pinned);
    expect(read(m.at(".claude/skills/mine/SKILL.md"))).toBe(skillMd("mine"));
  });
});

describe("manifest specs", () => {
  /** Sends git's requests for `url` to the local remote `r`, as if it were hosted there. */
  const hostAt = (m: Machine, url: string, r: Remote) =>
    appendFileSync(
      join(m.root, "gitconfig"),
      `[url "${r.url.replace(/\\/g, "/")}"]\n\tinsteadOf = ${url}\n`,
    );

  /** A team repository whose main branch links `tool` and whose dev branch, in team/, links `extra`. */
  function teamRepo(m: Machine) {
    const vendor = remote(m, "vendor", skills("skills/", "tool", "extra"));
    const manifest = (skill: string) =>
      JSON.stringify({
        agents: ["claude-code"],
        sources: [{ id: "vendor", git: vendor.url, include: [skill] }],
      });
    const team = remote(m, "team", { "skills.json": manifest("tool") });
    m.git(team.work, "checkout", "--quiet", "-b", "dev");
    writeFiles(team.work, { "team/skills.json": manifest("extra") });
    m.git(team.work, "add", "-A");
    m.git(team.work, "commit", "--quiet", "-m", "dev");
    m.git(team.work, "push", "--quiet", "origin", "dev");
    return team;
  }
  const configured = (m: Machine) =>
    (JSON.parse(read(m.at(".config/skillfleet/config.json"))) as { manifest: string }).manifest;

  it("D2. a GitHub page link without .git is a repository holding skills.json", async () => {
    const m = machine();
    hostAt(m, "https://github.com/org/team", teamRepo(m));
    const init = await m.run("init", "https://github.com/org/team", "--no-timer");
    expect(init.code, init.stdout + init.stderr).toBe(0);
    expect(names(m.at(".claude/skills"))).toEqual(["tool"]);
    expect(configured(m)).toBe("https://github.com/org/team//skills.json");
    expect((await m.json("sync")).ok).toBe(true);
  });

  it("D2. a GitHub blob link names the branch and the file", async () => {
    const m = machine();
    hostAt(m, "https://github.com/org/team", teamRepo(m));
    const link = "https://github.com/org/team/blob/dev/team/skills.json";
    const init = await m.run("init", link, "--no-timer");
    expect(init.code, init.stdout + init.stderr).toBe(0);
    expect(names(m.at(".claude/skills"))).toEqual(["extra"]);
    expect(configured(m)).toBe(link);
    expect((await m.json("sync")).skills.names).toEqual(["extra"]);
  });

  it("D2. a bare repository on this machine is a repository, not a folder", async () => {
    const m = machine();
    const team = teamRepo(m);
    const init = await m.run("init", team.url, "--no-timer");
    expect(init.code, init.stdout + init.stderr).toBe(0);
    expect(names(m.at(".claude/skills"))).toEqual(["tool"]);
    expect(configured(m)).toBe(`${team.url}//skills.json`);
    expect((await m.json("sync")).ok).toBe(true);
  });
});

describe("hooks", () => {
  it("D6. a vendored git source reports changed paths from the root of its repository", async () => {
    const m = machine();
    const vendor = remote(m, "vendor", skills("skills/", "tool"));
    const hook = changedLog(m);
    const manifest = m.manifest({
      agents: ["claude-code"],
      sources: [{ id: "vendor", git: vendor.url, skills: "skills/*" }],
      hooks: [
        { name: "repo", run: hook.run, on: ["vendor:skills/**"] },
        { name: "skill-relative", run: hook.run, on: ["vendor:tool/**"] },
      ],
    });
    const init = await m.run("init", manifest, "--no-timer");
    expect(init.code, init.stdout + init.stderr).toBe(0);
    expect(hook.runs()).toEqual([["vendor:skills/tool/SKILL.md"]]);
    expect(init.stdout).toContain(
      'hook skill-relative: "vendor:tool/**" matches no file in vendor, so it never runs; paths start at the root of the source, as in skills/tool/SKILL.md',
    );

    vendor.commit({ "skills/tool/SKILL.md": skillMd("tool", "v2") });
    const report = await m.json("sync");
    expect(report.hooks.map((run) => [run.name, run.matched])).toEqual([
      ["repo", ["vendor:skills/tool/SKILL.md"]],
    ]);
    expect(hook.runs()).toHaveLength(2);
    expect(
      report.warnings.filter((warning) => warning.startsWith("hook skill-relative:")),
    ).toHaveLength(1);
  });

  it("D6. a pattern that names no source is reported", async () => {
    const m = machine();
    const vendor = remote(m, "vendor", skills("skills/", "tool"));
    const manifest = m.manifest({
      agents: ["claude-code"],
      sources: [{ id: "vendor", git: vendor.url }],
      hooks: [{ name: "typo", run: "exit 0", on: ["vendr:**"] }],
    });
    await m.run("init", manifest, "--no-timer");
    expect((await m.json("sync")).warnings).toContain(
      'hook typo: "vendr:**" names no source "vendr"',
    );
  });
});

describe("a sync of one source", () => {
  it("MAC7. update <source> keeps another source's held state in last-run.json and status", async () => {
    const m = machine({ scheduler: "empty" });
    const personal = remote(m, "personal", skills("skills/", "mine"));
    const work = clone(m, personal, "code/skills");
    const vendor = remote(m, "vendor", skills("skills/", "tool"));
    const manifest = m.manifest({
      agents: ["claude-code"],
      sources: [
        { id: "personal", git: personal.url, path: work, skills: "skills/*" },
        { id: "vendor", git: vendor.url, update: "review" },
      ],
    });
    expect((await m.run("init", manifest, "--no-timer")).code).toBe(0);
    writeFiles(work, { "local.md": "local\n" });
    m.git(work, "add", "-A");
    m.git(work, "commit", "--quiet", "-m", "local");
    personal.commit({ "skills/mine/SKILL.md": skillMd("mine", "upstream") });
    vendor.commit({ "skills/tool/SKILL.md": skillMd("tool", "v2") });
    const full = await m.json("sync");
    expect(full.held.map((held) => held.source)).toEqual(["personal"]);

    for (const args of [
      ["sync", "vendor"],
      ["update", "vendor"],
    ]) {
      const run = await m.run(...args);
      expect(run.code, run.stdout + run.stderr).toBe(0);
      const last = JSON.parse(read(join(m.stateDir, "last-run.json"))) as typeof full;
      expect(last.held).toEqual(full.held);
      expect(last.sources.find((source) => source.id === "personal")?.status).toBe("held");
      expect((await m.run("status")).stdout).toContain("held personal: 1 local commit not on");
    }
    expect(read(m.at(".claude/skills/tool/SKILL.md"))).toBe(skillMd("tool", "v2"));
  });
});
