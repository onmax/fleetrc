import { execFileSync, spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vite-plus/test";
import { cloneKey } from "../src/gitcache.ts";
import { cli, isWindows, machine, names, pathWith, remote, skills } from "./fixture.ts";

/**
 * A git first on PATH that logs when each fetch starts and ends, and makes it take `ms` longer, so
 * a test can see which fetches overlap. Everything else goes straight to git.
 */
function slowFetches(
  root: string,
  env: NodeJS.ProcessEnv,
  ms: number,
  { before = `sleep ${ms / 1000}`, after = "", maintenance = "" } = {},
) {
  const bin = join(root, "slow-git");
  const log = join(root, "fetches.log");
  mkdirSync(bin, { recursive: true });
  // git's own binary, past any wrapper on PATH that would find this one and call it back.
  const real = join(execFileSync("git", ["--exec-path"], { env, encoding: "utf8" }).trim(), "git");
  writeFileSync(
    join(bin, "git"),
    `#!/bin/sh
for arg in "$@"; do
  if [ "$arg" = maintenance ]; then
    ${maintenance || ":"}
    break
  fi
  if [ "$arg" = fetch ]; then
    echo start >> "${log}"
    ${before}
    "${real}" "$@"; code=$?
    ${after}
    echo end >> "${log}"
    exit $code
  fi
done
exec "${real}" "$@"
`,
  );
  chmodSync(join(bin, "git"), 0o755);
  return {
    PATH: pathWith(bin, env),
    GIT_EXEC_PATH: bin,
    /** "start" and "end" for each fetch, in the order they happened. */
    fetches: () => readFileSync(log, "utf8").trim().split("\n"),
  };
}

/** The most fetches running at one time. */
function mostAtOnce(events: string[]) {
  let running = 0;
  let most = 0;
  for (const event of events) {
    running += event === "start" ? 1 : -1;
    most = Math.max(most, running);
  }
  return most;
}

describe.skipIf(isWindows)("fetching git sources", () => {
  it("fetches git sources a few at a time instead of one after another", async () => {
    const m = machine();
    const ids = ["one", "two", "three", "four", "five", "six"];
    const sources = ids.map((id) => ({
      id,
      git: remote(m, id, skills("skills/", `${id}-skill`)).url,
    }));
    const manifest = m.manifest({ agents: ["claude-code"], sources });
    expect((await m.run("init", manifest, "--no-hooks")).code).toBe(0);
    const slow = slowFetches(m.root, m.env, 1000);
    const sync = await m.runWith({ env: { PATH: slow.PATH } }, "sync");
    expect(sync.code, sync.stdout + sync.stderr).toBe(0);
    const fetches = slow.fetches();
    expect(fetches.filter((event) => event === "start")).toHaveLength(ids.length);
    expect(mostAtOnce(fetches)).toBeGreaterThan(1);
    expect(mostAtOnce(fetches)).toBeLessThanOrEqual(4);
    expect(names(m.at(".claude/skills"))).toEqual(ids.map((id) => `${id}-skill`).sort());
  });

  it("fetches a repository that two sources read at the same ref once", async () => {
    const m = machine();
    const vendor = remote(m, "vendor", skills("skills/", "tool", "other"));
    const manifest = m.manifest({
      agents: ["claude-code"],
      sources: [
        { id: "tools", git: vendor.url, include: ["tool"] },
        { id: "others", git: vendor.url, include: ["other"] },
      ],
    });
    expect((await m.run("init", manifest, "--no-hooks")).code).toBe(0);
    const slow = slowFetches(m.root, m.env, 0);
    const sync = await m.runWith({ env: { PATH: slow.PATH } }, "sync");
    expect(sync.code, sync.stdout + sync.stderr).toBe(0);
    expect(slow.fetches().filter((event) => event === "start")).toHaveLength(1);
    expect(names(m.at(".claude/skills"))).toEqual(["other", "tool"]);
  });

  it("reads a shared cold cache in order when a team source needs a checked fetch", async () => {
    const m = machine();
    const vendor = remote(m, "vendor", skills("skills/", "tool", "other"));
    const team = join(m.root, "team.json");
    writeFileSync(
      team,
      JSON.stringify({ sources: [{ id: "team", git: vendor.https, include: ["other"] }] }),
    );
    const manifest = m.manifest({
      agents: ["claude-code"],
      extends: [team],
      sources: [{ id: "tools", git: vendor.https, include: ["tool"] }],
    });
    const slow = slowFetches(m.root, m.env, 700, {
      before: `case "$*" in *http.followRedirects=false*) echo checked >> "${join(m.root, "policy")}";; esac
        sleep 0.7`,
    });
    const sync = await m.runWith({ env: { PATH: slow.PATH } }, "sync", "--manifest", manifest);
    expect(slow.fetches()).toEqual(["start", "end", "start", "end"]);
    expect(readFileSync(join(m.root, "policy"), "utf8")).toBe("checked\n");
    expect(sync.code, sync.stdout + sync.stderr).toBe(0);
    expect(names(m.at(".claude/skills"))).toEqual(["other", "tool"]);
  });

  it.skipIf(process.platform !== "linux")(
    "retries with a controlling terminal even when all streams are redirected",
    async () => {
      const m = machine();
      const vendor = remote(m, "vendor", skills("skills/", "tool"));
      const manifest = m.manifest({
        agents: ["claude-code"],
        sources: [{ id: "vendor", git: vendor.url }],
      });
      const slow = slowFetches(m.root, m.env, 0, { before: `(: </dev/tty) || exit 1` });
      const command = `exec "$1" "$2" sync --manifest "$3" </dev/null >stdout 2>stderr`;
      const wrapper = join(m.root, "redirect.sh");
      writeFileSync(wrapper, command);
      const env = { ...m.env, PATH: slow.PATH };
      const args = [wrapper, process.execPath, cli, manifest];
      const unattended = spawnSync("setsid", ["--wait", "sh", ...args], {
        cwd: m.root,
        env,
        timeout: 10_000,
      });
      expect(unattended.status).toBe(1);
      expect(slow.fetches()).toEqual(["start"]);
      const interactive = spawnSync(
        "script",
        [
          "-q",
          "-e",
          "-c",
          `sh ${args.map((arg) => `'${arg.replaceAll("'", "'\\''")}'`).join(" ")}`,
          "/dev/null",
        ],
        { cwd: m.root, env, timeout: 10_000 },
      );
      expect(interactive.status, readFileSync(join(m.root, "stderr"), "utf8")).toBe(0);
      expect(slow.fetches()).toEqual(["start", "start", "start", "end"]);
      expect(names(m.at(".claude/skills"))).toEqual(["tool"]);
    },
  );

  it.each([true, false])("honors maintenance.auto=%s after successful prefetches", async (auto) => {
    const m = machine();
    const vendor = remote(m, "vendor", skills("skills/", "tool"));
    const manifest = m.manifest({
      agents: ["claude-code"],
      sources: [{ id: "vendor", git: vendor.url }],
    });
    const config = {
      GIT_CONFIG_COUNT: "3",
      GIT_CONFIG_KEY_0: "fetch.unpackLimit",
      GIT_CONFIG_VALUE_0: "1",
      GIT_CONFIG_KEY_1: "gc.autoPackLimit",
      GIT_CONFIG_VALUE_1: "2",
      GIT_CONFIG_KEY_2: "maintenance.auto",
      GIT_CONFIG_VALUE_2: String(auto),
    };
    const repo = join(m.stateDir, "cache", "git", `${cloneKey(vendor.url)}.git`);
    for (let version = 0; version < 7; version++) {
      vendor.commit({ "version.txt": String(version) });
      const sync = await m.runWith({ env: config }, "sync", "--manifest", manifest);
      expect(sync.code, sync.stdout + sync.stderr).toBe(0);
    }
    const packs = readdirSync(join(repo, "objects", "pack")).filter((name) =>
      name.endsWith(".pack"),
    );
    expect(packs.length).toBeGreaterThan(0);
    if (auto) expect(packs.length).toBeLessThan(7);
    else expect(packs).toHaveLength(7);
  });

  it("keeps the new and previous commits reachable during warm-cache pruning", async () => {
    const m = machine();
    const vendor = remote(m, "vendor", skills("skills/", "tool"));
    const manifest = m.manifest({
      agents: ["claude-code"],
      sources: [{ id: "vendor", git: vendor.url }],
    });
    const env = {
      GIT_CONFIG_COUNT: "5",
      GIT_CONFIG_KEY_0: "fetch.unpackLimit",
      GIT_CONFIG_VALUE_0: "1",
      GIT_CONFIG_KEY_1: "gc.autoPackLimit",
      GIT_CONFIG_VALUE_1: "1",
      GIT_CONFIG_KEY_2: "maintenance.strategy",
      GIT_CONFIG_VALUE_2: "gc",
      GIT_CONFIG_KEY_3: "gc.pruneExpire",
      GIT_CONFIG_VALUE_3: "now",
      GIT_CONFIG_KEY_4: "maintenance.auto",
      GIT_CONFIG_VALUE_4: "true",
    };
    const seeded = await m.runWith({ env }, "sync", "--manifest", manifest);
    expect(seeded.code, seeded.stdout + seeded.stderr).toBe(0);
    const previous = vendor.head();
    const next = vendor.commit(skills("skills/", "next"));
    const updated = await m.runWith({ env }, "sync", "--manifest", manifest);
    expect(updated.code, updated.stdout + updated.stderr).toBe(0);
    const repo = join(m.stateDir, "cache", "git", `${cloneKey(vendor.url)}.git`);
    expect(m.git(repo, "rev-parse", "refs/fleetrc/fetched")).toBe(next);
    expect(m.git(repo, "cat-file", "-t", previous)).toBe("commit");
    expect(names(m.at(".claude/skills"))).toEqual(["next", "tool"]);
  });

  it("recovers a warm cache after cancelling maintenance", async () => {
    const m = machine();
    const first = remote(m, "first", skills("skills/", "first-tool"));
    const warm = remote(m, "warm", skills("skills/", "warm-tool"));
    const sources = [
      { id: "first", git: first.url },
      { id: "warm", git: warm.url },
    ];
    const seed = m.manifest({ agents: ["claude-code"], sources: sources.slice(1) });
    const seeded = await m.run("sync", "--manifest", seed);
    expect(seeded.code, seeded.stdout + seeded.stderr).toBe(0);
    const oldCommit = warm.head();
    const repo = join(m.stateDir, "cache", "git", `${cloneKey(warm.url)}.git`);
    m.git(repo, "repack", "-ad");
    warm.commit({ "version.txt": "second" });
    const state = join(m.stateDir, "state.json");
    rmSync(state);
    const manifest = m.manifest({ agents: ["claude-code"], sources });
    const entered = join(m.root, "repacking");
    const midxLock = "objects/pack/multi-pack-index.lock";
    const slow = slowFetches(m.root, m.env, 0, {
      before: `case "$*" in *first.git*)
        until [ -f "${entered}" ]; do sleep 0.05; done
        mkdir "${state}";;
      esac`,
      maintenance: `if [ "$PWD" -ef "${repo}" ]; then
        touch objects/maintenance.lock "${midxLock}"
        touch "${entered}"
        exec sleep 30
      fi`,
    });
    const sync = await m.runWith(
      {
        env: {
          PATH: slow.PATH,
          GIT_EXEC_PATH: slow.GIT_EXEC_PATH,
          FLEETRC_SYNC_TIMEOUT_MS: "5000",
        },
      },
      "sync",
      "--manifest",
      manifest,
    );
    expect(existsSync(entered)).toBe(true);
    expect(sync.code).not.toBe(0);
    expect(sync.stdout + sync.stderr).toContain("EISDIR");
    expect(m.git(repo, "cat-file", "-t", oldCommit)).toBe("commit");
    expect(existsSync(join(repo, "objects/maintenance.lock"))).toBe(false);
    expect(existsSync(join(repo, midxLock))).toBe(false);
    m.git(repo, "multi-pack-index", "write");
    rmSync(state, { recursive: true });
    const resumed = await m.run("sync", "--manifest", manifest);
    expect(resumed.code, resumed.stdout + resumed.stderr).toBe(0);
  });

  it("cancels stalled fetches without losing cached history or hiding the checkpoint error", async () => {
    const m = machine();
    const ids = ["first", "two", "three", "four", "five", "six", "seven"];
    const remotes = ids.map((id) => remote(m, id, skills("skills/", `${id}-skill`)));
    const sources = ids.map((id, index) => ({
      id,
      git: remotes[index]!.url,
    }));
    const warm = remotes[1]!;
    const seed = m.manifest({ agents: ["claude-code"], sources: [sources[1]] });
    const seeded = await m.run("sync", "--manifest", seed);
    expect(seeded.code, seeded.stdout + seeded.stderr).toBe(0);
    const oldCommit = warm.head();
    const repo = join(m.stateDir, "cache", "git", `${cloneKey(warm.url)}.git`);
    expect(m.git(repo, "rev-parse", "refs/fleetrc/fetched")).toBe(oldCommit);
    rmSync(join(m.stateDir, "state.json"));
    const manifest = m.manifest({ agents: ["claude-code"], sources });
    const lock = join(m.stateDir, "sync.lock");
    const slow = slowFetches(m.root, m.env, 0, {
      before: `case "$*" in
        *first.git*)
          until [ -f "${join(m.root, "warm-stalling")}" ]; do sleep 0.05; done
          mkdir "${join(m.stateDir, "state.json")}";;
        *)
          case "$*" in *two.git*) touch shallow.lock;; esac
          sh -c 'sleep 5; echo survived >> "${join(m.root, "fetches.log")}"' &
          echo "$!" >> "${join(m.root, "stalling")}"
          case "$*" in *two.git*) touch "${join(m.root, "warm-stalling")}";; esac
          wait;;
      esac`,
      after: `if [ ! -f "${lock}" ]; then echo unlocked >> "${join(m.root, "fetches.log")}"; fi`,
    });
    const sync = await m.runWith(
      { env: { PATH: slow.PATH, FLEETRC_SYNC_TIMEOUT_MS: "2500" } },
      "sync",
      "--manifest",
      manifest,
    );
    expect(sync.code).not.toBe(0);
    expect(sync.stdout + sync.stderr).toContain("EISDIR");
    expect(existsSync(lock)).toBe(false);
    const fetches = slow.fetches();
    expect(fetches).not.toContain("unlocked");
    const starts = fetches.filter((event) => event === "start").length;
    expect(starts).toBeGreaterThan(1);
    expect(starts).toBeLessThan(ids.length);
    expect(fetches.filter((event) => event === "end")).toHaveLength(1);
    const stalled = readFileSync(join(m.root, "stalling"), "utf8").trim().split("\n");
    for (const pid of stalled) {
      await expect
        .poll(() => {
          const status = spawnSync("ps", ["-o", "stat=", "-p", pid], { encoding: "utf8" });
          return (
            status.status === 1 || (status.status === 0 && status.stdout.trim().startsWith("Z"))
          );
        })
        .toBe(true);
    }
    expect(existsSync(join(repo, "shallow.lock"))).toBe(false);
    expect(m.git(repo, "cat-file", "-t", oldCommit)).toBe("commit");
  });
});
