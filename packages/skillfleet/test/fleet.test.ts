import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vite-plus/test";
import { remoteScript } from "../src/fleet.ts";
import { launchers } from "../src/selfinstall.ts";
import { isWindows, machine, type Machine, pathWith, remote, skills } from "./fixture.ts";

/**
 * A fake `ssh`: skips options and the `--` after them, takes the host, and runs the remote command with `sh -c` on this
 * machine for `localhost`. Any other host hangs, like a machine that dropped off the network.
 */
function sshShim(m: Machine): NodeJS.ProcessEnv {
  const dir = join(m.root, "bin");
  mkdirSync(dir, { recursive: true });
  const script = join(dir, "ssh.mjs");
  writeFileSync(
    script,
    `import { spawnSync } from "node:child_process";
const args = process.argv.slice(2);
while (args[0] === "-o") args.splice(0, 2);
if (args[0] === "--") args.shift();
const [host, command] = args;
if (host !== "localhost") setTimeout(() => {}, 1e9);
else {
  const run = spawnSync("sh", ["-c", command], { stdio: "inherit" });
  process.exit(run.status ?? 1);
}`,
  );
  if (isWindows) return { SKILLFLEET_SSH: script };
  const ssh = join(dir, "ssh");
  writeFileSync(ssh, `#!/bin/sh\nexec "${process.execPath}" "${script}" "$@"\n`);
  chmodSync(ssh, 0o755);
  return { PATH: pathWith(dir, m.env) };
}

