import { existsSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vite-plus/test";
import { isWindows, machine, read, remote, skills, version } from "./fixture.ts";

describe("timer", () => {
  it("15. timer install --dry-run prints the command, an absolute node and the installed copy, and reports the scheduler blocker", async () => {
    const m = machine();
    const vendor = remote(m, "vendor", skills("skills/", "timed"));
    const manifest = m.manifest({
      agents: ["claude-code"],
      sources: [{ id: "vendor", git: vendor.url }],
      timer: { cron: "*/15 * * * *", timeZone: "Europe/Madrid" },
    });
    expect((await m.run("init", manifest, "--no-timer")).code).toBe(0);
    const dry = await m.run("timer", "install", "--dry-run");
    const app = join(m.stateDir, "app", "cli.mjs");
    expect(dry.stdout).toContain(
      `timer skillfleet-sync: \`${process.execPath} ${app} sync\` on "*/15 * * * *" (Europe/Madrid)`,
    );
    // @vite-hub/schedule/os is not published yet; the run says so and exits 3.
    expect(dry.code).toBe(3);
    expect(dry.stdout).toContain("blocked: the OS timer comes from @vite-hub/schedule/os");
    expect(existsSync(app)).toBe(false);
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
});
