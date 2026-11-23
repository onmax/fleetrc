import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vite-plus/test";
import { isWindows, machine, names, pathWith, remote, skills } from "./fixture.ts";

/**
 * A git first on PATH that logs when each fetch starts and ends, and makes it take `ms` longer, so
 * a test can see which fetches overlap. Everything else goes straight to git.
 */
function slowFetches(root: string, env: NodeJS.ProcessEnv, ms: number) {
  const bin = join(root, "slow-git");
  const log = join(root, "fetches.log");
  mkdirSync(bin, { recursive: true });
  // git's own binary, past any wrapper on PATH that would find this one and call it back.
  const real = join(execFileSync("git", ["--exec-path"], { env, encoding: "utf8" }).trim(), "git");
  writeFileSync(
    join(bin, "git"),
    `#!/bin/sh
for arg in "$@"; do
  if [ "$arg" = fetch ]; then
    echo start >> "${log}"
    sleep ${ms / 1000}
    "${real}" "$@"; code=$?
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
});
