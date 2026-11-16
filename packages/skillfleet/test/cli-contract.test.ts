// What the CLI promises in its help and the README: errors as one line, --dry-run that writes
// nothing, --json that prints one document, --copy that sticks, and the commands and messages the
// docs name (D1, D3, D4, D5, D7, D11, D12, MAC10).
import { createHash } from "node:crypto";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join, relative } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vite-plus/test";
import { listedPath } from "../src/linker.ts";
import {
  clone,
  isLink,
  isWindows,
  machine,
  type Machine,
  names,
  read,
  remote,
  type RunResult,
  skillMd,
  skills,
} from "./fixture.ts";

/** Every file, folder and link under `root`, with contents hashed: what a dry run must leave as it was. */
function snapshot(root: string): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const path = join(dir, name);
      const key = relative(root, path);
      // The fake scheduler's own log of the calls it answered.
      if (key === "scheduler-calls.jsonl") continue;
      const stat = lstatSync(path);
      if (stat.isSymbolicLink()) out[key] = `link ${readlinkSync(path)}`;
      else if (stat.isDirectory()) {
        out[key] = "dir";
        walk(path);
      } else out[key] = createHash("sha256").update(readFileSync(path)).digest("hex");
    }
  };
  walk(root);
  return out;
}

/** A user mistake gets one line on stderr, and never a stack trace. */
function oneLine(run: RunResult) {
  expect(run.stderr.trim().split("\n"), run.stderr).toHaveLength(1);
  expect(run.stderr).not.toMatch(/^\s+at /m);
}

/** A machine with a personal working clone, a vendored source with an edited skill and a pending update, and an extra skill to adopt. */
async function workbench() {
  const m = machine({ scheduler: "empty" });
  const personal = remote(m, "personal", skills("skills/", "mine"));
  const work = clone(m, personal, "code/skills");
  const vendor = remote(m, "vendor", {
    ...skills("skills/", "plain"),
    "skills/tool/SKILL.md": skillMd("tool", "one"),
  });
  const manifest = m.manifest({
    agents: ["claude-code"],
    sources: [
      { id: "personal", git: personal.url, path: work, skills: "skills/*", adopt: true },
      { id: "vendor", git: vendor.url },
    ],
    fleet: ["localhost"],
  });
  const init = await m.run("init", manifest, "--no-timer");
  expect(init.code, init.stdout + init.stderr).toBe(0);
  writeFileSync(m.at(".claude/skills/tool/SKILL.md"), skillMd("tool", "one, edited"));
  vendor.commit({ "skills/tool/ref.md": "new upstream file\n" });
  expect((await m.run("sync")).code).toBe(0);
  const handmade = m.at("handmade");
  mkdirSync(handmade);
  writeFileSync(join(handmade, "SKILL.md"), skillMd("handmade"));
  return { m, manifest, work, vendor, handmade };
}

/** An ssh that runs the command on this machine, for hosts named localhost. */
function localSsh(m: Machine): NodeJS.ProcessEnv {
  const script = join(m.root, "ssh.mjs");
  writeFileSync(
    script,
    `import { spawnSync } from "node:child_process";
const rest = process.argv.slice(2);
while (rest[0] === "-o") rest.splice(0, 2);
if (rest[0] === "--") rest.shift();
const run = spawnSync("sh", ["-c", rest[1]], { stdio: "inherit" });
process.exit(run.status ?? 1);
`,
  );
  return { SKILLFLEET_SSH: script };
}

