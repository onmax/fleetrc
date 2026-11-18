// What an agent's session hook runs: `skillfleet hook run <agent>`, on every session start and
// every prompt. It starts a sync in the background when the last one is stale, and for Claude Code
// names skills that arrived mid-session. It runs before each prompt, so it loads only small modules
// (entry.ts imports it without cli.ts), makes no network call, prints nothing about the sync, and
// always exits 0.
import { spawn } from "node:child_process";
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { isRecord, readJsonOrNothing } from "./fs.ts";
import { create, syncRunning } from "./lock.ts";
import { paths, stateDir } from "./paths.ts";
import { findOnPath, timerEnv } from "./selfinstall.ts";
import { promptHook } from "./sessions.ts";

export const HOOK_AGENTS = ["claude-code", "codex"] as const;
export type HookAgent = (typeof HOOK_AGENTS)[number];

/** How long after one attempt the hook leaves syncing alone; SKILLFLEET_HOOK_STALE_MS sets it, for tests. */
function staleAfterMs(): number {
  const set = Number(process.env.SKILLFLEET_HOOK_STALE_MS);
  return process.env.SKILLFLEET_HOOK_STALE_MS && set >= 0 ? set : 15 * 60_000;
}

/** A claim older than this was left by a hook that was killed between claiming and letting go. */
const CLAIM_MAX_AGE_MS = 60_000;

/** The timer's log, which syncs started by a hook append to as well. */
const syncLog = () => join(paths.logs(), "skillfleet-sync.log");

/**
 * Whether the last attempt is recent. The stamp holds the time of the attempt, not of a finished
 * sync: a sync that fails (offline, a manifest that does not fetch) is tried again only once it is
 * stale too. A stamp from the future (the clock was set back) counts as stale.
 */
function attemptedRecently(): boolean {
  let at: number;
  try {
    at = Number(readFileSync(paths.hookAttempt(), "utf8"));
  } catch {
    return false;
  }
  return Number.isFinite(at) && Math.abs(Date.now() - at) < staleAfterMs();
}

/**
 * Takes the claim file, so of many hooks that find the stamp stale at once (twenty sessions
 * started together), one goes on. A claim that outlived any hook is broken once.
 */
function claim(file: string): boolean {
  if (create(file, String(process.pid))) return true;
  try {
    if (Date.now() - statSync(file).mtimeMs < CLAIM_MAX_AGE_MS) return false;
    rmSync(file, { force: true });
  } catch {
    return false;
  }
  return create(file, String(process.pid));
}

/**
 * The environment of the sync: what `hook install` saved, the way the timer keeps the environment
 * of the shell that installed it, so the agent's PATH and settings do not reach the manifest's
 * hooks. The ssh agent is the one running now.
 */
function syncEnv(): Record<string, string> {
  const saved = readJsonOrNothing(paths.hookEnv());
  const env: Record<string, string> = {};
  if (isRecord(saved))
    for (const [key, value] of Object.entries(saved))
      if (typeof value === "string") env[key] = value;
  if (!env.PATH) Object.assign(env, timerEnv(findOnPath("git"), process.execPath));
  delete env.SSH_AUTH_SOCK;
  if (process.env.SSH_AUTH_SOCK) env.SSH_AUTH_SOCK = process.env.SSH_AUTH_SOCK;
  // A sync that meets another one exits 0 quietly, and its log lines carry the time.
  env.SKILLFLEET_TIMER = "1";
  return env;
}

/**
 * Starts `skillfleet sync` on its own: it outlives the hook and the agent's wait for it, and writes
 * to the timer's log. It runs the installed copy with this node, as the launcher does; the hook was
 * started through the launcher, so this node is the launcher's.
 */
function startSync(why: string) {
  const installed = join(paths.app(), "cli.mjs");
  const cli = existsSync(installed) ? installed : process.argv[1];
  if (!cli) return;
  mkdirSync(paths.logs(), { recursive: true });
  const log = openSync(syncLog(), "a");
  try {
    writeFileSync(log, `${new Date().toISOString()} ${why}: starting a sync\n`);
    const child = spawn(process.execPath, [cli, "sync"], {
      cwd: stateDir(),
      env: syncEnv(),
      detached: true,
      windowsHide: true,
      stdio: ["ignore", log, log],
    });
    child.on("error", () => {});
    child.unref();
  } finally {
    closeSync(log);
  }
}

/** Starts a sync when none was attempted lately and none is running. */
function syncIfStale(why: string) {
  if (attemptedRecently()) return;
  mkdirSync(stateDir(), { recursive: true });
  const claimFile = `${paths.hookAttempt()}.claim`;
  if (!claim(claimFile)) return;
  try {
    // Another hook may have attempted between the first look and the claim.
    if (attemptedRecently()) return;
    const stamp = `${paths.hookAttempt()}.${process.pid}.tmp`;
    writeFileSync(stamp, String(Date.now()));
    renameSync(stamp, paths.hookAttempt());
    // A running sync brings the skills up to date itself.
    if (!syncRunning()) startSync(why);
  } finally {
    rmSync(claimFile, { force: true });
  }
}

/** Whether this machine has a config.json that names a manifest: `skillfleet init` ran. */
function configured(): boolean {
  if (!existsSync(paths.config())) return false;
  const config = readJsonOrNothing(paths.config());
  return isRecord(config) && typeof config.manifest === "string";
}

/** The skills state.json lists and when each arrived, for the prompt hook. */
function linkedSkills(): Record<string, { addedAt: string }> {
  const state = readJsonOrNothing(paths.state());
  const skills: Record<string, { addedAt: string }> = {};
  if (isRecord(state) && isRecord(state.skills))
    for (const [name, record] of Object.entries(state.skills))
      if (isRecord(record) && typeof record.addedAt === "string")
        skills[name] = { addedAt: record.addedAt };
  return skills;
}

/**
 * `skillfleet hook run <agent>`, and `hook prompt` (Claude Code's UserPromptSubmit). `event` is the
 * hook's event, else the `hook_event_name` the agent passes on stdin. On a machine without
 * skillfleet's config it does nothing and creates nothing.
 */
export function runHook(agent: HookAgent, event?: string) {
  try {
    if (!configured()) return;
    let input = "";
    try {
      input = readFileSync(0, "utf8");
    } catch {}
    let parsed: unknown;
    try {
      parsed = JSON.parse(input);
    } catch {}
    const name =
      event ??
      (isRecord(parsed) && typeof parsed.hook_event_name === "string"
        ? parsed.hook_event_name
        : "a session hook");
    try {
      syncIfStale(`${agent} ${name}`);
    } catch {}
    // Claude Code loads skills linked mid-session; Codex reads them only when a session starts.
    if (agent === "claude-code" && name === "UserPromptSubmit") {
      process.stdout.on("error", () => {});
      const text = promptHook(input, { skills: linkedSkills() });
      if (text) process.stdout.write(text);
    }
  } catch {
    // The agent shows a hook's failure to the user, and the hook is the agent's, not skillfleet's.
  } finally {
    process.exitCode = 0;
  }
}
