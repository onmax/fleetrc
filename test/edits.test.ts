import {
  chmodSync,
  existsSync,
  mkdirSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it, vi } from "vite-plus/test";
import { copyDir, hashDir, listFiles, sha256 } from "../src/fs.ts";
import { paths } from "../src/paths.ts";
import {
  clone,
  http,
  isLink,
  linkOf,
  machine,
  names,
  read,
  remote,
  serveIndexV2,
  skillMd,
  skills,
} from "./fixture.ts";

const lines = (...body: string[]) =>
  `---\nname: tool\ndescription: The tool skill\n---\n${body.join("\n")}\n`;

async function editedVendoredSkill(options: Parameters<typeof machine>[0] = {}) {
  const m = machine(options);
  const personal = remote(m, "personal", skills("skills/", "mine"));
  const work = clone(m, personal, "code/skills");
  const vendor = remote(m, "vendor", {
    "skills/tool/SKILL.md": lines("one", "two", "three", "four", "five"),
    "skills/tool/ref.md": "ref v1\n",
  });
  const manifest = m.manifest({
    agents: ["claude-code", "codex"],
    sources: [
      { id: "personal", git: personal.url, path: work, skills: "skills/*", adopt: true },
      { id: "vendor", git: vendor.url },
    ],
  });
  expect((await m.run("init", manifest, "--no-hooks")).code).toBe(0);
  // Edited through the agent folder: the link leads into fleetrc's copy.
  const local = lines("one", "TWO (mine)", "three", "four", "five");
  writeFileSync(m.at(".claude/skills/tool/SKILL.md"), local);
  return { m, work, vendor, manifest, local };
}

async function pendingTopicReplacement(upstreamIsFolder = false) {
  const { m, vendor } = await editedVendoredSkill({ scheduler: "empty" });
  const topic = m.at(".claude/skills/tool/topic");
  vendor.commit(
    upstreamIsFolder
      ? { "skills/tool/topic": "topic v1\n" }
      : { "skills/tool/topic/notes.md": "notes v1\n" },
  );
  await m.run("sync");
  expect((await m.run("merge", "tool")).code).toBe(0);
  rmSync(join(vendor.work, "skills/tool/topic"), { recursive: true });
  vendor.commit(
    upstreamIsFolder
      ? {
          "skills/tool/topic/notes.md": "notes v2\n",
          "skills/tool/topic/extra.md": "extra v2\n",
        }
      : { "skills/tool/topic": "topic v2\n" },
  );
  await m.run("sync");
  return { m, topic };
}

