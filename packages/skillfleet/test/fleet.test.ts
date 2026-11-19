import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vite-plus/test";
import { fleet, formatFleet, remoteScript, resolveFleet } from "../src/fleet.ts";
import { loadManifest } from "../src/manifest.ts";
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

let lastIp = 0;
/** A tailnet peer as `tailscale status --json` lists it. */
function peer(dns: string, tags: string[], { online = true, ips = [`100.64.1.${++lastIp}`] } = {}) {
  return {
    PublicKey: `nodekey:${dns}`,
    HostName: dns.split(".")[0],
    DNSName: dns ? `${dns}.` : "",
    TailscaleIPs: ips,
    ...(tags.length ? { Tags: tags } : {}),
    Online: online,
  };
}

function status(peers: ReturnType<typeof peer>[], self = peer("me.tail.ts.net", ["tag:servers"])) {
  return {
    BackendState: "Running",
    Self: self,
    Peer: Object.fromEntries(peers.map((p) => [p.PublicKey, p])),
  };
}

function peerAddresses(peers: ReturnType<typeof peer>[]) {
  return async (name: string) => {
    const match = peers.find(
      ({ DNSName, HostName }) => DNSName === `${name}.` || HostName === name,
    );
    return match?.TailscaleIPs ?? [];
  };
}

/**
 * A fake `tailscale` for SKILLFLEET_TAILSCALE: prints `output` (JSON for an object) and exits with
 * `code`, and touches `<dir>/tailscale-ran` so a test can tell it was asked.
 */
function fakeTailscale(dir: string, output: object | string, code = 0): string {
  mkdirSync(dir, { recursive: true });
  const script = join(dir, "tailscale.mjs");
  const text = typeof output === "string" ? output : JSON.stringify(output);
  writeFileSync(
    script,
    `import { writeFileSync } from "node:fs";
writeFileSync(${JSON.stringify(join(dir, "tailscale-ran"))}, "");
process.stdout.write(${JSON.stringify(text)});
process.exit(${code});`,
  );
  return script;
}

/** Runs `body` with `SKILLFLEET_TAILSCALE` set to `program`. */
async function withTailscale<T>(program: string, body: () => Promise<T>): Promise<T> {
  const saved = process.env.SKILLFLEET_TAILSCALE;
  process.env.SKILLFLEET_TAILSCALE = program;
  try {
    return await body();
  } finally {
    if (saved === undefined) delete process.env.SKILLFLEET_TAILSCALE;
    else process.env.SKILLFLEET_TAILSCALE = saved;
  }
}

type Hosts = { host: string; via?: string; reachable: boolean; checked: boolean; error?: string }[];

