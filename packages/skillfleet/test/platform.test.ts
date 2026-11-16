import { lstatSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vite-plus/test";
import {
  clone,
  isLink,
  isWindows,
  linkOf,
  machine,
  names,
  read,
  remote,
  skillMd,
  skills,
} from "./fixture.ts";

describe("links on each OS", () => {
  it.runIf(isWindows)(
    "12a. Windows: skill folders are directory junctions into the source",
    async () => {
      const m = machine();
      const personal = remote(m, "personal", skills("skills/", "win"));
      const work = clone(m, personal, "code/skills");
      const manifest = m.manifest({
        agents: ["claude-code", "codex"],
        sources: [{ id: "personal", git: personal.url, path: work, skills: "skills/*" }],
      });
      const init = await m.run("init", manifest, "--no-timer");
      expect(init.code, init.stdout + init.stderr).toBe(0);
      const link = m.at(".claude/skills/win");
      expect(lstatSync(link).isSymbolicLink()).toBe(true);
      expect(linkOf(link)).toBe(join(work, "skills/win"));
      const manifestFile = JSON.parse(read(m.at(".claude/skills/.skillfleet-manifest.json"))) as {
        links: Record<string, { kind: string }>;
      };
      expect(manifestFile.links.win!.kind).toBe("junction");
      // Editing through the junction edits the working clone.
      writeFileSync(join(link, "SKILL.md"), skillMd("win", "edited"));
      expect(read(join(work, "skills/win/SKILL.md"))).toBe(skillMd("win", "edited"));
      // Removing the skill removes only the junction, never the clone's folder.
      personal.commit({ "skills/win": null });
      m.git(work, "checkout", "--", ".");
      await m.run("sync");
      expect(names(m.at(".claude/skills"))).toEqual([]);
    },
  );

  it.skipIf(isWindows)(
    "12a. Unix: skill folders are symlinks (junctions are Windows-only)",
    async () => {
      const m = machine();
      const vendor = remote(m, "vendor", skills("skills/", "unix"));
      const manifest = m.manifest({
        agents: ["claude-code"],
        sources: [{ id: "vendor", git: vendor.url }],
      });
      expect((await m.run("init", manifest, "--no-timer")).code).toBe(0);
      const record = JSON.parse(read(m.at(".claude/skills/.skillfleet-manifest.json"))) as {
        links: Record<string, { kind: string }>;
      };
      expect(record.links.unix!.kind).toBe("symlink");
    },
  );

  it("12b. --copy writes real folders, refreshes them on change, and never overwrites an edited copy", async () => {
    const m = machine();
    const vendor = remote(m, "vendor", skills("skills/", "copied", "other"));
    const manifest = m.manifest({
      agents: ["claude-code", "cursor"],
      sources: [{ id: "vendor", git: vendor.url }],
    });
    const init = await m.run("init", manifest, "--no-timer", "--copy");
    expect(init.code, init.stdout + init.stderr).toBe(0);
    for (const dir of [".claude/skills", ".cursor/skills"]) {
      expect(names(m.at(dir))).toEqual(["copied", "other"]);
      expect(isLink(m.at(dir, "copied"))).toBe(false);
    }
    const record = JSON.parse(read(m.at(".claude/skills/.skillfleet-manifest.json"))) as {
      links: Record<string, { kind: string }>;
    };
    expect(record.links.copied!.kind).toBe("copy");

    vendor.commit({
      "skills/copied/SKILL.md": skillMd("copied", "v2"),
      "skills/other/SKILL.md": skillMd("other", "v2"),
    });
    writeFileSync(m.at(".cursor/skills/other/SKILL.md"), skillMd("other", "edited copy"));
    const report = await m.json("sync", "--copy");
    expect(read(m.at(".claude/skills/copied/SKILL.md"))).toBe(skillMd("copied", "v2"));
    expect(read(m.at(".cursor/skills/copied/SKILL.md"))).toBe(skillMd("copied", "v2"));
    expect(read(m.at(".cursor/skills/other/SKILL.md"))).toBe(skillMd("other", "edited copy"));
    expect(read(m.at(".claude/skills/other/SKILL.md"))).toBe(skillMd("other", "v2"));
    expect(report.targets.flatMap((target) => target.warnings).join("\n")).toContain(
      "is a copy with local edits",
    );

    // Dropping the skill removes the unedited copy and keeps the edited one.
    vendor.commit({ "skills/other": null });
    await m.run("sync", "--copy");
    expect(names(m.at(".claude/skills"))).toEqual(["copied"]);
    expect(names(m.at(".cursor/skills"))).toEqual(["copied", "other"]);
  });
});
