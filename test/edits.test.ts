import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vite-plus/test";
import {
  clone,
  http,
  isLink,
  linkOf,
  machine,
  names,
  read,
  remote,
  type Report,
  serveIndexV2,
  skillMd,
  skills,
} from "./fixture.ts";

const lines = (...body: string[]) =>
  `---\nname: tool\ndescription: The tool skill\n---\n${body.join("\n")}\n`;

async function editedVendoredSkill(options: Parameters<typeof machine>[0] = {}, index?: string) {
  const m = machine(options);
  const personal = remote(m, "personal", skills("skills/", "mine"));
  const work = clone(m, personal, "code/skills");
  const vendor = remote(m, "vendor", {
    "skills/tool/SKILL.md": lines("one", "two", "three", "four", "five"),
    "skills/tool/ref.md": "ref v1\n",
  });
  if (index) m.git(m.root, "config", "--global", `url.${vendor.url}.insteadOf`, index);
  const manifest = m.manifest({
    agents: ["claude-code", "codex"],
    sources: [
      { id: "personal", git: personal.url, path: work, skills: "skills/*", adopt: true },
      { id: "vendor", git: index ?? vendor.url },
      ...(index ? [{ id: "site", index }] : []),
    ],
  });
  expect((await m.run("init", manifest, "--no-hooks")).code).toBe(0);
  // Edited through the agent folder: the link leads into fleetrc's copy.
  const local = lines("one", "TWO (mine)", "three", "four", "five");
  writeFileSync(m.at(".claude/skills/tool/SKILL.md"), local);
  return { m, work, vendor, manifest, local };
}

