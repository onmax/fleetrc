// Breaks found by running real agents (Claude Code, Codex, Gemini CLI, OpenCode, Copilot CLI, Grok,
// Goose, Amp) against the folders skillfleet links. Each case states what a user should get; they
// fail until the matching fix lands.
import { existsSync, mkdirSync, readdirSync, rmSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vite-plus/test";
import { isLink, isWindows, linkOf, machine, remote, skillMd, skills, writeFiles } from "./fixture.ts";

const names = (dir: string) =>
  existsSync(dir) ? readdirSync(dir).filter((n) => !n.startsWith(".")) : [];

describe("agents", () => {
  // Gemini CLI 0.68 reads both ~/.gemini/skills and ~/.agents/skills. When a name is in both, it
  // shows "Skill conflict detected: ... is overriding the same skill" once per skill on every start.
  // `npx skills add -g` installs Gemini's skills only into ~/.agents/skills for this reason.
  it("A1. Gemini CLI sees each skill once when Codex is also linked", async () => {
    const m = machine();
    const vendor = remote(m, "vendor", skills("skills/", "alpha", "beta"));
    const manifest = m.manifest({
      agents: ["codex", "gemini-cli"],
      sources: [{ id: "vendor", git: vendor.url }],
    });
    const init = await m.run("init", manifest, "--no-timer");
    expect(init.code, init.stderr).toBe(0);
    const canonical = names(m.at(".agents/skills"));
    expect(canonical).toEqual(["alpha", "beta"]);
    const both = names(m.at(".gemini/skills")).filter((name) => canonical.includes(name));
    expect(both).toEqual([]);
  });

  // Before 0.0.1, skillfleet linked every skill into Gemini's own folder as well.
  it("A1b. sync removes the links it made in Gemini's own folder once ~/.agents/skills holds them", async () => {
    const m = machine();
    const vendor = remote(m, "vendor", skills("skills/", "alpha", "beta"));
    const sources = [{ id: "vendor", git: vendor.url }];
    const manifest = m.manifest({ agents: ["gemini-cli"], sources });
    expect((await m.run("init", manifest, "--no-timer")).code).toBe(0);
    expect(names(m.at(".gemini/skills"))).toEqual(["alpha", "beta"]);
    writeFiles(m.at(".gemini/skills"), { "mine/SKILL.md": skillMd("mine") });

    m.manifest({ agents: ["codex", "gemini-cli"], sources });
    const report = await m.json("sync");
    expect(report.ok, report.errors.join("\n")).toBe(true);
    expect(names(m.at(".agents/skills"))).toEqual(["alpha", "beta"]);
    // Gemini's own skill stays; the links and skillfleet's record of them go.
    expect(readdirSync(m.at(".gemini/skills"))).toEqual(["mine"]);
    expect(report.targets.find((t) => t.dir === m.at(".gemini/skills"))?.removed).toEqual([
      "alpha",
      "beta",
    ]);
    expect((await m.run("sync")).stdout).toMatch(/^skillfleet: linked 2 skills into 1 folder$/m);
  });

  // A folder that is another path to ~/.agents/skills is not a former target to empty.
  it("A1c. sync leaves ~/.agents/skills alone when an agent's own folder leads to it", async () => {
    const m = machine();
    const vendor = remote(m, "vendor", skills("skills/", "alpha"));
    rmSync(m.at(".config/opencode"), { recursive: true });
    mkdirSync(m.at(".agents/skills"), { recursive: true });
    symlinkSync(m.at(".agents"), m.at(".config/opencode"), isWindows ? "junction" : "dir");
    const manifest = m.manifest({
      agents: ["codex", "opencode"],
      sources: [{ id: "vendor", git: vendor.url }],
    });
    expect((await m.run("init", manifest, "--no-timer")).code).toBe(0);
    expect((await m.run("sync")).code).toBe(0);
    expect(isLink(m.at(".agents/skills/alpha"))).toBe(true);
    expect(linkOf(m.at(".agents/skills/alpha"))).toBe(
      join(m.stateDir, "store", "vendor", "live", "alpha"),
    );
  });

  // `skills` reads these to find an agent's folder. The timer runs without the shell's profile, so
  // without them it links ~/.grok/skills while Grok reads $GROK_HOME/skills.
  it.each([
    "CLAUDE_CONFIG_DIR",
    "CODEX_HOME",
    "GROK_HOME",
    "VIBE_HOME",
    "HERMES_HOME",
    "AUTOHAND_HOME",
    "SARVAM_HOME",
    "REASONIX_HOME",
  ])("A2. the timer keeps %s, which places an agent's skills folder", async (key) => {
    const { timerEnv } = await import("../src/timer.ts");
    const saved = process.env[key];
    process.env[key] = "/somewhere/else";
    try {
      expect(timerEnv(undefined)[key]).toBe("/somewhere/else");
    } finally {
      if (saved === undefined) delete process.env[key];
      else process.env[key] = saved;
    }
  });
});