function mergeWithFilesystemHook(m: ReturnType<typeof machine>, hook: string) {
  const preload = join(m.root, "merge-hook.mjs");
  writeFileSync(
    preload,
    `
    import fs from "node:fs";
    import { basename, dirname } from "node:path";
    import { syncBuiltinESMExports } from "node:module";
    ${hook}
    syncBuiltinESMExports();
  `,
  );
  return m.runWith(
    { env: { NODE_OPTIONS: `${m.env.NODE_OPTIONS} --import=${pathToFileURL(preload).href}` } },
    "merge",
    "tool",
  );
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
    expect(saved.forks.tool).toEqual({ from: vendor.url, path: "skills/tool", base });
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

  it("4f. merge replaces a folder upstream turned into a file, or reports a conflict when the folder has local edits", async () => {
    for (const edited of [false, true]) {
      const { m, vendor } = await editedVendoredSkill({ scheduler: "empty" });
      vendor.commit({ "skills/tool/topic/notes.md": "notes v1\n" });
      await m.run("sync");
      expect((await m.run("merge", "tool")).code).toBe(0);
      if (edited) writeFileSync(m.at(".claude/skills/tool/topic/notes.md"), "notes (mine)\n");
      rmSync(join(vendor.work, "skills/tool/topic"), { recursive: true });
      vendor.commit({ "skills/tool/ref.md": "ref v2\n", "skills/tool/topic": "topic v2\n" });
      await m.run("sync");
      const dry = await m.run("merge", "tool", "--dry-run");
      expect(dry.code, dry.stdout + dry.stderr).toBe(0);
      expect(dry.stdout).toContain(edited ? "would conflict: topic" : "would merge: ref.md, topic");
      expect(read(m.at(".claude/skills/tool/ref.md"))).toBe("ref v1\n");
      const merge = await m.run("merge", "tool");
      expect(read(m.at(".claude/skills/tool/ref.md"))).toBe("ref v2\n");
      if (!edited) {
        expect(merge.code, merge.stdout + merge.stderr).toBe(0);
        expect(read(m.at(".claude/skills/tool/topic"))).toBe("topic v2\n");
        expect((await m.json("sync")).pending).toEqual([]);
        continue;
      }
      expect(merge.code, merge.stdout + merge.stderr).toBe(1);
      expect(merge.stdout).toContain("conflicts: topic");
      expect(read(m.at(".claude/skills/tool/topic/notes.md"))).toBe("notes (mine)\n");
      expect(read(m.at(".claude/skills/tool/topic.upstream"))).toBe("topic v2\n");
      // Resolved by taking upstream's file: the next merge records it.
      rmSync(m.at(".claude/skills/tool/topic"), { recursive: true });
      renameSync(m.at(".claude/skills/tool/topic.upstream"), m.at(".claude/skills/tool/topic"));
      const done = await m.run("merge", "tool");
      expect(done.code, done.stdout + done.stderr).toBe(0);
      expect((await m.json("sync")).held).toEqual([]);
    }
  });

  it("merges a file over the empty folder left by an earlier merge", async () => {
    const { m, vendor } = await editedVendoredSkill({ scheduler: "empty" });
    const topic = m.at(".claude/skills/tool/topic");
    vendor.commit({ "skills/tool/topic/notes.md": "notes v1\n" });
    await m.run("sync");
    expect((await m.run("merge", "tool")).code).toBe(0);
    vendor.commit({ "skills/tool/topic": null });
    await m.run("sync");
    expect((await m.run("merge", "tool")).code).toBe(0);
    expect(names(topic)).toEqual([]);

    vendor.commit({ "skills/tool/topic": "topic v2\n" });
    await m.run("sync");
    const dry = await m.run("merge", "tool", "--dry-run");
    expect(dry.code, dry.stdout + dry.stderr).toBe(0);
    expect(names(topic)).toEqual([]);
    const merge = await m.run("merge", "tool");
    expect(merge.code, merge.stdout + merge.stderr).toBe(0);
    expect(dry.stdout, dry.stderr).toContain("would merge: topic");
    expect(read(topic)).toBe("topic v2\n");
  });

  it("keeps a save in a folder while an earlier file is being merged", async () => {
    const { m, vendor } = await editedVendoredSkill({ scheduler: "empty" });
    const topic = m.at(".claude/skills/tool/topic");
    const saved = "notes saved during merge\n";
    vendor.commit({ "skills/tool/topic/notes.md": "notes v1\n" });
    await m.run("sync");
    expect((await m.run("merge", "tool")).code).toBe(0);
    rmSync(join(vendor.work, "skills/tool/topic"), { recursive: true });
    vendor.commit({
      "skills/tool/SKILL.md": lines("one", "two", "three", "four", "FIVE (theirs)"),
      "skills/tool/topic": "topic v2\n",
    });
    await m.run("sync");

    const preload = join(m.root, "save-during-merge.mjs");
    writeFileSync(
      preload,
      `
      import child from "node:child_process";
      import { writeFileSync } from "node:fs";
      import { syncBuiltinESMExports } from "node:module";
      const spawn = child.spawn;
      child.spawn = (command, args, options) => {
        const process = spawn(command, args, options);
        if (command === "git" && args.includes("merge-file")) {
          writeFileSync(${JSON.stringify(join(topic, "notes.md"))}, ${JSON.stringify(saved)});
        }
        return process;
      };
      syncBuiltinESMExports();
      `,
    );
    const merge = await m.runWith(
      { env: { NODE_OPTIONS: `${m.env.NODE_OPTIONS} --import=${pathToFileURL(preload).href}` } },
      "merge",
      "tool",
    );
    expect(merge.code, merge.stdout + merge.stderr).toBe(1);
    expect(merge.stdout).toContain("conflicts: topic");
    expect(read(join(topic, "notes.md"))).toBe(saved);
    expect(read(`${topic}.upstream`)).toBe("topic v2\n");
  });

  it.each([false, true])("keeps a save at publication (folder: %s)", async (upstreamIsFolder) => {
    const { m, topic } = await pendingTopicReplacement(upstreamIsFolder);
    const saved = join(m.root, "saved-path");
    const merge = await mergeWithFilesystemHook(
      m,
      `
      const mkdir = fs.mkdirSync;
      const rename = fs.renameSync;
      const link = fs.linkSync;
      const save = (path) => {
        if (basename(path) !== "topic") return;
        if (${upstreamIsFolder}) mkdir(path);
        else fs.writeFileSync(path, "saved at publication\\n");
      };
      fs.mkdirSync = (path, ...args) => {
        save(path);
        return mkdir(path, ...args);
      };
      fs.renameSync = (from, to) => {
        if (basename(to) === "unit" && basename(from) === "topic") {
          fs.writeFileSync(${JSON.stringify(saved)}, to);
        }
        if (basename(from) === "next") save(to);
        return rename(from, to);
      };
      fs.linkSync = (from, to) => {
        if (basename(from) === "next") save(to);
        return link(from, to);
      };
    `,
    );
    if (upstreamIsFolder) expect(names(topic)).toEqual([]);
    else expect(read(topic)).toBe("saved at publication\n");
    expect(merge.code, merge.stdout + merge.stderr).toBe(1);
    expect(merge.stderr).toContain(read(saved));
    expect(read(upstreamIsFolder ? read(saved) : join(read(saved), "notes.md"))).toBe(
      upstreamIsFolder ? "topic v1\n" : "notes v1\n",
    );
  });

  it.each([false, true])("recovers an interrupted replacement (new save: %s)", async (newSave) => {
    const { m, topic } = await pendingTopicReplacement();
    const saved = join(m.root, "saved-path");
    const interrupted = await mergeWithFilesystemHook(
      m,
      `
      const rename = fs.renameSync;
      fs.renameSync = (from, to) => {
        rename(from, to);
        if (basename(from) === "topic" && basename(to) === "unit") {
          fs.writeFileSync(${JSON.stringify(saved)}, to);
          process.exit(99);
        }
      };
    `,
    );
    expect(interrupted.code, interrupted.stdout + interrupted.stderr).toBe(99);
    expect(existsSync(topic)).toBe(false);
    const liveNames = readdirSync(m.at(".claude/skills/tool"));
    expect(liveNames.some((name) => name.startsWith(".fleetrc-merge-"))).toBe(false);
    const dry = await m.run("merge", "tool", "--dry-run");
    expect(dry.stderr).toContain("rerun without --dry-run to recover");
    expect(existsSync(topic)).toBe(false);
    if (newSave) writeFileSync(topic, "saved after interruption\n");
    const retry = await m.run("merge", "tool");
    if (newSave) {
      expect(retry.code, retry.stdout + retry.stderr).toBe(1);
      expect(retry.stderr).toContain(read(saved));
      expect(read(topic)).toBe("saved after interruption\n");
      expect(read(join(read(saved), "notes.md"))).toBe("notes v1\n");
    } else {
      expect(retry.code, retry.stdout + retry.stderr).toBe(0);
      expect(read(topic)).toBe("topic v2\n");
      expect(existsSync(read(saved))).toBe(false);
    }
  });

  it.each([false, true])(
    "resumes publication after its first link (folder: %s)",
    async (folder) => {
      const { m, topic } = await pendingTopicReplacement(folder);
      const interrupted = await mergeWithFilesystemHook(
        m,
        `
      const link = fs.linkSync;
      fs.linkSync = (from, to) => {
        link(from, to);
        if (basename(from) === "next" || basename(dirname(from)) === "next") process.exit(99);
      };
    `,
      );
      expect(interrupted.code, interrupted.stdout + interrupted.stderr).toBe(99);
      if (folder) expect(names(topic)).toHaveLength(1);
      const retry = await m.run("merge", "tool");
      expect(retry.code, retry.stdout + retry.stderr).toBe(0);
      if (folder) {
        expect(read(join(topic, "notes.md"))).toBe("notes v2\n");
        expect(read(join(topic, "extra.md"))).toBe("extra v2\n");
      } else expect(read(topic)).toBe("topic v2\n");
    },
  );

  it("does not treat a scratch-shaped local directory as a workspace", async () => {
    const { m, topic } = await pendingTopicReplacement();
    const folder = join(topic, `.fleetrc-merge-${"a".repeat(64)}-abcdef`);
    mkdirSync(folder);
    const draft = join(folder, "draft.md");
    writeFileSync(draft, "local draft\n");
    const copied = join(m.root, "copied-topic");
    copyDir(topic, copied);
    expect(read(join(copied, folder.slice(topic.length), "draft.md"))).toBe("local draft\n");

    const merge = await m.run("merge", "tool");
    expect(merge.stdout, merge.stderr).toContain("conflicts: topic");
    expect(read(draft)).toBe("local draft\n");
    expect(read(`${topic}.upstream`)).toBe("topic v2\n");
  });

  it("keeps a save through an open handle after publication approval", async () => {
    const { m, topic } = await pendingTopicReplacement();
    const saved = join(m.root, "saved-path");
    const interrupted = await mergeWithFilesystemHook(
      m,
      `
      let draft = process.platform === "win32" ? undefined : fs.openSync(${JSON.stringify(join(topic, "notes.md"))}, "a");
      const rename = fs.renameSync;
      fs.renameSync = (from, to) => {
        rename(from, to);
        if (basename(to) === "unit") {
          draft ??= fs.openSync(to + "/notes.md", "a");
          fs.writeFileSync(${JSON.stringify(saved)}, to);
        }
        if (basename(to) === "publish") {
          fs.writeSync(draft, "saved after approval\\n");
          process.exit(99);
        }
      };
      `,
    );
    expect(interrupted.code, interrupted.stdout + interrupted.stderr).toBe(99);
    const retry = await m.run("merge", "tool");
    expect(retry.code, retry.stdout + retry.stderr).toBe(1);
    expect(retry.stderr).toContain(read(saved));
    expect(read(join(read(saved), "notes.md"))).toBe("notes v1\nsaved after approval\n");
  });

  it.each([false, true])(
    "resumes after creating a directory before recording its identity (publish: %s)",
    async (publishing) => {
      const { m, topic } = await pendingTopicReplacement(publishing);
      const interrupted = await mergeWithFilesystemHook(
        m,
        `
        const rename = fs.renameSync;
        const mkdir = fs.mkdirSync;
        fs.renameSync = (from, to) => {
          if (!${publishing} && basename(to) === "unit") {
            fs.writeFileSync(from + "/draft.md", "draft");
          }
          return rename(from, to);
        };
        fs.mkdirSync = (path, ...args) => {
          const made = mkdir(path, ...args);
          if (basename(path) === "topic") process.exit(99);
          return made;
        };
        `,
      );
      expect(interrupted.code, interrupted.stdout + interrupted.stderr).toBe(99);
      expect(names(topic)).toEqual([]);
      const retry = await m.run("merge", "tool");
      if (publishing) {
        expect(retry.code, retry.stdout + retry.stderr).toBe(0);
        expect(read(join(topic, "notes.md"))).toBe("notes v2\n");
      } else {
        expect(retry.stdout, retry.stderr).toContain("conflicts: topic");
        expect(read(join(topic, "draft.md"))).toBe("draft");
      }
    },
  );

  it.each(["unchanged", "edited", "partially removed"])(
    "checks the saved original on retirement retry (%s)",
    async (state) => {
      const { m, topic } = await pendingTopicReplacement();
      const marker = join(m.root, "retirement-path");
      const partial = state === "partially removed";
      const edited = state === "edited";
      const interrupted = await mergeWithFilesystemHook(
        m,
        `
      const write = fs.writeFileSync;
      const rename = fs.renameSync;
      const unlink = fs.unlinkSync;
      const stop = (path) => {
        if (basename(path) !== "retired") return;
        write(${JSON.stringify(marker)}, dirname(path));
        if (!${partial}) process.exit(99);
      };
      fs.writeFileSync = (path, ...args) => { write(path, ...args); stop(path); };
      fs.renameSync = (from, to) => { rename(from, to); stop(to); };
      fs.unlinkSync = (path) => {
        unlink(path);
        if (${partial} && basename(path) === "notes.md" && basename(dirname(path)) === "unit") process.exit(99);
      };
    `,
      );
      expect(interrupted.code, interrupted.stdout + interrupted.stderr).toBe(99);
      const saved = join(read(marker), "previous", "unit", "notes.md");
      if (edited) writeFileSync(saved, "late draft\n");
      const retry = await m.run("merge", "tool");
      expect(retry.code, retry.stdout + retry.stderr).toBe(edited ? 1 : 0);
      if (edited) {
        expect(retry.stderr).toContain(dirname(saved));
        expect(read(saved)).toBe("late draft\n");
      } else expect(existsSync(saved)).toBe(false);
      expect(read(topic)).toBe("topic v2\n");
    },
  );

  it("omits a preserved fallback backup from skill walks after recovery", async () => {
    const { m, topic } = await pendingTopicReplacement(true);
    const live = realpathSync(dirname(topic));
    const interrupted = await mergeWithFilesystemHook(
      m,
      `
      const mkdtemp = fs.mkdtempSync;
      const mkdir = fs.mkdirSync;
      fs.mkdtempSync = (prefix, ...args) => {
        if (dirname(prefix) === ${JSON.stringify(dirname(live))} && basename(prefix).startsWith(".fleetrc-merge-")) {
          throw Object.assign(new Error("read-only skill parent"), { code: "EACCES" });
        }
        return mkdtemp(prefix, ...args);
      };
      fs.mkdirSync = (path, ...args) => {
        const made = mkdir(path, ...args);
        if (basename(path) === "topic") process.exit(99);
        return made;
      };
    `,
    );
    expect(interrupted.code, interrupted.stdout + interrupted.stderr).toBe(99);
    const moved = join(m.root, "preserved-path");
    const retry = await mergeWithFilesystemHook(
      m,
      `
      const rename = fs.renameSync;
      fs.renameSync = (from, to) => {
        if (basename(from) === "topic" && basename(to) === "topic") {
          fs.writeFileSync(from + "/draft.md", "late draft\\n");
          fs.writeFileSync(${JSON.stringify(moved)}, to);
        }
        return rename(from, to);
      };
    `,
    );
    expect(retry.code, retry.stdout + retry.stderr).toBe(0);
    const preserved = read(moved);
    expect(read(join(preserved, "draft.md"))).toBe("late draft\n");
    vi.stubEnv("XDG_STATE_HOME", m.env.XDG_STATE_HOME);
    try {
      const expected = ["SKILL.md", "ref.md", "topic/extra.md", "topic/notes.md"];
      expect(Object.keys(hashDir(live))).toEqual(expected);
      expect(listFiles(live).sort()).toEqual(expected);
      const copied = join(m.root, "copied-skill");
      copyDir(live, copied);
      expect(listFiles(copied).sort()).toEqual(expected);
    } finally {
      vi.unstubAllEnvs();
    }
    expect(retry.stdout + retry.stderr).toContain(preserved);
  });

  it.skipIf(process.platform === "win32" || process.getuid?.() === 0)(
    "only blocks trees affected by an unreadable merge pointer",
    () => {
      const m = machine();
      const live = join(realpathSync(m.root), "skill");
      const scratch = join(live, `.fleetrc-merge-${sha256("skill")}-abcdef`);
      const unrelated = join(realpathSync(m.root), "unrelated");
      mkdirSync(scratch, { recursive: true });
      mkdirSync(unrelated);
      writeFileSync(join(scratch, "draft.md"), "private draft\n");
      writeFileSync(join(unrelated, "build.js"), "build\n");
      vi.stubEnv("XDG_STATE_HOME", m.env.XDG_STATE_HOME);
      const pointer = join(paths.mergeRecovery(), sha256(live));
      try {
        mkdirSync(dirname(pointer), { recursive: true });
        writeFileSync(pointer, scratch, { mode: 0o000 });
        expect(Object.keys(hashDir(unrelated))).toEqual(["build.js"]);
        expect(() => hashDir(live)).toThrow(pointer);
        expect(() => copyDir(live, join(m.root, "copy"))).toThrow(pointer);
      } finally {
        vi.unstubAllEnvs();
      }
    },
  );

  it.skipIf(process.platform === "win32" || process.getuid?.() === 0)(
    "resumes restoring a read-only subdirectory without losing a saved draft",
    async () => {
      const { m, topic } = await pendingTopicReplacement();
      const interrupted = await mergeWithFilesystemHook(
        m,
        `
        const rename = fs.renameSync;
        const link = fs.linkSync;
        fs.renameSync = (from, to) => {
          if (basename(from) === "topic" && basename(to) === "unit") {
            fs.mkdirSync(from + "/nested");
            fs.writeFileSync(from + "/nested/draft.md", "draft");
            fs.chmodSync(from + "/nested", 0o555);
          }
          return rename(from, to);
        };
        fs.linkSync = (from, to) => {
          link(from, to);
          if (basename(from) === "draft.md") process.exit(99);
        };
      `,
      );
      try {
        expect(interrupted.code, interrupted.stdout + interrupted.stderr).toBe(99);
        const retry = await m.run("merge", "tool");
        expect(retry.stdout).toContain("conflicts: topic");
        expect(read(join(topic, "nested/draft.md"))).toBe("draft");
        expect(statSync(join(topic, "nested")).mode & 0o777).toBe(0o555);
        expect(read(`${topic}.upstream`)).toBe("topic v2\n");
      } finally {
        if (existsSync(join(topic, "nested"))) chmodSync(join(topic, "nested"), 0o755);
      }
    },
  );

  it.skipIf(process.platform === "win32" || process.getuid?.() === 0)(
    "stages and recovers a replacement when the skill's parent is read-only",
    async () => {
      const { m, topic } = await pendingTopicReplacement();
      const live = realpathSync(dirname(topic));
      const parent = dirname(live);
      chmodSync(parent, 0o555);
      try {
        const interrupted = await mergeWithFilesystemHook(
          m,
          `
          const rename = fs.renameSync;
          fs.renameSync = (from, to) => {
            rename(from, to);
            if (basename(from) === "topic" && basename(to) === "unit") process.exit(99);
          };
        `,
        );
        expect(interrupted.code, interrupted.stdout + interrupted.stderr).toBe(99);
        const scratch = readdirSync(live).find((name) => name.startsWith(".fleetrc-merge-"));
        expect(scratch).toBeDefined();
        vi.stubEnv("XDG_STATE_HOME", m.env.XDG_STATE_HOME);
        try {
          expect(Object.keys(hashDir(live))).toEqual(["SKILL.md", "ref.md"]);
          expect(listFiles(live).sort()).toEqual(["SKILL.md", "ref.md"]);
        } finally {
          vi.unstubAllEnvs();
        }
        const retry = await m.run("merge", "tool");
        expect(retry.code, retry.stdout + retry.stderr).toBe(0);
        expect(read(topic)).toBe("topic v2\n");
        expect(readdirSync(live)).not.toContain(scratch);
      } finally {
        chmodSync(parent, 0o755);
      }
    },
  );

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