describe("edited vendored skills", () => {
  it("4a. are never overwritten, and diff shows local against upstream", async () => {
    const { m, vendor, local } = await editedVendoredSkill();
    vendor.commit({
      "skills/tool/SKILL.md": lines("one", "two", "three", "four", "FIVE (theirs)"),
      "skills/tool/ref.md": "ref v2\n",
    });
    const report = await m.json("sync");
    expect(report.edited).toEqual([{ source: "vendor", skill: "tool", files: ["SKILL.md"] }]);
    expect(report.pending).toEqual([
      { source: "vendor", skill: "tool", reason: "edited", files: ["SKILL.md", "ref.md"] },
    ]);
    expect(read(m.at(".claude/skills/tool/SKILL.md"))).toBe(local);
    expect(read(m.at(".agents/skills/tool/ref.md"))).toBe("ref v1\n");
    const again = await m.json("sync");
    expect(read(m.at(".claude/skills/tool/SKILL.md"))).toBe(local);
    expect(again.pending.map((entry) => entry.skill)).toEqual(["tool"]);

    const diff = await m.run("diff", "tool");
    expect(diff.code).toBe(0);
    expect(diff.stdout).toContain("-TWO (mine)");
    expect(diff.stdout).toContain("+FIVE (theirs)");
    expect(diff.stdout).toContain("+ref v2");
  });

  it("4b. merge brings in an upstream change to other lines cleanly", async () => {
    const { m, vendor } = await editedVendoredSkill();
    vendor.commit({
      "skills/tool/SKILL.md": lines("one", "two", "three", "four", "FIVE (theirs)"),
      "skills/tool/ref.md": "ref v2\n",
    });
    await m.run("sync");
    const merge = await m.run("merge", "tool");
    expect(merge.code, merge.stdout + merge.stderr).toBe(0);
    expect(merge.stdout).toContain("merged: SKILL.md, ref.md");
    expect(read(m.at(".claude/skills/tool/SKILL.md"))).toBe(
      lines("one", "TWO (mine)", "three", "four", "FIVE (theirs)"),
    );
    expect(read(m.at(".claude/skills/tool/ref.md"))).toBe("ref v2\n");
    // The merged copy still counts as edited (against the new base), and nothing is pending.
    const report = await m.json("sync");
    expect(report.pending).toEqual([]);
    expect(report.edited).toEqual([{ source: "vendor", skill: "tool", files: ["SKILL.md"] }]);
    // A later upstream change to another line is held again, and merges again.
    vendor.commit({
      "skills/tool/SKILL.md": lines("one", "two", "three", "FOUR (theirs again)", "FIVE (theirs)"),
    });
    await m.run("sync");
    expect((await m.run("merge", "tool")).code).toBe(0);
    expect(read(m.at(".claude/skills/tool/SKILL.md"))).toBe(
      lines("one", "TWO (mine)", "three", "FOUR (theirs again)", "FIVE (theirs)"),
    );
  });

  it("4c. merge leaves conflict markers when both sides changed the same line", async () => {
    // status and doctor read the timer: a scheduler with none.
    const { m, vendor } = await editedVendoredSkill({ scheduler: "empty" });
    vendor.commit({
      "skills/tool/SKILL.md": lines("one", "TWO (theirs)", "three", "four", "five"),
    });
    await m.run("sync");
    const merge = await m.run("merge", "tool");
    expect(merge.code).toBe(1);
    expect(merge.stdout).toContain("conflicts: SKILL.md");
    const text = read(m.at(".claude/skills/tool/SKILL.md"));
    expect(text).toContain("<<<<<<< local\nTWO (mine)\n=======\nTWO (theirs)\n>>>>>>> upstream");
    // Nothing is pending after a merge, and sync does not touch the file with markers.
    const report = await m.json("sync");
    expect(report.pending).toEqual([]);
    expect(read(m.at(".claude/skills/tool/SKILL.md"))).toBe(text);
    // R7-17. The markers stay in the copy agents use, as git leaves them in a working tree, so
    // sync, status and doctor say the skill is held until they are resolved and merge runs again.
    expect(report.held).toEqual([
      {
        source: "vendor",
        reason: "tool has unresolved merge conflicts; resolve them, then run `fleetrc merge tool`",
        files: ["SKILL.md"],
      },
    ]);
    expect((await m.run("status")).stdout).toContain(
      "tool: unresolved merge conflicts in SKILL.md",
    );
    const doctor = await m.run("doctor");
    expect(doctor.stdout).toMatch(/^FAIL merge conflicts: tool: unresolved merge conflicts/m);
    const early = await m.run("merge", "tool");
    expect(early.code).toBe(1);
    expect(early.stderr).toContain("tool still has merge conflicts in SKILL.md");
    // Resolved by hand: merge records it, and says so instead of "no upstream change to merge".
    writeFileSync(
      m.at(".claude/skills/tool/SKILL.md"),
      lines("one", "TWO (both)", "three", "four", "five"),
    );
    const done = await m.run("merge", "tool");
    expect(done.code, done.stdout + done.stderr).toBe(0);
    expect(done.stdout).toContain("merged; nothing left to do");
    expect((await m.json("sync")).held).toEqual([]);
    expect((await m.run("status")).stdout).not.toContain("unresolved merge conflicts");
    expect((await m.run("merge", "tool")).stderr).toContain("has no upstream change to merge");
  });

  it("4d. fork moves the skill into the personal repository, records its base, and diff/merge follow upstream", async () => {
    const { m, work, vendor, manifest, local } = await editedVendoredSkill();
    const base = vendor.head();
    const fork = await m.run("fork", "tool");
    expect(fork.code, fork.stdout + fork.stderr).toBe(0);
    expect(read(join(work, "skills/tool/SKILL.md"))).toBe(local);
    expect(linkOf(m.at(".claude/skills/tool"))).toBe(join(work, "skills/tool"));
    expect(isLink(m.at(".agents/skills/tool"))).toBe(true);
    const saved = JSON.parse(read(manifest)) as {
      forks: Record<string, { from: string; path: string; base: string }>;
      sources: { exclude?: string[] }[];
    };
    expect(saved.forks.tool).toEqual({
      from: vendor.url,
      path: "skills/tool",
      base,
      upstream: "git",
    });
    expect(saved.sources[1]!.exclude).toEqual(["tool"]);
    expect(existsSync(join(m.stateDir, "store", "vendor", "live", "tool"))).toBe(false);

    vendor.commit({
      "skills/tool/SKILL.md": lines("one", "two", "three", "four", "FIVE (theirs)"),
    });
    const diff = await m.run("diff", "tool");
    expect(diff.stdout).toContain("+TWO (mine)");
    expect(diff.stdout).toContain("-FIVE (theirs)");
    const merge = await m.run("merge", "tool");
    expect(merge.code, merge.stdout + merge.stderr).toBe(0);
    expect(read(join(work, "skills/tool/SKILL.md"))).toBe(
      lines("one", "TWO (mine)", "three", "four", "FIVE (theirs)"),
    );
    expect((JSON.parse(read(manifest)) as typeof saved).forks.tool!.base).toBe(vendor.head());
    expect(names(m.at(".claude/skills"))).toEqual(["mine", "tool"]);
  });

  it("4d2. a fork without a base merges from nothing in common, then records the base", async () => {
    const { m, work, vendor, manifest } = await editedVendoredSkill({ scheduler: "empty" });
    expect((await m.run("fork", "tool")).code).toBe(0);
    const saved = JSON.parse(read(manifest)) as { forks: Record<string, { base?: string }> };
    delete saved.forks.tool!.base;
    writeFileSync(manifest, JSON.stringify(saved, null, 2));
    vendor.commit({
      "skills/tool/SKILL.md": lines("one", "two", "three", "four", "FIVE (theirs)"),
    });
    expect((await m.run("sync")).code).toBe(0);
    const status = await m.json<{ forks: { tool: { files: string[] } } }>("status");
    expect(status.forks.tool.files).toContain("SKILL.md");
    expect((await m.run("status")).stdout).toContain("tool: no recorded merge base");

    const merge = await m.run("merge", "tool");
    expect(merge.code).toBe(1);
    expect(merge.stdout).toContain("conflicts: SKILL.md");
    // git keeps the lines both sides share outside the markers.
    const text = read(join(work, "skills/tool/SKILL.md"));
    expect(text).toContain("description: The tool skill\n---\none\n<<<<<<< local\nTWO (mine)\n");
    expect(text).toContain("FIVE (theirs)\n>>>>>>> upstream\n");
    expect((JSON.parse(read(manifest)) as typeof saved).forks.tool!.base).toBe(vendor.head());
    expect((await m.run("status")).stdout).not.toContain("no recorded merge base");
  });

  it("4d3. a fork of a repository no source reads still hears of upstream changes", async () => {
    const { m, vendor, manifest } = await editedVendoredSkill({ scheduler: "empty" });
    expect((await m.run("fork", "tool")).code).toBe(0);
    const saved = JSON.parse(read(manifest)) as {
      sources: { id: string }[];
      forks: Record<string, { base: string }>;
    };
    saved.sources = saved.sources.filter((source) => source.id !== "vendor");
    saved.forks.tool!.base = vendor.head().slice(0, 9);
    writeFileSync(manifest, JSON.stringify(saved, null, 2));
    expect((await m.run("sync")).code).toBe(0);
    expect(
      (await m.json<{ forks: { tool: { files: string[] } } }>("status")).forks.tool.files,
    ).toEqual([]);

    vendor.commit({
      "skills/tool/SKILL.md": lines("one", "two", "three", "four", "FIVE (theirs)"),
    });
    for (const command of ["sync", "update"]) {
      const targeted = await m.json(command, "personal");
      expect(targeted.pending).toEqual([]);
      expect(targeted.warnings.join("\n")).not.toContain("could not tell whether tool");
    }
    const sync = await m.run("sync");
    expect(sync.code, sync.stdout + sync.stderr).toBe(0);
    expect(sync.stdout).toContain(
      `fork tool: ${vendor.url} changed it since you forked it (SKILL.md)`,
    );
    const status = await m.json<{ forks: { tool: { upstream: string; files: string[] } } }>(
      "status",
    );
    expect(status.forks.tool).toMatchObject({ upstream: vendor.head(), files: ["SKILL.md"] });
    // Said once for each upstream version.
    expect((await m.run("sync")).stdout).not.toContain("fork tool:");
  });

  it("keeps credentials out of standalone fork reports after successful and failed fetches", async () => {
    const { m, vendor, manifest } = await editedVendoredSkill();
    expect((await m.run("fork", "tool")).code).toBe(0);
    const saved = JSON.parse(read(manifest)) as {
      sources: { id: string }[];
      forks: Record<string, { from: string }>;
    };
    saved.sources = saved.sources.filter((source) => source.id !== "vendor");
    const authenticated = "https://fixture-user:fixture-secret@fork.invalid/vendor.git";
    saved.forks.tool!.from = authenticated;
    writeFileSync(manifest, JSON.stringify(saved));
    m.git(m.root, "config", "--global", "protocol.https.allow", "never");
    m.git(m.root, "config", "--global", `url.${vendor.url}.insteadOf`, authenticated);
    vendor.commit({ "skills/tool/ref.md": "ref v2\n" });

    const checkReport = async () => {
      const result = await m.run("sync", "--json");
      expect(result.code).toBe(0);
      expect(result.stdout + result.stderr).not.toMatch(/fixture-user|fixture-secret/);
      expect(read(join(m.stateDir, "last-run.json"))).not.toMatch(/fixture-user|fixture-secret/);
      return JSON.parse(result.stdout) as Report;
    };
    expect((await checkReport()).pending).toContainEqual({
      source: "https://fork.invalid/vendor.git",
      skill: "tool",
      reason: "fork",
      files: ["ref.md"],
    });

    m.git(m.root, "config", "--global", "--unset", `url.${vendor.url}.insteadOf`);
    const failed = await checkReport();
    expect(failed.warnings.join("\n")).toContain("could not tell whether tool changed upstream");
    expect(failed.pending).toEqual([]);
  });

  it("does not fetch a legacy index fork after its source is removed", async () => {
    const m = machine();
    const personal = remote(m, "personal", skills("skills/", "tool"));
    const work = clone(m, personal, "code/skills");
    const index = "https://index.invalid/catalog";
    const manifest = m.manifest({
      agents: ["claude-code"],
      sources: [{ id: "personal", git: personal.url, path: work }],
      forks: { tool: { from: index, path: "tool", base: "unknown" } },
    });
    m.git(m.root, "config", "--global", "protocol.https.allow", "never");
    expect((await m.run("init", manifest, "--no-hooks")).code).toBe(0);
    const report = await m.json("sync");
    expect(report.pending).toEqual([]);
    expect(report.warnings.join("\n")).not.toContain("could not tell whether tool");
  });

  it("checks new and source-backed legacy Git forks when an index uses the same URL", async () => {
    const site = await http();
    serveIndexV2(site, [{ name: "drop", files: { "SKILL.md": skillMd("drop") } }]);
    const { m, vendor, manifest } = await editedVendoredSkill({}, site.url);
    const fork = await m.run("fork", "tool");
    expect(fork.code, fork.stdout + fork.stderr).toBe(0);
    const recorded = read(manifest);
    const saved = JSON.parse(read(manifest)) as {
      sources: { id: string; index?: string }[];
      forks: Record<string, { from: string; path: string; upstream?: string; base?: string }>;
    };
    const provenance = saved.forks.tool!.upstream;
    delete saved.forks.tool!.upstream;
    saved.forks.drop = { from: site.url, path: "drop", upstream: "index" };
    writeFileSync(manifest, JSON.stringify(saved));
    vendor.commit({ "skills/tool/ref.md": "ref v2\n" });
    expect((await m.json("sync")).pending).toContainEqual({
      source: "vendor",
      skill: "tool",
      reason: "fork",
      files: ["ref.md"],
    });
    const legacyDiff = await m.run("diff", "tool");
    expect(legacyDiff.code, legacyDiff.stdout + legacyDiff.stderr).toBe(0);
    const indexDiff = await m.run("diff", "drop");
    expect(indexDiff.stderr).toContain("is not a git repository");
    expect((await m.run("status")).stdout).not.toContain("`fleetrc merge drop`");

    saved.forks.drop = { from: site.url, path: "skills/tool", base: "unknown" };
    writeFileSync(manifest, JSON.stringify(saved));
    expect((await m.json("sync")).warnings.join("\n")).not.toContain("could not tell whether drop");
    for (const command of ["diff", "merge"]) {
      expect((await m.run(command, "drop")).stderr).toContain("is not a git repository");
    }
    delete saved.forks.drop.base;
    writeFileSync(manifest, JSON.stringify(saved));
    expect((await m.run("status")).stdout).not.toContain("`fleetrc merge drop`");

    expect(provenance).toBe("git");
    const standalone = JSON.parse(recorded) as typeof saved;
    standalone.sources = standalone.sources.filter((source) => source.id !== "vendor");
    writeFileSync(manifest, JSON.stringify(standalone));
    vendor.commit({ "skills/tool/ref.md": "ref v3\n" });
    const report = await m.json("sync");
    expect(report.pending).toContainEqual({
      source: `${site.url}/`,
      skill: "tool",
      reason: "fork",
      files: ["ref.md"],
    });
    expect(read(m.at(".claude/skills/drop/SKILL.md"))).toBe(skillMd("drop"));
    for (const command of ["diff", "merge"]) {
      const result = await m.run(command, "tool");
      expect(result.code, result.stdout + result.stderr).toBe(0);
    }
  });

  it("reports both directions of empty-file conflicts without a fork base", async () => {
    const { m, work, vendor, manifest } = await editedVendoredSkill();
    expect((await m.run("fork", "tool")).code).toBe(0);
    const saved = JSON.parse(read(manifest)) as { forks: Record<string, { base?: string }> };
    delete saved.forks.tool!.base;
    writeFileSync(manifest, JSON.stringify(saved, null, 2));
    const dir = join(work, "skills/tool");
    writeFileSync(join(dir, "ref.md"), "");
    writeFileSync(join(dir, "notes.md"), "local notes\n");
    vendor.commit({ "skills/tool/notes.md": "" });

    const merge = await m.run("merge", "tool");
    expect(merge.stdout, merge.stderr).toContain("conflicts: SKILL.md, notes.md, ref.md");
    expect(merge.code).toBe(1);
    expect(read(join(dir, "ref.md"))).toBe("");
    expect(read(join(dir, "ref.md.upstream"))).toBe("ref v1\n");
    expect(read(join(dir, "notes.md"))).toBe("local notes\n");
    expect(read(join(dir, "notes.md.upstream"))).toBe("");
  });

  it("explains how to recover a legacy placeholder without reserving the ref name", async () => {
    const { m, vendor, manifest } = await editedVendoredSkill();
    expect((await m.run("fork", "tool")).code).toBe(0);
    const saved = JSON.parse(read(manifest)) as { forks: Record<string, { base: string }> };
    saved.forks.tool!.base = "unknown";
    writeFileSync(manifest, JSON.stringify(saved, null, 2));

    const missing = await m.run("merge", "tool");
    expect(missing.code).toBe(1);
    expect(missing.stderr).toContain('remove "base" from "forks"."tool"');
    expect(read(manifest)).toContain('"base": "unknown"');

    m.git(vendor.work, "push", "origin", "HEAD:refs/heads/unknown");
    const valid = await m.run("merge", "tool");
    expect(valid.code, valid.stdout + valid.stderr).toBe(0);
    expect((JSON.parse(read(manifest)) as typeof saved).forks.tool!.base).toBe(vendor.head());
  });

  it("4e. an unedited vendored skill updates in place", async () => {
    const m = machine();
    const vendor = remote(m, "vendor", skills("skills/", "plain"));
    const manifest = m.manifest({
      agents: ["claude-code"],
      sources: [{ id: "vendor", git: vendor.url }],
    });
    expect((await m.run("init", manifest, "--no-hooks")).code).toBe(0);
    vendor.commit({ "skills/plain/SKILL.md": skillMd("plain", "v2") });
    const report = await m.json("sync");
    expect(report.skills.updated).toEqual(["plain"]);
    expect(read(m.at(".claude/skills/plain/SKILL.md"))).toBe(skillMd("plain", "v2"));
  });
});

