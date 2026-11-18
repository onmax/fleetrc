// Session hooks, skillfleet's default trigger: `hook run <agent>` starts a sync in the background
// when the last attempt is stale, `hook install` and `hook remove` edit Claude Code's settings.json
// and Codex's hooks.json, and init, status and doctor follow the hooks or the timer.
import { spawn, spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { delimiter, dirname, join } from "node:path";
import { describe, expect, it } from "vite-plus/test";
import {
  editHooksFile,
  hookHandler,
  isOwnHandler,
  withHook,
  withoutHooks,
} from "../src/agenthooks.ts";
import { lockText } from "../src/lock.ts";
import {
  cli,
  isWindows,
  machine,
  type Machine,
  read,
  skillMd,
  systemdShim,
  writeFiles,
} from "./fixture.ts";

const SESSION = JSON.stringify({ session_id: "s1", hook_event_name: "SessionStart" });
const PROMPT = JSON.stringify({ session_id: "s1", hook_event_name: "UserPromptSubmit" });

/** A machine pointed at a local folder of skills, with the session hooks installed. */
async function hooked(options: { agents?: boolean } = {}) {
  const m = machine(options);
  const mine = join(m.root, "mine");
  writeFiles(mine, { "skills/first/SKILL.md": skillMd("first") });
  const manifest = m.manifest({
    agents: ["claude-code"],
    sources: [{ id: "mine", local: mine, skills: "skills/*" }],
  });
  const init = await m.run("init", manifest);
  expect(init.code, init.stdout + init.stderr).toBe(0);
  return { m, mine, manifest };
}

const hook = (m: Machine, agent: string, input = SESSION, env: NodeJS.ProcessEnv = {}) =>
  m.runWith({ input, env: { ...m.env, ...env } }, "hook", "run", agent);

const log = (m: Machine) => join(m.stateDir, "logs", "skillfleet-sync.log");
/** The syncs the hooks started, as their lines in the log say. */
const started = (m: Machine) =>
  existsSync(log(m))
    ? read(log(m))
        .split("\n")
        .filter((line) => line.endsWith(" starting a sync"))
    : [];

const lastRun = (m: Machine) =>
  JSON.parse(read(join(m.stateDir, "last-run.json"))) as { finishedAt: string; ok: boolean };

async function waitFor(what: string, check: () => boolean, ms = 60_000) {
  const deadline = Date.now() + ms;
  while (!check()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((done) => setTimeout(done, 100));
  }
}

interface Entry {
  command: string;
  args?: string[];
}

const settings = (m: Machine) =>
  JSON.parse(read(m.at(".claude", "settings.json"))) as {
    hooks?: Record<string, { hooks: Entry[] }[]>;
  };

/** An entry as one line: its command, then its args in exec form. */
const line = (entry: Entry) => [entry.command, ...(entry.args ?? [])].join(" ");

describe("hook run", () => {
  it("does nothing, says nothing and creates nothing on a machine that was never set up", async () => {
    const m = machine();
    for (const [agent, input] of [
      ["claude-code", SESSION],
      ["claude-code", PROMPT],
      ["codex", SESSION],
    ] as const) {
      const run = await hook(m, agent, input);
      expect(run).toEqual({ code: 0, stdout: "", stderr: "" });
    }
    const prompt = await m.runWith({ input: PROMPT }, "hook", "prompt");
    expect(prompt).toEqual({ code: 0, stdout: "", stderr: "" });
    expect(existsSync(m.stateDir)).toBe(false);
  });

  it("stays quiet and exits 0 with a broken config.json", async () => {
    const { m } = await hooked();
    rmSync(join(m.stateDir, "hook-attempt"), { force: true });
    writeFileSync(m.at(".config", "skillfleet", "config.json"), "{");
    for (const input of [SESSION, PROMPT, "not json"]) {
      const run = await hook(m, "claude-code", input);
      expect(run).toEqual({ code: 0, stdout: "", stderr: "" });
    }
    expect(started(m)).toEqual([]);
    expect(existsSync(join(m.stateDir, "hook-attempt"))).toBe(false);
  });

  it("starts one sync when many sessions start at once, and none while the attempt is fresh", async () => {
    const { m, mine } = await hooked();
    const before = lastRun(m).finishedAt;
    writeFiles(mine, { "skills/second/SKILL.md": skillMd("second") });
    const runs = await Promise.all(
      Array.from({ length: 8 }, (_, i) => hook(m, i % 2 ? "codex" : "claude-code")),
    );
    for (const run of runs) expect(run).toEqual({ code: 0, stdout: "", stderr: "" });
    expect(started(m)).toHaveLength(1);
    // The sync runs on after the hook has exited.
    await waitFor("the hook's sync", () => lastRun(m).finishedAt > before);
    expect(existsSync(m.at(".claude", "skills", "second", "SKILL.md"))).toBe(true);
    // Fresh: the next prompts start nothing.
    await hook(m, "claude-code", PROMPT);
    await hook(m, "codex");
    expect(started(m)).toHaveLength(1);
    // Stale again (the threshold is 0 here): one more.
    await hook(m, "codex", SESSION, { SKILLFLEET_HOOK_STALE_MS: "0" });
    expect(started(m)).toHaveLength(2);
  });

  it("starts no sync while one holds the lock", async () => {
    const { m } = await hooked();
    // This test's process stands in for a running sync.
    writeFileSync(join(m.stateDir, "sync.lock"), lockText());
    try {
      const run = await hook(m, "claude-code", SESSION, { SKILLFLEET_HOOK_STALE_MS: "0" });
      expect(run).toEqual({ code: 0, stdout: "", stderr: "" });
      expect(started(m)).toEqual([]);
    } finally {
      rmSync(join(m.stateDir, "sync.lock"), { force: true });
    }
    await hook(m, "claude-code", SESSION, { SKILLFLEET_HOOK_STALE_MS: "0" });
    expect(started(m)).toHaveLength(1);
  });

  it("breaks a claim left by a hook that was killed", async () => {
    const { m } = await hooked();
    const claim = join(m.stateDir, "hook-attempt.claim");
    writeFileSync(claim, "1");
    expect((await hook(m, "claude-code")).code).toBe(0);
    expect(started(m)).toEqual([]);
    const old = new Date(Date.now() - 5 * 60_000);
    const { utimesSync } = await import("node:fs");
    utimesSync(claim, old, old);
    expect((await hook(m, "claude-code")).code).toBe(0);
    expect(started(m)).toHaveLength(1);
    expect(existsSync(claim)).toBe(false);
  });

  it("runs the sync in the state folder, with the installing shell's PATH, not the agent's", async () => {
    const { m, mine } = await hooked();
    const seen = join(m.root, "seen.json");
    const script = join(m.root, "record.mjs");
    writeFileSync(
      script,
      `import { writeFileSync } from "node:fs";\nwriteFileSync(${JSON.stringify(seen)}, JSON.stringify({ cwd: process.cwd(), path: process.env.PATH }));\n`,
    );
    const manifest = JSON.parse(read(join(m.root, "manifest", "skills.json"))) as object;
    m.manifest({
      ...manifest,
      hooks: [{ name: "record", run: `"${process.execPath}" "${script}"`, on: ["mine:**"] }],
    });
    writeFiles(mine, { "skills/first/SKILL.md": skillMd("first", "changed") });
    const agentBin = join(m.root, "agent-bin");
    mkdirSync(agentBin);
    const run = await hook(m, "codex", SESSION, {
      PATH: [agentBin, m.env.PATH].join(delimiter),
      SKILLFLEET_HOOK_STALE_MS: "0",
    });
    expect(run.code).toBe(0);
    await waitFor("the manifest's hook", () => existsSync(seen));
    const { cwd, path } = JSON.parse(read(seen)) as { cwd: string; path: string };
    expect(cwd).toBe(m.stateDir);
    expect(path.split(delimiter)).not.toContain(agentBin);
  });

  it("names a skill that arrived mid-session to Claude Code, and never to Codex", async () => {
    const { m, mine } = await hooked();
    expect((await hook(m, "claude-code", PROMPT)).stdout).toBe("");
    expect((await hook(m, "codex", PROMPT)).stdout).toBe("");
    writeFiles(mine, { "skills/late/SKILL.md": skillMd("late") });
    expect((await m.run("sync")).code).toBe(0);
    expect((await hook(m, "codex", PROMPT)).stdout).toBe("");
    const said = await hook(m, "claude-code", PROMPT);
    expect(said.stdout).toContain("a new skill arrived after this session started");
    expect(said.stdout).toContain("late");
    // `hook prompt`, the entry older settings hold, still says it once.
    expect((await m.runWith({ input: PROMPT }, "hook", "prompt")).stdout).toBe("");
  });

  it("runs the entry it wrote into settings.json as Claude Code does, from a parent that exits at once", async () => {
    const { m, mine } = await hooked();
    const before = lastRun(m).finishedAt;
    writeFiles(mine, { "skills/third/SKILL.md": skillMd("third") });
    const entry = settings(m).hooks!.SessionStart![0]!.hooks[0]!;
    // Shell form through a shell; exec form (Windows) spawns the command itself, with no shell.
    const how = entry.args
      ? `${JSON.stringify(entry.command)}, ${JSON.stringify(entry.args)}, {`
      : `${JSON.stringify(entry.command)}, { shell: true,`;
    // The parent is gone as soon as the hook is: what an agent that quits right after does.
    const parent = `const { spawn } = require("node:child_process");
const child = spawn(${how} stdio: ["pipe", "inherit", "inherit"] });
child.stdin.end(${JSON.stringify(SESSION)});
child.on("exit", (code) => process.exit(code ?? 1));`;
    const run = await new Promise<{ code: number | null; out: string }>((done) => {
      const child = spawn(process.execPath, ["-e", parent], { env: m.env, cwd: m.home });
      let out = "";
      child.stdout.on("data", (chunk: Buffer) => (out += chunk));
      child.stderr.on("data", (chunk: Buffer) => (out += chunk));
      child.on("close", (code) => done({ code, out }));
    });
    expect(run).toEqual({ code: 0, out: "" });
    await waitFor("the hook's sync", () => lastRun(m).finishedAt > before);
    expect(lastRun(m).ok).toBe(true);
    expect(existsSync(m.at(".claude", "skills", "third", "SKILL.md"))).toBe(true);
  });
});

describe("hook install and remove", () => {
  it("adds the hook to Claude Code and Codex once, keeping their other hooks, fields and layout", async () => {
    const m = machine();
    const own = {
      model: "opus",
      hooks: {
        UserPromptSubmit: [{ hooks: [{ type: "command", command: "echo mine" }] }],
        Stop: [{ hooks: [{ type: "command", command: "echo stop" }] }],
      },
    };
    const original = `${JSON.stringify(own, null, 4)}\n`;
    writeFileSync(m.at(".claude", "settings.json"), original);
    const install = await m.run("hook", "install");
    expect(install.code, install.stderr).toBe(0);
    expect(install.stdout).toContain("Claude Code: added skillfleet's hook to");
    expect(install.stdout).toMatch(/Codex: added .*open \/hooks in Codex and approve it/);
    const text = read(m.at(".claude", "settings.json"));
    expect(text).toContain('\n    "model": "opus"');
    const after = settings(m);
    const ours = (event: string) =>
      after
        .hooks![event]!.flatMap((group) => group.hooks.map(line))
        .filter((text) => text.includes(" hook run claude-code"));
    expect(ours("SessionStart")).toHaveLength(1);
    expect(ours("UserPromptSubmit")).toHaveLength(1);
    // Windows: node, through bin/'s link, and the installed copy, in exec form.
    expect(ours("SessionStart")[0]).toContain(
      process.platform === "win32"
        ? `${join(m.stateDir, "bin", "node-dir")}\\node.exe ${join(m.stateDir, "app", "cli.mjs")}`
        : '"$HOME/.local/state/skillfleet/bin/skillfleet" hook run claude-code 2>/dev/null || true',
    );
    expect(after.hooks!.UserPromptSubmit![0]!.hooks[0]!.command).toBe("echo mine");
    expect(after.hooks!.Stop).toEqual(own.hooks.Stop);
    // Codex's file holds only "hooks", the one key besides "description" it accepts.
    const codex = JSON.parse(read(m.at(".codex", "hooks.json"))) as Record<string, unknown>;
    expect(Object.keys(codex)).toEqual(["hooks"]);
    expect(JSON.stringify(codex)).toContain("hook run codex");

    const again = await m.run("hook", "install");
    expect(again.stdout).toContain("Claude Code: hook already in");
    expect(read(m.at(".claude", "settings.json"))).toBe(text);

    const remove = await m.run("hook", "remove");
    expect(remove.code, remove.stderr).toBe(0);
    expect(remove.stdout).toContain("Claude Code: removed skillfleet's hook");
    expect(JSON.parse(read(m.at(".claude", "settings.json")))).toEqual(own);
    expect(JSON.parse(read(m.at(".codex", "hooks.json")))).toEqual({});
    expect((await m.run("hook", "remove")).stdout).toContain("Claude Code: no skillfleet hook in");
  });

  it("replaces an older entry of skillfleet's instead of adding a second", async () => {
    const m = machine();
    writeFileSync(
      m.at(".claude", "settings.json"),
      JSON.stringify({
        hooks: {
          UserPromptSubmit: [
            { hooks: [{ type: "command", command: "npx skillfleet hook prompt" }] },
          ],
        },
      }),
    );
    expect((await m.run("hook", "install", "claude-code")).code).toBe(0);
    const prompt = settings(m).hooks!.UserPromptSubmit!;
    expect(prompt).toHaveLength(1);
    expect(line(prompt[0]!.hooks[0]!)).toMatch(/ hook run claude-code( 2>\/dev\/null \|\| true)?$/);
  });

  it("on Windows writes Claude Code's entry in exec form, and Codex's for cmd, with % kept from cmd", () => {
    const profile = "C:\\Users\\Jo & Ann %PATH% x";
    const state = `${profile}\\AppData\\Local\\skillfleet`;
    const options = {
      platform: "win32" as const,
      launcher: `${state}\\bin\\skillfleet.cmd`,
      node: `${state}\\bin\\node-dir\\node.exe`,
      cli: `${state}\\app\\cli.mjs`,
      profile,
    };
    expect(hookHandler("claude-code", options)).toEqual({
      type: "command",
      command: options.node,
      args: [options.cli, "hook", "run", "claude-code"],
    });
    // cmd /C expands %PATH% even in quotes, but not inside what %USERPROFILE% expands to.
    expect(hookHandler("codex", options).command).toBe(
      '"%USERPROFILE%\\AppData\\Local\\skillfleet\\bin\\skillfleet.cmd" hook run codex',
    );
    const plain = "C:\\Users\\Jo & Ann\\AppData\\Local\\skillfleet\\bin\\skillfleet.cmd";
    expect(hookHandler("codex", { ...options, launcher: plain }).command).toBe(
      `"${plain}" hook run codex`,
    );
    expect(
      hookHandler("claude-code", { platform: "linux", launcher: "/h/a b/skillfleet", home: "/u" }),
    ).toEqual({
      type: "command",
      command: '"/h/a b/skillfleet" hook run claude-code 2>/dev/null || true',
    });

    // An entry an older install wrote in shell form gives way to exec form, once.
    const old = { type: "command", command: `"${options.launcher}" hook run claude-code` };
    const mine = { type: "command", command: "echo mine" };
    const raw: Record<string, unknown> = {
      hooks: { SessionStart: [{ hooks: [old] }], UserPromptSubmit: [{ hooks: [mine, old] }] },
    };
    const handler = hookHandler("claude-code", options);
    withHook(raw, handler);
    expect(raw).toEqual({
      hooks: {
        SessionStart: [{ hooks: [handler] }],
        UserPromptSubmit: [{ hooks: [mine] }, { hooks: [handler] }],
      },
    });
    const once = JSON.stringify(raw);
    withHook(raw, handler);
    expect(JSON.stringify(raw)).toBe(once);
    expect(isOwnHandler(handler)).toBe(true);
    // Another program's node script is not skillfleet's.
    expect(
      isOwnHandler({ command: "node", args: ["C:\\tools\\app\\cli.mjs", "hook", "run"] }),
    ).toBe(false);
    withoutHooks(raw);
    expect(raw).toEqual({ hooks: { UserPromptSubmit: [{ hooks: [mine] }] } });
  });

  it("--dry-run writes nothing", async () => {
    const m = machine();
    const dry = await m.run("hook", "install", "--dry-run");
    expect(dry.code, dry.stderr).toBe(0);
    expect(dry.stdout).toContain("Claude Code: would add skillfleet's hook");
    expect(existsSync(m.at(".claude", "settings.json"))).toBe(false);
    expect(existsSync(m.at(".codex", "hooks.json"))).toBe(false);
    expect(existsSync(m.stateDir)).toBe(false);
  });

  it("follows CLAUDE_CONFIG_DIR, and without an agent skips one whose folder is missing", async () => {
    const m = machine({ agents: false });
    const config = join(m.root, "claude-config");
    mkdirSync(config);
    const env = { ...m.env, CLAUDE_CONFIG_DIR: config };
    const run = await m.runWith({ env }, "hook", "install", "--json");
    expect(run.code, run.stderr).toBe(0);
    const changes = JSON.parse(run.stdout) as {
      agent: string;
      changed: boolean;
      skipped?: string;
    }[];
    expect(changes.find((change) => change.agent === "claude-code")).toMatchObject({
      changed: true,
    });
    expect(changes.find((change) => change.agent === "codex")?.skipped).toContain("does not exist");
    expect(existsSync(join(config, "settings.json"))).toBe(true);
    expect(existsSync(m.at(".claude", "settings.json"))).toBe(false);
    expect(existsSync(m.at(".codex"))).toBe(false);
    // Named, an agent gets its folder.
    expect((await m.runWith({ env }, "hook", "install", "codex")).code).toBe(0);
    expect(existsSync(m.at(".codex", "hooks.json"))).toBe(true);
  });

  it("leaves a settings.json it can't read alone, and fails", async () => {
    const m = machine();
    writeFileSync(m.at(".claude", "settings.json"), "{ not json");
    const run = await m.run("hook", "install", "claude-code");
    expect(run.code).toBe(1);
    expect(run.stdout).toContain("is not valid JSON");
    expect(read(m.at(".claude", "settings.json"))).toBe("{ not json");
    expect((await m.run("hook", "install", "gemini")).code).toBe(2);
  });
});

describe("init, status and doctor with the hooks or the timer", () => {
  it("init installs the hooks and no timer; status and doctor report the hooks", async () => {
    // The scheduler forbids every call: init must not reach it.
    const { m } = await hooked();
    expect(settings(m).hooks!.SessionStart).toHaveLength(1);
    expect(existsSync(m.at(".codex", "hooks.json"))).toBe(true);
    const status = await m.run("status");
    expect(status.stdout).toMatch(
      /^syncs start from: the session hooks of Claude Code and Codex$/m,
    );
    expect(status.stdout).not.toMatch(/^timer:/m);
    const doctor = await m.run("doctor");
    expect(doctor.stdout).toMatch(
      /^ok {3}sync trigger: the session hooks of Claude Code and Codex$/m,
    );
    const json = await m.json<{ trigger: { hooks: string[]; timer: boolean } }>("status");
    expect(json.trigger).toEqual({ hooks: ["claude-code", "codex"], timer: false });
    // init again: unchanged.
    const text = read(m.at(".claude", "settings.json"));
    const again = await m.run("init");
    expect(again.stdout).toContain("Claude Code: hook already in");
    expect(read(m.at(".claude", "settings.json"))).toBe(text);
  });

  it("init --no-hooks installs neither, and status and doctor warn that nothing starts a sync", async () => {
    const m = machine();
    const manifest = m.manifest({ agents: ["claude-code"], sources: [] });
    expect((await m.run("init", manifest, "--no-hooks")).code).toBe(0);
    expect(existsSync(m.at(".claude", "settings.json"))).toBe(false);
    const status = await m.run("status");
    expect(status.stdout).toMatch(
      /^syncs start from: nothing starts a sync on this machine; run `skillfleet hook install`/m,
    );
    const doctor = await m.run("doctor");
    expect(doctor.stdout).toMatch(
      /^warn sync trigger: nothing starts a sync.*`skillfleet timer install`/m,
    );
    expect(doctor.code).toBe(0);
  });

  it("with the timer, status and doctor report it; init keeps it, and --timer asks for it", async () => {
    const m = machine({ scheduler: "refuse" });
    const manifest = m.manifest({ agents: ["claude-code"], sources: [] });
    expect((await m.run("init", manifest)).code).toBe(0);
    expect(m.schedulerCalls()).toEqual([]);
    const timer = await m.run("init", manifest, "--timer", "--no-hooks");
    expect(timer.stdout).toContain("the timer was not installed");
    // A machine where `timer install` ran once.
    writeFileSync(
      m.at(".config", "skillfleet", "config.json"),
      JSON.stringify({ manifest, timer: true }),
    );
    const status = await m.run("status");
    expect(status.stdout).toMatch(
      /^syncs start from: the session hooks of Claude Code and Codex, and the timer$/m,
    );
    expect(status.stdout).toMatch(/^timer: /m);
    const doctor = await m.run("doctor");
    expect(doctor.stdout).toMatch(/^ok {3}sync trigger: .*, and the timer$/m);
    expect(doctor.stdout).toMatch(/^FAIL timer: /m);
    // init installs the timer again, without --timer.
    const calls = m.schedulerCalls().length;
    const again = await m.run("init");
    expect(again.stdout).toContain("the timer was not installed");
    expect(m.schedulerCalls().length).toBeGreaterThan(calls);
    // Only the timer.
    expect((await m.run("hook", "remove")).code).toBe(0);
    expect((await m.run("status")).stdout).toMatch(/^syncs start from: the timer$/m);
  });

  it("init on a machine without Claude Code or Codex says no hook starts a sync", async () => {
    const m = machine({ agents: false });
    mkdirSync(m.at(".gemini"), { recursive: true });
    const manifest = m.manifest({ agents: ["gemini-cli"], sources: [] });
    const init = await m.run("init", manifest);
    expect(init.code, init.stderr).toBe(0);
    expect(init.stdout).toContain("no Claude Code or Codex here, so no session hook starts a sync");
    expect(readFileSync(join(m.stateDir, "hook-env.json"), "utf8")).toContain('"PATH"');
  });
});

describe("the hooks on shared and upgraded machines", () => {
  it("self-install over a bare shell keeps the saved hook environment and only moves node's folder", async () => {
    if (isWindows) return;
    const m = machine();
    const node = (name: string) => {
      const dir = join(m.root, name, "bin");
      mkdirSync(dir, { recursive: true });
      symlinkSync(process.execPath, join(dir, "node"));
      return dir;
    };
    const [a, b] = [node("node-a"), node("node-b")];
    const manifest = m.manifest({ agents: ["claude-code"], sources: [] });
    const init = await m.runWith(
      { env: { PATH: [a, m.env.PATH].join(delimiter) } },
      "init",
      manifest,
    );
    expect(init.code, init.stderr).toBe(0);
    const saved = JSON.parse(read(join(m.stateDir, "hook-env.json"))) as Record<string, string>;
    expect(saved.PATH!.split(delimiter)[0]).toBe(a);
    // What `fleet upgrade` gets over ssh: HOME and a PATH, nothing else.
    const bare = { HOME: m.home, PATH: [b, "/usr/bin", "/bin"].join(delimiter) };
    const run = spawnSync(process.execPath, [cli, "self-install"], {
      env: bare,
      cwd: m.home,
      encoding: "utf8",
    });
    expect(run.status, run.stderr).toBe(0);
    const after = JSON.parse(read(join(m.stateDir, "hook-env.json"))) as Record<string, string>;
    expect(after).toEqual({ ...saved, PATH: saved.PATH!.replace(a, b) });
  });

  describe("writing a hooks file", () => {
    const file = () => {
      const dir = join(machine().root, "claude");
      mkdirSync(dir);
      return join(dir, "settings.json");
    };
    const addHook = (raw: Record<string, unknown>) =>
      withHook(raw, { type: "command", command: '"/s/skillfleet" hook run claude-code' });
    const stop = { Stop: [{ hooks: [{ type: "command", command: "echo stop" }] }] };

    it("keeps a handler added while it edits, by trying again on what is there now", () => {
      const settings = file();
      writeFileSync(settings, "{}\n");
      let first = true;
      const result = editHooksFile(settings, addHook, {
        step: () => {
          if (first) writeFileSync(settings, `${JSON.stringify({ hooks: stop })}\n`);
          first = false;
        },
      });
      expect(result).toEqual({ changed: true });
      const raw = JSON.parse(read(settings)) as { hooks: Record<string, unknown> };
      expect(raw.hooks.Stop).toEqual(stop.Stop);
      expect(Object.keys(raw.hooks)).toEqual(["Stop", "SessionStart", "UserPromptSubmit"]);
    });

    it("writes nothing and says so when the file keeps changing", () => {
      const settings = file();
      writeFileSync(settings, "{}\n");
      let n = 0;
      const result = editHooksFile(settings, addHook, {
        step: () => writeFileSync(settings, `{ "n": ${++n} }\n`),
      });
      expect(result.changed).toBe(false);
      expect(result.error).toContain("changed while skillfleet was editing it");
      expect(read(settings)).toBe('{ "n": 2 }\n');
      expect(readdirSync(dirname(settings))).toEqual(["settings.json"]);
    });

    it.skipIf(isWindows)("keeps the file's mode", () => {
      const settings = file();
      writeFileSync(settings, "{}\n");
      chmodSync(settings, 0o600);
      expect(editHooksFile(settings, addHook).changed).toBe(true);
      expect(statSync(settings).mode & 0o777).toBe(0o600);
    });

    it.skipIf(isWindows)(
      "edits a linked file through the link, and leaves a dangling link alone",
      () => {
        const settings = file();
        const target = join(dirname(settings), "real.json");
        writeFileSync(target, "{}\n");
        symlinkSync(target, settings);
        expect(editHooksFile(settings, addHook).changed).toBe(true);
        expect(lstatSync(settings).isSymbolicLink()).toBe(true);
        expect(read(target)).toContain("hook run claude-code");
        rmSync(target);
        const dangling = editHooksFile(settings, addHook, { create: true });
        expect(dangling.changed).toBe(false);
        expect(dangling.error).toContain("which does not exist; skillfleet left it alone");
        expect(lstatSync(settings).isSymbolicLink()).toBe(true);
        expect(existsSync(target)).toBe(false);
      },
    );
  });

  it("owns only the commands it writes, and a user's command that mentions them is left", async () => {
    const own = [
      '"$HOME/.local/state/skillfleet/bin/skillfleet" hook run claude-code 2>/dev/null || true',
      '"/opt/my state/skillfleet/bin/skillfleet" hook run codex 2>/dev/null || true',
      "/home/u/.local/state/skillfleet/bin/skillfleet hook run codex",
      '"%USERPROFILE%\\AppData\\Local\\skillfleet\\bin\\skillfleet.cmd" hook run codex',
      '"C:\\Users\\Jo & Ann\\AppData\\Local\\skillfleet\\bin\\skillfleet.cmd" hook run codex',
      "skillfleet hook prompt",
      "npx skillfleet hook prompt",
      "/home/u/.local/state/skillfleet/bin/skillfleet hook prompt",
    ];
    const theirs = [
      "printf 'run: skillfleet hook run codex\\n'",
      "foo && skillfleet hook run codex",
      '"$HOME/.local/state/skillfleet/bin/skillfleet" hook run codex; rm -rf ~/x',
      "echo /x/skillfleet hook run claude-code",
      "skillfleet hook run claude-code | tee log",
      "my-skillfleet-wrapper hook run codex",
    ];
    for (const command of own)
      expect(isOwnHandler({ type: "command", command }), command).toBe(true);
    for (const command of theirs)
      expect(isOwnHandler({ type: "command", command }), command).toBe(false);
    const exec = [
      "C:\\Users\\u\\AppData\\Local\\skillfleet\\app\\cli.mjs",
      "hook",
      "run",
      "claude-code",
    ];
    expect(isOwnHandler({ command: "C:\\node.exe", args: exec })).toBe(true);
    expect(isOwnHandler({ command: "node", args: [...exec, "--x"] })).toBe(false);

    const m = machine();
    const users = theirs.map((command) => ({ hooks: [{ type: "command", command }] }));
    writeFileSync(
      m.at(".claude", "settings.json"),
      JSON.stringify({ hooks: { SessionStart: users } }),
    );
    expect((await m.run("hook", "install", "claude-code")).code).toBe(0);
    expect((await m.run("hook", "remove", "claude-code")).code).toBe(0);
    expect(settings(m).hooks!.SessionStart).toEqual(users);
  });

  it.skipIf(isWindows)(
    "the shell-form command runs from $HOME, and exits 0 silently when the launcher or node is gone, in each shell",
    () => {
      const m = machine();
      const launcher = m.at(".local", "state", "skillfleet", "bin", "skillfleet");
      const { command } = hookHandler("codex", { launcher, home: m.home });
      expect(command).toBe(
        '"$HOME/.local/state/skillfleet/bin/skillfleet" hook run codex 2>/dev/null || true',
      );
      const marker = join(m.root, "ran");
      const shells = ["sh", "bash", "dash", "zsh", "fish"].filter(
        (shell) => spawnSync(shell, ["-c", "true"]).status === 0,
      );
      expect(shells).toContain("sh");
      for (const shell of shells) {
        const run = (env: NodeJS.ProcessEnv) =>
          spawnSync(shell, ["-c", command], { env: { ...env, HOME: m.home }, encoding: "utf8" });
        rmSync(join(m.home, ".local"), { recursive: true, force: true });
        expect(run({ PATH: "/usr/bin:/bin" }), `${shell}, no launcher`).toMatchObject({
          status: 0,
          stdout: "",
          stderr: "",
        });
        mkdirSync(dirname(launcher), { recursive: true });
        // A launcher whose node is gone, as after a Node.js upgrade.
        writeFileSync(launcher, '#!/bin/sh\nexec "/gone/node" "$@"\n');
        chmodSync(launcher, 0o755);
        expect(run({ PATH: "/usr/bin:/bin" }), `${shell}, no node`).toMatchObject({
          status: 0,
          stdout: "",
          stderr: "",
        });
        writeFileSync(launcher, `#!/bin/sh\necho "$@" > "${marker}"\n`);
        expect(run({ PATH: "/usr/bin:/bin" }).status, shell).toBe(0);
        expect(read(marker).trim(), shell).toBe("hook run codex");
      }
    },
  );

});