describe("fleet", () => {
  it("14. reports localhost through ssh, and an unreachable host times out with its last-run age", async () => {
    const m = machine();
    const vendor = remote(m, "vendor", skills("skills/", "fleet-skill"));
    const manifest = m.manifest({
      agents: ["claude-code"],
      sources: [{ id: "vendor", git: vendor.url }],
      fleet: ["localhost", "gone.example"],
    });
    expect((await m.run("init", manifest, "--no-timer")).code).toBe(0);
    // What `timer install` does: the copy of skillfleet that hosts run.
    expect((await m.run("self-install")).code).toBe(0);
    const env = sshShim(m);

    const first = await m.runWith({ env }, "fleet", "status", "--timeout", "3", "--json");
    expect(first.code).toBe(1);
    const hosts = JSON.parse(first.stdout) as {
      host: string;
      reachable: boolean;
      lastRun?: { skills: number; finishedAt: string };
      error?: string;
      behind: string[];
    }[];
    expect(hosts[0]).toMatchObject({ host: "localhost", reachable: true, lastRun: { skills: 1 } });
    expect(hosts[1]).toMatchObject({
      host: "gone.example",
      reachable: false,
      error: "no answer within 3 s",
      behind: [],
    });

    // Once a host has answered, its last run is cached and shown with its age while it is unreachable.
    const cache = JSON.parse(JSON.stringify(hosts[0]!.lastRun)) as { finishedAt: string };
    cache.finishedAt = new Date(Date.now() - 5 * 60 * 60 * 1000).toISOString();
    writeFileSync(join(m.stateDir, "fleet.json"), JSON.stringify({ "gone.example": cache }));
    const text = await m.runWith({ env }, "fleet", "status", "--timeout", "2");
    expect(text.stdout).toMatch(/^localhost: last run \d+s ago, 1 skills$/m);
    expect(text.stdout).toContain(
      "gone.example: unreachable (no answer within 2 s); last run 5h ago, 1 skills; behind: last run 5h ago",
    );

    // fleet sync runs the sync on the host and reads back its report.
    vendor.commit({ "skills/second/SKILL.md": "---\nname: second\ndescription: Second\n---\n" });
    const synced = await m.runWith({ env }, "fleet", "sync", "localhost", "--json");
    expect(synced.code, synced.stdout + synced.stderr).toBe(0);
    expect(
      (JSON.parse(synced.stdout) as { lastRun: { skills: number } }[])[0]!.lastRun.skills,
    ).toBe(2);
  });

  it("fleet add records only the hosts named", async () => {
    const m = machine();
    const manifest = m.manifest({ agents: ["claude-code"], sources: [] });
    expect((await m.run("init", manifest, "--no-timer")).code).toBe(0);
    const added = await m.run("fleet", "add", "slimbook", "maxi@100.105.98.81");
    expect(added.code).toBe(0);
    expect((JSON.parse(readFileSync(manifest, "utf8")) as { fleet: string[] }).fleet).toEqual([
      "slimbook",
      "maxi@100.105.98.81",
    ]);
  });

  it("fleet add takes the host forms ssh reads, including ssh:// with a port", async () => {
    const m = machine();
    const manifest = m.manifest({ agents: ["claude-code"], sources: [] });
    expect((await m.run("init", manifest, "--no-timer")).code).toBe(0);
    const hosts = ["box.tail1234.ts.net", "my_alias", "ssh://me@box:2222", "fe80::1%eth0"];
    const added = await m.run("fleet", "add", ...hosts);
    expect(added.code, added.stderr).toBe(0);
    expect((JSON.parse(readFileSync(manifest, "utf8")) as { fleet: string[] }).fleet).toEqual(
      hosts,
    );
  });

  it.skipIf(isWindows)(
    "R3-6. fleet upgrade on a host whose launcher's node is gone says so, not that skillfleet is missing",
    () => {
      const m = machine();
      const state = join(m.root, "state");
      const launcher = join(state, "skillfleet", "bin", "skillfleet");
      mkdirSync(join(launcher, ".."), { recursive: true });
      // Node.js was upgraded: the launcher still names the old node, and ssh's PATH has no node or npx.
      writeFileSync(
        launcher,
        launchers(
          join(m.root, "node-v22.1.0", "bin", "node"),
          join(state, "skillfleet", "app", "cli.mjs"),
        ).sh,
      );
      chmodSync(launcher, 0o755);
      const bin = join(m.root, "ssh-bin");
      mkdirSync(bin);
      const sed = spawnSync("sh", ["-c", "command -v sed"], { encoding: "utf8" }).stdout.trim();
      symlinkSync(sed, join(bin, "sed"));
      const run = spawnSync("/bin/sh", ["-c", remoteScript("upgrade", "1.2.3")], {
        env: { HOME: m.home, XDG_STATE_HOME: state, PATH: bin },
        encoding: "utf8",
      });
      expect(run.stdout.trim(), run.stderr).toBe("skillfleet-fleet: node-gone");
    },
  );

  it.skipIf(isWindows)(
    "R2-2. fleet sync reads a host whose sync failed for one source as synced with errors, and exits 1",
    async () => {
      const m = machine();
      const vendor = remote(m, "vendor", skills("skills/", "tool"));
      const manifest = m.manifest({
        agents: ["claude-code"],
        sources: [
          { id: "vendor", git: vendor.url },
          { id: "gone", local: join(m.root, "gone") },
        ],
        fleet: ["localhost"],
      });
      await m.run("init", manifest, "--no-timer");
      expect((await m.run("self-install")).code).toBe(0);
      const env = sshShim(m);
      const sync = await m.runWith({ env }, "fleet", "sync");
      expect(sync.stdout).toMatch(/^localhost: last run \d+s ago, 1 skills, with errors$/m);
      expect(sync.code).toBe(1);
      // status shows the last run as it was; it did not fail now.
      const status = await m.runWith({ env }, "fleet", "status");
      expect(status.stdout).toMatch(/^localhost: last run .*, with errors$/m);
      expect(status.code).toBe(0);
    },
  );

  it("R7-16. fleet without ssh says ssh is not installed, and calls no host unreachable or never run", async () => {
    const m = machine();
    const manifest = m.manifest({
      agents: ["claude-code"],
      sources: [],
      fleet: ["laptop", "homelab"],
    });
    const empty = join(m.root, "no-ssh");
    mkdirSync(empty);
    const status = await m.runWith(
      { env: { PATH: empty, Path: isWindows ? empty : undefined } },
      "fleet",
      "status",
      "--manifest",
      manifest,
    );
    expect(status.code).toBe(1);
    expect(status.stdout.replace(/\r/g, "")).toBe(
      "laptop: not checked (ssh is not installed, or not on PATH); no run recorded\n" +
        "homelab: not checked (ssh is not installed, or not on PATH); no run recorded\n",
    );
  });

  it.skipIf(isWindows)(
    "R7-16. a host that answers but is slow times out as slow, not unreachable, and its sync is stopped",
    async () => {
      const m = machine();
      const manifest = m.manifest({
        agents: ["claude-code"],
        sources: [],
        fleet: ["localhost", "gone.example"],
      });
      // The host's sync starts and never ends.
      const pidFile = join(m.root, "sync.pid");
      const launcher = join(m.stateDir, "bin", "skillfleet");
      mkdirSync(join(launcher, ".."), { recursive: true });
      writeFileSync(launcher, `#!/bin/sh\necho $$ > "${pidFile}"\nexec sleep 300\n`);
      chmodSync(launcher, 0o755);
      const env = sshShim(m);
      let pid: number | undefined;
      try {
        // Long enough for the host to answer on a loaded machine; the sync never finishes.
        const sync = await m.runWith(
          { env },
          "fleet",
          "sync",
          "--manifest",
          manifest,
          "--timeout",
          "10",
        );
        expect(sync.code).toBe(1);
        expect(sync.stdout).toContain(
          "localhost: timed out after 10 s (the host answered, but its run did not finish, so it was stopped); no run recorded\n",
        );
        expect(sync.stdout).toContain(
          "gone.example: unreachable (no answer within 10 s); no run recorded\n",
        );
        pid = Number(readFileSync(pidFile, "utf8"));
        // The fake ssh is gone and its stdin closed, as when ssh's connection drops: the sync is stopped.
        const deadline = Date.now() + 30_000;
        while (alive(pid) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 200));
        expect(alive(pid)).toBe(false);
      } finally {
        if (pid !== undefined && alive(pid)) process.kill(pid, "SIGKILL");
      }
    },
  );
});

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
