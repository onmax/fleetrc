import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vite-plus/test";
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
      error: "timed out after 3s",
      behind: ["never ran"],
    });

    // Once a host has answered, its last run is cached and shown with its age while it is unreachable.
    const cache = JSON.parse(JSON.stringify(hosts[0]!.lastRun)) as { finishedAt: string };
    cache.finishedAt = new Date(Date.now() - 5 * 60 * 60 * 1000).toISOString();
    writeFileSync(join(m.stateDir, "fleet.json"), JSON.stringify({ "gone.example": cache }));
    const text = await m.runWith({ env }, "fleet", "status", "--timeout", "2");
    expect(text.stdout).toMatch(/^localhost: last run \d+s ago, 1 skills$/m);
    expect(text.stdout).toContain(
      "gone.example: unreachable (timed out after 2s); last run 5h ago, 1 skills; behind: last run 5h ago",
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
});