describe("forks of sources without git history", () => {
  it("fork refuses a skill of an index or npm source, which diff and merge could never compare with", async () => {
    const m = machine();
    const personal = remote(m, "personal", skills("skills/", "mine"));
    const work = clone(m, personal, "code/skills");
    const site = await http();
    serveIndexV2(site, [{ name: "drop", files: { "SKILL.md": skillMd("drop") } }]);
    const manifest = m.manifest({
      agents: ["claude-code"],
      sources: [
        { id: "personal", git: personal.url, path: work, skills: "skills/*", adopt: true },
        { id: "site", index: site.url },
      ],
    });
    expect((await m.run("init", manifest, "--no-hooks")).code).toBe(0);
    const fork = await m.run("fork", "drop");
    expect(fork.code).toBe(1);
    expect(fork.stderr).toContain(
      "fork follows a skill's upstream through its git history, and site is an index site",
    );
    // Nothing moved, and the manifest records no fork.
    expect(existsSync(join(work, "skills", "drop"))).toBe(false);
    expect(JSON.parse(read(manifest)).forks).toBeUndefined();
    // A fork an older fleetrc recorded is refused by diff and merge with the same reason.
    const raw = JSON.parse(read(manifest));
    raw.forks = { drop: { from: site.url, path: "drop", base: "x" } };
    writeFileSync(manifest, JSON.stringify(raw));
    for (const command of ["diff", "merge"]) {
      const run = await m.run(command, "drop");
      expect(run.code).toBe(1);
      expect(run.stderr).toContain(
        `drop was forked from ${site.url}, which is not a git repository`,
      );
    }
  });
});