describe("errors", () => {
  it("D1. init with a repository that does not exist says so in one line", async () => {
    const m = machine();
    const missing = pathToFileURL(join(m.root, "remotes", "typo.git")).href;
    const init = await m.run("init", missing, "--no-timer");
    expect(init.code).toBe(1);
    oneLine(init);
    expect(init.stderr).toMatch(
      /^skillfleet: cannot read the repository .*typo\.git: it does not exist, or it is private/,
    );
  });

  it.skipIf(isWindows)(
    "D1. init with a repository manifest and no git says git is missing",
    async () => {
      const m = machine();
      const bin = join(m.root, "nogit");
      mkdirSync(bin);
      symlinkSync(process.execPath, join(bin, "node"));
      const init = await m.runWith({ env: { PATH: bin } }, "init", "my-team/agents", "--no-timer");
      expect(init.code).toBe(1);
      oneLine(init);
      expect(init.stderr).toMatch(/git is not installed/);
    },
  );

  it("D1. an error skillfleet did not expect names the debug variable, and prints the stack only with it", async () => {
    const m = machine();
    // A config.json that is a folder: reading it fails with an error no check expects.
    mkdirSync(m.at(".config/skillfleet/config.json"), { recursive: true });
    const plain = await m.run("status");
    expect(plain.code).toBe(1);
    expect(plain.stderr).toMatch(/SKILLFLEET_DEBUG=1/);
    expect(plain.stderr).not.toMatch(/^\s+at /m);
    const debug = await m.runWith({ env: { SKILLFLEET_DEBUG: "1" } }, "status");
    expect(debug.stderr).toMatch(/^\s+at /m);
  });

  it("D3. an unknown agent id is a manifest error naming the closest id", async () => {
    const m = machine();
    const manifest = m.manifest({ agents: ["claude-cod"], sources: [] });
    const init = await m.run("init", manifest, "--no-timer");
    expect(init.code).toBe(1);
    oneLine(init);
    expect(init.stderr).toContain('agents names "claude-cod", which is not an agent id');
    expect(init.stderr).toContain('did you mean "claude-code"?');
    expect(init.stderr).toContain("`skillfleet agents` lists the ids");
  });

  it('D3. "agents": "all" with no agent installed warns that nothing was linked', async () => {
    const m = machine({ agents: false });
    const manifest = m.manifest({ sources: [] });
    const init = await m.run("init", manifest, "--no-timer");
    expect(init.stdout).toContain("linked 0 skills into 0 folders");
    expect(init.stdout).toContain(
      'warning: no agent is installed here, so no skills were linked: "agents": "all" means',
    );
  });

  it("D3. agents lists every id, which are installed, and where the manifest links them", async () => {
    const m = machine();
    const none = await m.json<{ id: string; detected: boolean; linkedInto?: string }[]>("agents");
    expect(none.find((row) => row.id === "claude-code")).toMatchObject({ detected: true });
    expect(none.find((row) => row.id === "claude-code")!.linkedInto).toBeUndefined();
    const manifest = m.manifest({ agents: ["claude-code"], sources: [] });
    expect((await m.run("init", manifest, "--no-timer")).code).toBe(0);
    const rows = await m.json<{ id: string; detected: boolean; linkedInto?: string }[]>("agents");
    expect(rows.length).toBeGreaterThan(40);
    expect(rows.find((row) => row.id === "claude-code")!.linkedInto).toBe(m.at(".claude/skills"));
    expect(rows.find((row) => row.id === "codex")!.linkedInto).toBeUndefined();
    expect((await m.run("agents")).stdout).toMatch(
      /^claude-code +installed {2}linked into ~?.*skills$/m,
    );
  });
});

