import { existsSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vite-plus/test";
import { isWindows, machine, read, remote, skills, version } from "./fixture.ts";

const kind =
  process.platform === "linux"
    ? "a systemd user timer"
    : process.platform === "darwin"
      ? "a launchd agent"
      : "a Task Scheduler task";

// These tests never install a real timer: CI proves that in .github/scripts/timer-e2e.mjs, which
// installs one, waits for the OS to run it, and removes it.
describe("timer", () => {
  it("15. timer install --dry-run prints the command, an absolute node and the installed copy, and installs nothing", async () => {
    const m = machine();
    const vendor = remote(m, "vendor", skills("skills/", "timed"));
    const manifest = m.manifest({
      agents: ["claude-code"],
      sources: [{ id: "vendor", git: vendor.url }],
      timer: { cron: "*/15 * * * *", timeZone: "Europe/Madrid" },
    });
    expect((await m.run("init", manifest, "--no-timer")).code).toBe(0);
    // init installs the copy even without the timer, so `skillfleet` runs from a new shell.
    rmSync(join(m.stateDir, "app"), { recursive: true });
    const dry = await m.run("timer", "install", "--dry-run");
    const app = join(m.stateDir, "app", "cli.mjs");
    expect(dry.code, dry.stderr).toBe(0);
    expect(dry.stdout).toBe(
      `timer skillfleet-sync: \`${process.execPath} ${app} sync\` on "*/15 * * * *" (Europe/Madrid)\n` +
        `would install ${kind}\n`,
    );
    expect(existsSync(app)).toBe(false);
  });

  it("15a. without timer.timeZone the timer runs in the machine's time zone, as launchd and Task Scheduler do", async () => {
    const m = machine();
    const manifest = m.manifest({ agents: ["claude-code"], sources: [] });
    expect((await m.run("init", manifest, "--no-timer")).code).toBe(0);
    const dry = await m.run("timer", "install", "--dry-run");
    expect(dry.code, dry.stderr).toBe(0);
    expect(dry.stdout).toContain(
      `on "*/30 * * * *" (${Intl.DateTimeFormat().resolvedOptions().timeZone})`,
    );
  });

  it("15c. init --dry-run neither installs a timer nor copies skillfleet", async () => {
    const m = machine();
    const manifest = m.manifest({
      agents: ["claude-code"],
      sources: [],
      timer: { cron: "* * * * *" },
    });
    const dry = await m.run("init", manifest, "--dry-run");
    expect(dry.code, dry.stderr).toBe(0);
    expect(existsSync(join(m.stateDir, "app"))).toBe(false);
    expect(existsSync(join(m.stateDir, "bin"))).toBe(false);
  });

  it("15b. the installed copy runs on its own from the state folder, with an absolute node path", async () => {
    const m = machine();
    const install = await m.run("self-install");
    expect(install.code, install.stderr).toBe(0);
    const launcher = join(m.stateDir, "bin", "skillfleet");
    const text = read(launcher);
    expect(text).toBe(
      `#!/bin/sh\nexec "${process.execPath.replace(/\\/g, "/")}" "${join(m.stateDir, "app", "cli.mjs").replace(/\\/g, "/")}" "$@"\n`,
    );
    if (isWindows) expect(read(`${launcher}.cmd`)).toContain(process.execPath);
    // The copy has no node_modules beside it, so a run proves the bundle is self-contained.
    const { spawnSync } = await import("node:child_process");
    const run = spawnSync(process.execPath, [join(m.stateDir, "app", "cli.mjs"), "--version"], {
      env: m.env,
      encoding: "utf8",
    });
    expect(run.stdout.trim()).toBe(version);
    const doctor = await m.run("doctor", "--json");
    const checks = JSON.parse(doctor.stdout) as { name: string; ok: boolean; detail: string }[];
    expect(checks.find((check) => check.name === "node")).toMatchObject({ ok: true });
  });

  it("15d. installing the same build again leaves the copy alone, since the timer may be running it", async () => {
    const m = machine();
    expect((await m.run("self-install")).code).toBe(0);
    const app = join(m.stateDir, "app", "cli.mjs");
    const before = statSync(app).mtimeMs;
    await new Promise((done) => setTimeout(done, 50));
    expect((await m.run("self-install")).code).toBe(0);
    expect(statSync(app).mtimeMs).toBe(before);
  });
});