describe("fleet", () => {
  it("14. reports localhost through ssh, and an unreachable host times out with its last-run age", async () => {
    const m = machine();
    const vendor = remote(m, "vendor", skills("skills/", "fleet-skill"));
    const manifest = m.manifest({
      agents: ["claude-code"],
      sources: [{ id: "vendor", git: vendor.url }],
      fleet: ["localhost", "gone.example"],
    });
    expect((await m.run("init", manifest, "--no-hooks")).code).toBe(0);
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
    expect((await m.run("init", manifest, "--no-hooks")).code).toBe(0);
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
    expect((await m.run("init", manifest, "--no-hooks")).code).toBe(0);
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
      await m.run("init", manifest, "--no-hooks");
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

  it.skipIf(isWindows)("R7-18. fleet upgrade prints each host's version change", async () => {
    const m = machine();
    sshShim(m);
    const state = join(m.root, "state");
    const dir = join(state, "skillfleet");
    // The installed skillfleet: its version is in a file that the fake npx's self-install rewrites.
    mkdirSync(join(dir, "bin"), { recursive: true });
    writeFileSync(join(dir, "version"), "0.0.1\n");
    writeFileSync(
      join(dir, "bin", "skillfleet"),
      `#!/bin/sh
v=$(cat "${dir}/version")
case "$1" in
  --version) echo "$v" ;;
  sync) printf '{"finishedAt":"%s","ok":true,"skillfleet":"%s","skills":{"total":1}}\\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$v" ;;
esac
`,
    );
    chmodSync(join(dir, "bin", "skillfleet"), 0o755);
    const npx = join(m.root, "npx-bin");
    mkdirSync(npx);
    writeFileSync(join(npx, "npx"), `#!/bin/sh\necho 0.0.2 > "${dir}/version"\n`);
    chmodSync(join(npx, "npx"), 0o755);
    const saved = {
      XDG_STATE_HOME: process.env.XDG_STATE_HOME,
      SKILLFLEET_SSH: process.env.SKILLFLEET_SSH,
      PATH: process.env.PATH,
    };
    process.env.XDG_STATE_HOME = state;
    process.env.SKILLFLEET_SSH = join(m.root, "bin", "ssh.mjs");
    process.env.PATH = pathWith(npx, process.env);
    try {
      const results = await fleet(["localhost"], "upgrade", "0.0.2", 60_000);
      expect(formatFleet(results)).toMatch(
        /^localhost: 0\.0\.1 → 0\.0\.2; last run \d+s ago, 1 skills$/,
      );
      expect(results[0]!.upgrade).toEqual({ from: "0.0.1", to: "0.0.2" });
    } finally {
      for (const [key, value] of Object.entries(saved))
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
    }
  });
});

describe("fleet tags", () => {
  it("expands a tag to its tailnet machines by MagicDNS name, or IP without one, and skips this machine", async () => {
    const m = machine();
    const peers = [
      peer("web.tail.ts.net", ["tag:servers"]),
      peer("", ["tag:servers"], { ips: ["100.64.0.9", "fd7a::9"] }),
      peer("db.tail.ts.net", ["tag:Servers", "tag:db"], { online: false }),
      peer("laptop.tail.ts.net", []),
    ];
    const program = fakeTailscale(m.root, status(peers));
    const { targets, warnings } = await withTailscale(program, () =>
      resolveFleet(["tag:servers"], peerAddresses(peers)),
    );
    expect(warnings).toEqual([]);
    // Self (me.tail.ts.net) has the tag too, and is left out.
    expect(targets).toEqual([
      { host: "web.tail.ts.net", via: "tag:servers" },
      { host: "100.64.0.9", via: "tag:servers" },
      { host: "db.tail.ts.net", via: "tag:servers", offline: true },
    ]);
  });

  it("runs a machine named twice once: an explicit host wins, then the first tag", async () => {
    const m = machine();
    const peers = [
      peer("web.tail.ts.net", ["tag:servers", "tag:web"]),
      peer("db.tail.ts.net", ["tag:servers"], { ips: ["100.64.0.2"] }),
      peer("ci.tail.ts.net", ["tag:servers"]),
      peer("vps.tail.ts.net", ["tag:web"]),
    ];
    const program = fakeTailscale(m.root, status(peers));
    const { targets } = await withTailscale(program, () =>
      resolveFleet(
        ["tag:servers", "WEB", "me@100.64.0.2", "tag:web", "ssh://me@CI.tail.ts.net:22", "web"],
        peerAddresses(peers),
      ),
    );
    expect(targets).toEqual([
      { host: "WEB" },
      { host: "me@100.64.0.2" },
      { host: "vps.tail.ts.net", via: "tag:web" },
      { host: "ssh://me@CI.tail.ts.net:22" },
    ]);
  });

  it("compares entries by the machine they reach: IPv6 in any spelling, written ports, names Tailscale gives one peer", async () => {
    const m = machine();
    const peers = [
      peer("", ["tag:servers"], { ips: ["100.64.0.9", "fd7a:0:0::9"] }),
      peer("", ["tag:servers"], { ips: ["fd7a::10"] }),
      peer("web.tail.ts.net", ["tag:servers"], { ips: ["100.64.0.7"] }),
      peer("db.tail.ts.net", ["tag:servers"], { ips: ["100.64.0.8"] }),
    ];
    const program = fakeTailscale(m.root, status(peers));
    const { targets } = await withTailscale(program, () =>
      resolveFleet(
        [
          // A bare IPv6 address has no port: fd7a::9 is not fd7a: on port 9.
          "fd7a::9",
          "ssh://me@[FD7A:0::10]:2222",
          "tag:servers",
          "100.64.0.7",
          "web.tail.ts.net",
          "me@db",
          "ssh://me@db.tail.ts.net:22",
          "ssh://me@db:2222",
          "root@db",
        ],
        peerAddresses(peers),
      ),
    );
    expect(targets).toEqual([
      { host: "fd7a::9" },
      { host: "ssh://me@[FD7A:0::10]:2222" },
      { host: "100.64.0.7" },
      { host: "me@db" },
      // A written port stays: ~/.ssh/config may give the bare name another one.
      { host: "ssh://me@db.tail.ts.net:22" },
      { host: "ssh://me@db:2222" },
      { host: "root@db" },
    ]);
    // Without a tag, Tailscale isn't asked, so a short name and a MagicDNS name stay apart: two
    // tailnets can each have a vps2.
    const plain = await resolveFleet(["vps2", "vps2.tail.ts.net", "vps2.other.ts.net", "VPS2"]);
    expect(plain.targets).toEqual([
      { host: "vps2" },
      { host: "vps2.tail.ts.net" },
      { host: "vps2.other.ts.net" },
    ]);
  });

  it("runs on a machine's Tailscale IP when the tailnet has MagicDNS off", async () => {
    const m = machine();
    const program = fakeTailscale(m.root, {
      ...status([peer("web.tail.ts.net", ["tag:servers"], { ips: ["100.64.0.5", "fd7a::5"] })]),
      CurrentTailnet: {
        Name: "example.com",
        MagicDNSSuffix: "tail.ts.net",
        MagicDNSEnabled: false,
      },
    });
    const { targets } = await withTailscale(program, () =>
      resolveFleet(["web", "web.tail.ts.net", "tag:servers"]),
    );
    expect(targets).toEqual([
      { host: "web" },
      { host: "web.tail.ts.net" },
      { host: "100.64.0.5", via: "tag:servers" },
    ]);
    const explicitIP = await withTailscale(program, () =>
      resolveFleet(["tag:servers", "me@fd7a:0::5"]),
    );
    expect(explicitIP.targets).toEqual([{ host: "me@fd7a:0::5" }]);
  });

  it("uses the peer IP when MagicDNS names cannot resolve locally", async () => {
    const m = machine();
    const program = fakeTailscale(m.root, {
      ...status([peer("web.invalid", ["tag:servers"], { ips: ["100.64.0.5"] })]),
      CurrentTailnet: { MagicDNSEnabled: true },
    });
    const { targets } = await withTailscale(program, () => resolveFleet(["web", "tag:servers"]));
    expect(targets).toEqual([{ host: "web" }, { host: "100.64.0.5", via: "tag:servers" }]);
  });

  it("never hands ssh a name from tailscale status that ssh would read as an option, a user or shell", async () => {
    const m = machine();
    const manifest = m.manifest({ agents: ["claude-code"], sources: [] });
    expect((await m.run("init", manifest, "--no-hooks")).code).toBe(0);
    const program = fakeTailscale(
      m.root,
      status([
        peer("-oProxyCommand=x", ["tag:servers"], { ips: [] }),
        peer("a;b.tail.ts.net", ["tag:servers"], { ips: [] }),
        peer("user@x", ["tag:servers"], { ips: [] }),
        peer("$(id).tail.ts.net", ["tag:servers"], { ips: [] }),
        { ...peer("", ["tag:servers"], { ips: ["-oProxyCommand=y"] }), HostName: "$(id)" },
        { ...peer("", ["tag:servers"], { ips: ["a;b"] }), HostName: "-oProxyCommand=z" },
        peer("localhost", ["tag:servers"], { ips: ["127.0.0.1", "::1"] }),
      ]),
    );
    const log = join(m.root, "ssh-argv.jsonl");
    const ssh = join(m.root, "record-ssh.mjs");
    writeFileSync(
      ssh,
      `import { appendFileSync } from "node:fs";
appendFileSync(${JSON.stringify(log)}, JSON.stringify(process.argv.slice(2)) + "\\n");
process.exit(255);`,
    );
    const env = { SKILLFLEET_SSH: ssh, SKILLFLEET_TAILSCALE: program };
    const run = await m.runWith({ env }, "fleet", "status", "tag:servers", "--json");
    expect(run.code).toBe(1);
    const calls = readFileSync(log, "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as string[]);
    expect(calls.map((argv) => argv[argv.indexOf("--") + 1])).toEqual(["localhost"]);
    for (const hostile of ["ProxyCommand", "a;b", "user@x", "$(id)"])
      expect(calls.flat().slice(0, -1).join(" ")).not.toContain(hostile);
    expect((JSON.parse(run.stdout) as Hosts).map((host) => host.host)).toEqual(["localhost"]);
    expect(run.stderr).toMatch(/skipped a machine Tailscale calls "-oProxyCommand=x"/);
  });

  it("warns about a tag that matches no machine, and asks Tailscale nothing without a tag", async () => {
    const m = machine();
    const program = fakeTailscale(m.root, status([peer("web.tail.ts.net", ["tag:web"])]));
    const tagged = await withTailscale(program, () => resolveFleet(["tag:servers", "laptop"]));
    expect(tagged).toEqual({
      targets: [{ host: "laptop" }],
      warnings: ["tag:servers matches no machine on your tailnet besides this one"],
    });
    rmSync(join(m.root, "tailscale-ran"));
    await withTailscale(program, () => resolveFleet(["laptop"]));
    expect(existsSync(join(m.root, "tailscale-ran"))).toBe(false);
  });

  it("says why a tag can't be expanded when tailscale is missing, logged out, failing or printing junk", async () => {
    const m = machine();
    const cases: [string, string][] = [
      [
        join(m.root, "nowhere", "tailscale"),
        "which SKILLFLEET_TAILSCALE names, is not installed or not on PATH",
      ],
      [
        fakeTailscale(join(m.root, "out"), { BackendState: "NeedsLogin" }),
        "Tailscale is not logged in; run `tailscale up`",
      ],
      [
        fakeTailscale(join(m.root, "junk"), "<html>"),
        "`tailscale status --json` printed something that is not JSON",
      ],
      [fakeTailscale(join(m.root, "down"), "", 1), "`tailscale status` failed: exit 1"],
    ];
    for (const [program, error] of cases) {
      const { targets } = await withTailscale(program, () =>
        resolveFleet(["laptop", "tag:servers"]),
      );
      expect(targets[0]).toEqual({ host: "laptop" });
      expect(targets[1]).toMatchObject({ host: "tag:servers", via: "tag:servers" });
      expect(targets[1]!.error).toContain(error);
    }
  });

  it("a fleet with tailscale missing still runs its explicit hosts, and the tag line says why, exit 1", async () => {
    const m = machine();
    const manifest = m.manifest({
      agents: ["claude-code"],
      sources: [],
      fleet: ["tag:servers", "localhost"],
    });
    expect((await m.run("init", manifest, "--no-hooks")).code).toBe(0);
    expect((await m.run("self-install")).code).toBe(0);
    const env = { ...sshShim(m), SKILLFLEET_TAILSCALE: join(m.root, "nowhere", "tailscale") };
    const text = await m.runWith({ env }, "fleet", "status", "--timeout", "20");
    expect(text.code).toBe(1);
    expect(text.stderr).not.toMatch(/\n\s+at /);
    const lines = text.stdout.replace(/\r/g, "").trimEnd().split("\n");
    expect(lines).toHaveLength(2);
    expect(lines[0]).toMatch(
      /^tag:servers: not expanded \(.*tailscale, which SKILLFLEET_TAILSCALE names, is not installed or not on PATH\)$/,
    );
    expect(lines[1]).toMatch(/^localhost: last run \d+s ago, 0 skills$/);
  });

  it("fleet sync|status take a tag on the command line, mark offline machines, and --json says which tag a host came from", async () => {
    const m = machine();
    const manifest = m.manifest({ agents: ["claude-code"], sources: [], fleet: ["laptop"] });
    expect((await m.run("init", manifest, "--no-hooks")).code).toBe(0);
    expect((await m.run("self-install")).code).toBe(0);
    const program = fakeTailscale(
      m.root,
      status([
        peer("localhost", ["tag:servers"], { ips: ["127.0.0.1", "::1"] }),
        peer("gone.tail.ts.net", ["tag:servers"], { online: false }),
      ]),
    );
    const env = { ...sshShim(m), SKILLFLEET_TAILSCALE: program };
    const started = Date.now();
    const run = await m.runWith({ env }, "fleet", "status", "tag:servers", "--json");
    // The offline machine is not waited on for ssh's 30 s.
    expect(Date.now() - started).toBeLessThan(25_000);
    expect(run.code, run.stderr).toBe(1);
    const hosts = JSON.parse(run.stdout) as Hosts;
    expect(hosts).toEqual([
      expect.objectContaining({ host: "localhost", via: "tag:servers", reachable: true }),
      expect.objectContaining({
        host: "gone.tail.ts.net",
        via: "tag:servers",
        reachable: false,
        error: "offline in Tailscale",
      }),
    ]);
    const text = await m.runWith({ env }, "fleet", "status", "tag:servers");
    expect(text.stdout).toMatch(/^localhost \(tag:servers\): last run /m);
    expect(text.stdout).toContain(
      "gone.tail.ts.net (tag:servers): unreachable (offline in Tailscale); no run recorded\n",
    );

    const dry = await m.runWith({ env }, "fleet", "sync", "tag:servers", "--dry-run");
    expect(dry.stdout).toMatch(
      /^tag:servers expands to localhost, gone\.tail\.ts\.net \(offline\)$/m,
    );

    const none = await m.runWith({ env }, "fleet", "status", "tag:nothing");
    expect(none.code).toBe(0);
    expect(none.stderr).toContain(
      "skillfleet: warning: tag:nothing matches no machine on your tailnet besides this one",
    );

    const bad = await m.runWith({ env }, "fleet", "sync", "tag:bad_tag");
    expect(bad.code).toBe(2);
    expect(bad.stderr).toContain('"tag:bad_tag" is not a Tailscale tag');
  });

  it("fleet add records a tag, and without hosts suggests the tags it saw", async () => {
    const m = machine();
    const manifest = m.manifest({ agents: ["claude-code"], sources: [] });
    expect((await m.run("init", manifest, "--no-hooks")).code).toBe(0);
    const program = fakeTailscale(
      m.root,
      status([
        peer("web.tail.ts.net", ["tag:servers"]),
        peer("db.tail.ts.net", ["tag:servers", "tag:db"]),
        peer("laptop.tail.ts.net", []),
        peer("", ["tag:servers", "tag:ip-only"], { ips: ["100.64.0.9"] }),
      ]),
    );
    const env = { SKILLFLEET_TAILSCALE: program };
    const listed = await m.runWith({ env }, "fleet", "add");
    expect(listed.code, listed.stderr).toBe(0);
    expect(listed.stdout).toContain(
      "  tag:db  (1 machine)\n  tag:ip-only  (1 machine)\n  tag:servers  (3 machines)",
    );
    expect(listed.stdout).toContain("  laptop  laptop.tail.ts.net");

    expect((await m.runWith({ env }, "fleet", "add", "tag:servers")).code).toBe(0);
    expect((JSON.parse(readFileSync(manifest, "utf8")) as { fleet: string[] }).fleet).toEqual([
      "tag:servers",
    ]);
    const after = JSON.parse((await m.runWith({ env }, "fleet", "add", "--json")).stdout) as {
      tags: { tag: string }[];
    };
    expect(after.tags.map(({ tag }) => tag)).toEqual(["tag:db", "tag:ip-only"]);

    const bad = await m.runWith({ env }, "fleet", "add", "tag:9lives");
    expect(bad.code).toBe(1);
    expect(bad.stderr).toContain('"tag:9lives" is not a Tailscale tag');
  });

  it("an extended team manifest's tag is ignored, and Tailscale is never asked", async () => {
    const m = machine();
    const team = join(m.root, "team", ".skillfleet", "manifest.json");
    mkdirSync(join(team, ".."), { recursive: true });
    writeFileSync(
      team,
      JSON.stringify({
        sources: [{ id: "team", git: "https://example.org/team.git" }],
        fleet: ["tag:servers", "tag:bad_tag"],
      }),
    );
    // A host fleet refuses at once, so the run needs no ssh.
    const manifest = m.manifest({
      agents: ["claude-code"],
      extends: [team],
      sources: [],
      fleet: ["-x"],
    });
    const loaded = await loadManifest(manifest, { offline: true });
    expect(loaded.sources.map(({ id }) => id)).toEqual(["team"]);
    expect(loaded.warnings).toEqual([expect.stringContaining("ignored fleet; only the root")]);
    const program = fakeTailscale(m.root, status([peer("web.tail.ts.net", ["tag:servers"])]));
    const run = await m.runWith(
      { env: { SKILLFLEET_TAILSCALE: program } },
      "fleet",
      "status",
      "--json",
      "--manifest",
      manifest,
    );
    expect((JSON.parse(run.stdout) as Hosts).map(({ host }) => host)).toEqual(["-x"]);
    expect(existsSync(join(m.root, "tailscale-ran"))).toBe(false);
  });
});

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