describe("--dry-run changes nothing", () => {
  it("D5. add, remove, fleet add, adopt, fork, merge, update, sync and timer remove", async () => {
    const { m, handmade } = await workbench();
    const extra = remote(m, "extra", skills("skills/", "extra"));
    const runs: string[][] = [
      ["add", extra.url, "--id", "extra"],
      ["remove", "vendor"],
      ["remove", "plain"],
      ["fleet", "add", "laptop"],
      ["adopt", handmade],
      ["fork", "tool"],
      ["merge", "tool"],
      ["update", "vendor"],
      ["sync"],
      ["init"],
      ["timer", "remove"],
      ["timer", "install"],
    ];
    const before = snapshot(m.root);
    for (const args of runs) {
      const run = await m.run(...args, "--dry-run");
      expect(run.code, `${args.join(" ")}: ${run.stdout}${run.stderr}`).toBe(0);
      expect(snapshot(m.root), args.join(" ")).toEqual(before);
    }
    expect((await m.run("fork", "tool", "--dry-run")).stdout).toMatch(
      /^would copy .* to .*tool, record the fork in /,
    );
    expect((await m.run("merge", "tool", "--dry-run")).stdout).toBe("would merge: ref.md\n");
    expect((await m.run("adopt", handmade, "--dry-run")).stdout).toMatch(
      /^would move handmade to /,
    );
  });

  it.skipIf(isWindows)("D5. fleet sync --dry-run runs a dry sync on each host", async () => {
    const { m } = await workbench();
    const env = localSsh(m);
    const before = snapshot(m.root);
    const run = await m.runWith({ env }, "fleet", "sync", "--dry-run", "--json");
    expect(run.code, run.stdout + run.stderr).toBe(0);
    const [host] = JSON.parse(run.stdout) as { reachable: boolean; lastRun: { skills: number } }[];
    expect(host).toMatchObject({ reachable: true, lastRun: { skills: 3 } });
    expect(snapshot(m.root)).toEqual(before);
  });

  it("D5. commands that only read, and those with no dry run, refuse the flag in one line", async () => {
    const m = machine();
    for (const [args, said] of [
      [["status"], "status changes nothing, so it has no --dry-run"],
      [["diff", "x"], "diff changes nothing, so it has no --dry-run"],
      [["timer", "status"], "timer status changes nothing, so it has no --dry-run"],
      [["fleet", "upgrade"], "fleet upgrade has no --dry-run"],
      [["hook", "prompt"], "hook has no --dry-run"],
    ] as const) {
      const run = await m.run(
        ...args,
        "--dry-run",
        "--manifest",
        m.manifest({ sources: [], fleet: ["h"] }),
      );
      expect(run.code, run.stderr).toBe(2);
      oneLine(run);
      expect(run.stderr).toContain(said);
    }
  });
});

describe("--json prints one JSON document", () => {
  it("D11. for every command that takes it", async () => {
    const { m, handmade } = await workbench();
    const extra = remote(m, "extra", skills("skills/", "extra"));
    const env = localSsh(m);
    const runs: string[][] = [
      ["sync"],
      ["status"],
      ["list"],
      ["agents"],
      ["doctor"],
      ["init", "--dry-run"],
      ["timer", "status"],
      ["timer", "install", "--dry-run"],
      ["timer", "remove", "--dry-run"],
      ["add", extra.url, "--id", "extra"],
      ["remove", "extra"],
      ["remove", "plain"],
      ["fleet", "add", "laptop", "--dry-run"],
      ["fleet", "status", "localhost"],
      ...(isWindows ? [] : [["fleet", "sync", "localhost"]]),
      ["merge", "tool"],
      ["fork", "tool"],
      ["adopt", handmade],
      ["update", "vendor"],
      ["init", "--no-timer"],
    ];
    for (const args of runs) {
      const run = await m.runWith({ env }, ...args, "--json");
      expect(
        () => JSON.parse(run.stdout),
        `${args.join(" ")} --json:\n${run.stdout}\n${run.stderr}`,
      ).not.toThrow();
    }
  });
});

describe("--copy", () => {
  it("D12. is remembered, so a later sync keeps copies, until --no-copy", async () => {
    const m = machine();
    const vendor = remote(m, "vendor", skills("skills/", "tool"));
    const manifest = m.manifest({
      agents: ["claude-code"],
      sources: [{ id: "vendor", git: vendor.url }],
    });
    expect((await m.run("init", manifest, "--no-timer", "--copy")).code).toBe(0);
    const config = () =>
      JSON.parse(read(m.at(".config/skillfleet/config.json"))) as { copy?: boolean };
    expect(config().copy).toBe(true);
    expect(isLink(m.at(".claude/skills/tool"))).toBe(false);
    vendor.commit({ "skills/tool/SKILL.md": skillMd("tool", "v2") });
    // The timer runs plain `sync`.
    expect((await m.run("sync")).code).toBe(0);
    expect(isLink(m.at(".claude/skills/tool"))).toBe(false);
    expect(read(m.at(".claude/skills/tool/SKILL.md"))).toBe(skillMd("tool", "v2"));
    expect((await m.run("sync", "--no-copy")).code).toBe(0);
    expect(isLink(m.at(".claude/skills/tool"))).toBe(true);
    expect(config().copy).toBe(false);
    expect((await m.run("sync")).code).toBe(0);
    expect(isLink(m.at(".claude/skills/tool"))).toBe(true);
  });
});

