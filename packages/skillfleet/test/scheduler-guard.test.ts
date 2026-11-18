// Tests never reach the OS scheduler: test/guard sends every scheduler command to a fake. These
// prove it holds for the CLI, for any Node process a test starts, and inside vitest itself. The
// real timer is tested only in CI, by .github/scripts/timer-e2e.mjs.
import { execFileSync, spawnSync } from "node:child_process";
import { describe, expect, it } from "vite-plus/test";
import { machine } from "./fixture.ts";

const REFUSED = "tests never reach this machine's real scheduler";

describe("scheduler guard", () => {
  it("init --timer reaches only the fake scheduler, which refuses the timer", async () => {
    const m = machine({ scheduler: "refuse" });
    const manifest = m.manifest({ agents: ["claude-code"], sources: [] });
    const init = await m.run("init", manifest, "--timer");
    expect(init.code).toBe(1);
    expect(init.stdout).toContain("the timer was not installed");
    expect(init.stdout).toContain(REFUSED);
    expect(m.schedulerCalls().length).toBeGreaterThan(0);
    expect(m.schedulerCalls().every((call) => !call.answered)).toBe(true);
    const install = await m.run("timer", "install");
    expect(install.code).toBe(1);
    expect(install.stdout).toContain(REFUSED);
  });

  it("catches scheduler commands by absolute path and PowerShell's ScheduledTask cmdlets", () => {
    const m = machine({ scheduler: "refuse" });
    const calls = [
      ["/usr/bin/systemctl", ["--user", "enable", "--now", "x.timer"]],
      ["launchctl", ["bootstrap", "gui/501", "x.plist"]],
      ["powershell.exe", ["-NoProfile", "-Command", "Register-ScheduledTask -TaskName x"]],
    ];
    const script = `const { spawnSync } = require("node:child_process");
for (const [file, args] of ${JSON.stringify(calls)})
  console.log(spawnSync(file, args).status);`;
    const run = spawnSync(process.execPath, ["-e", script], { env: m.env, encoding: "utf8" });
    expect(run.stdout.trim().split(/\r?\n/)).toEqual(["97", "97", "97"]);
    expect(m.schedulerCalls().map((call) => call.command)).toEqual([
      "systemctl --user enable --now x.timer",
      "launchctl bootstrap gui/501 x.plist",
      "powershell -NoProfile -Command Register-ScheduledTask -TaskName x",
    ]);
  });

  it("catches a scheduler command run inside vitest", () => {
    expect(() => execFileSync("systemctl", ["--user", "daemon-reload"], { stdio: "pipe" })).toThrow(
      REFUSED,
    );
  });

  it("an empty scheduler answers reads: the timer is not installed", async () => {
    const m = machine({ scheduler: "empty" });
    const manifest = m.manifest({ agents: ["claude-code"], sources: [] });
    expect((await m.run("init", manifest, "--no-hooks")).code).toBe(0);
    const status = await m.run("timer", "status");
    expect(status.stdout).toContain("not installed");
    expect(status.code).toBe(1);
    expect(m.schedulerCalls().length).toBeGreaterThan(0);
    expect(m.schedulerCalls().every((call) => call.answered)).toBe(true);
  });
});