describe("fork with a manifest kept in a repository", () => {
  it("D7. records the fork in the working clone of the manifest, where a fetch can't reset it", async () => {
    const m = machine();
    const vendor = remote(m, "vendor", skills("skills/", "tool"));
    const manifests = remote(m, "manifests", { "skills.json": "{}", ...skills("skills/", "mine") });
    const work = clone(m, manifests, "code/manifests");
    const content = {
      agents: ["claude-code"],
      sources: [
        { id: "mine", git: manifests.url, path: work, skills: "skills/*", adopt: true },
        { id: "vendor", git: vendor.url },
      ],
    };
    manifests.commit({ "skills.json": JSON.stringify(content) });
    m.git(work, "pull", "--quiet");
    expect((await m.run("init", `${manifests.url}//skills.json`, "--no-timer")).code).toBe(0);
    const fork = await m.run("fork", "tool");
    expect(fork.code, fork.stdout + fork.stderr).toBe(0);
    expect(fork.stdout).toContain(`then commit and push ~/code/manifests/skills.json`);
    const edited = JSON.parse(read(join(work, "skills.json"))) as {
      forks: Record<string, { from: string }>;
      sources: { exclude?: string[] }[];
    };
    expect(edited.forks.tool!.from).toBe(vendor.url);
    expect(edited.sources[1]!.exclude).toEqual(["tool"]);
    expect(existsSync(join(work, "skills/tool/SKILL.md"))).toBe(true);
    m.git(work, "add", "-A");
    m.git(work, "commit", "--quiet", "-m", "fork tool");
    m.git(work, "push", "--quiet");
    const report = await m.json("sync");
    expect(report.ok).toBe(true);
    expect(names(m.at(".claude/skills"))).toEqual(["mine", "tool"]);
    expect((await m.run("diff", "tool")).code).toBe(0);
  });

  it("D7. without a working clone, fork changes nothing and prints what to add upstream", async () => {
    const m = machine();
    const vendor = remote(m, "vendor", skills("skills/", "tool"));
    const personal = remote(m, "personal", skills("skills/", "mine"));
    const work = clone(m, personal, "code/skills");
    const manifests = remote(m, "manifests", {
      "skills.json": JSON.stringify({
        agents: ["claude-code"],
        sources: [
          { id: "mine", git: personal.url, path: work, skills: "skills/*", adopt: true },
          { id: "vendor", git: vendor.url },
        ],
      }),
    });
    expect((await m.run("init", `${manifests.url}//skills.json`, "--no-timer")).code).toBe(0);
    const before = snapshot(m.root);
    const fork = await m.run("fork", "tool");
    expect(fork.code).toBe(1);
    oneLine(fork);
    expect(fork.stderr).toContain('Add {"tool":{"from":');
    expect(fork.stderr).toContain('and "tool" to "exclude" of the source "vendor"');
    expect(snapshot(m.root)).toEqual(before);
  });
});

describe("docs and help", () => {
  it("D4. diff with no skill shows every update a source holds for review", async () => {
    const m = machine();
    const vendor = remote(m, "vendor", skills("skills/", "a", "b"));
    const manifest = m.manifest({
      agents: ["claude-code"],
      sources: [{ id: "vendor", git: vendor.url, update: "review" }],
    });
    expect((await m.run("init", manifest, "--no-timer")).code).toBe(0);
    expect((await m.run("diff")).stdout).toBe("no updates are waiting for review\n");
    vendor.commit({
      "skills/a/SKILL.md": skillMd("a", "a v2"),
      "skills/b/SKILL.md": skillMd("b", "b v2"),
    });
    await m.run("sync");
    const diff = await m.run("diff");
    expect(diff.code).toBe(0);
    expect(diff.stdout).toContain("+a v2");
    expect(diff.stdout).toContain("+b v2");
  });

  it("MAC10. diff headers name the skill's files, not store paths, and keep Unicode as it is", async () => {
    const m = machine();
    const vendor = remote(m, "vendor", { "skills/tööl/SKILL.md": skillMd("tööl", "v1") });
    const manifest = m.manifest({
      agents: ["claude-code"],
      sources: [{ id: "vendor", git: vendor.url, update: "review" }],
    });
    expect((await m.run("init", manifest, "--no-timer")).code).toBe(0);
    vendor.commit({ "skills/tööl/SKILL.md": skillMd("tööl", "v2") });
    await m.run("sync");
    const diff = await m.run("diff", "tööl");
    expect(diff.stdout).toContain("--- local/tööl/SKILL.md\n+++ upstream/tööl/SKILL.md\n");
    expect(diff.stdout).not.toContain(m.stateDir);
    expect(diff.stdout).not.toContain("\\303");
  });

  it("D4. <command> --help prints that command's usage, and an unknown command one line", async () => {
    const m = machine();
    const help = await m.run("add", "--help");
    expect(help.code).toBe(0);
    expect(help.stdout).toMatch(/^Usage: skillfleet add <source> \[options\]\n/);
    for (const flag of ["--id", "--skills", "--include", "--exclude", "--review", "--dry-run"])
      expect(help.stdout).toContain(`  ${flag}`);
    expect(help.stdout).not.toContain("--timeout");
    const typo = await m.run("sycn");
    expect(typo.code).toBe(2);
    oneLine(typo);
    expect(typo.stderr).toContain('unknown command "sycn"; did you mean "sync"?');
    const option = await m.run("sync", "--frob");
    expect(option.code).toBe(2);
    oneLine(option);
    const wrong = await m.run("status", "--id", "x");
    expect(wrong.code).toBe(2);
    expect(wrong.stderr).toContain("status does not take --id");
  });

  it("MAC10. doctor skips the timer after init --no-timer", async () => {
    const m = machine({ scheduler: "empty" });
    const manifest = m.manifest({ agents: ["claude-code"], sources: [] });
    expect((await m.run("init", manifest, "--no-timer")).code).toBe(0);
    const doctor = await m.run("doctor");
    expect(doctor.stdout).toMatch(/^skip timer: not installed, as you chose/m);
    expect(doctor.stdout).not.toContain("linger");
    expect(doctor.code, doctor.stdout).toBe(0);
  });

  it("MAC10. the timer's runs start with their time, so its log reads as a history", async () => {
    const m = machine();
    const manifest = m.manifest({ agents: ["claude-code"], sources: [] });
    expect((await m.run("init", manifest, "--no-timer")).code).toBe(0);
    const spec = await m.json<{ env: Record<string, string> }>("timer", "install", "--dry-run");
    expect(spec.env.SKILLFLEET_TIMER).toBe("1");
    const run = await m.runWith({ env: { SKILLFLEET_TIMER: "1" } }, "sync");
    expect(run.stdout).toMatch(
      /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z skillfleet: linked 0 skills/,
    );
  });

  it("MAC10. a warning about a folder names it as the disk lists it", () => {
    const m = machine();
    const dir = m.at("agent-folder");
    mkdirSync(join(dir, "mine"), { recursive: true });
    // On a disk that ignores case, the skill "Mine" lands on the folder "mine".
    expect(listedPath(dir, "Mine")).toBe(join(dir, "mine"));
    expect(listedPath(dir, "mine")).toBe(join(dir, "mine"));
    expect(listedPath(dir, "other")).toBe(join(dir, "other"));
  });
});
