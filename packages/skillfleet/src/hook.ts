// What an agent's session hook runs: `skillfleet hook run <agent>`, when a session starts. It starts
// a sync in the background when the last attempt is stale. The agent waits for it before the
// session opens, so it loads only small modules (entry.ts imports it without cli.ts, and the
// modules that start a sync load only when one starts), makes no network call, prints nothing,
// and always exits 0.
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
import { basename, dirname, join } from "node:path";
import { isRecord, readJsonOrNothing } from "./fs.ts";
import { paths, stateDir } from "./paths.ts";

export const HOOK_AGENTS = ["claude-code", "codex"] as const;
export type HookAgent = (typeof HOOK_AGENTS)[number];

/** How long after one attempt the hook leaves syncing alone; SKILLFLEET_HOOK_STALE_MS sets it, for tests. */
function staleAfterMs(): number {
  const set = Number(process.env.SKILLFLEET_HOOK_STALE_MS);
  return process.env.SKILLFLEET_HOOK_STALE_MS && set >= 0 ? set : 15 * 60_000;
}

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
 * started together), one goes on. The claim is held the way the sync lock is (lock.ts): it names
 * its holder, a claim whose holder is gone is broken by one breaker at a time, and it is let go
 * only while it is still this hook's. Returns the release, or undefined when another hook holds it.
 */
function claim(file: string, lock: typeof import("./lock.ts")): (() => void) | undefined {
  const { lockText, readLock, takeLock } = lock;
  const mine = lockText("hook");
  try {
    takeLock(file, mine);
  } catch {
    return undefined;
  }
  return () => {
    if (readLock(file)?.text === mine) rmSync(file, { force: true });
  };
}

/**
 * The environment of the sync: what `hook install` saved, the way the timer keeps the environment
 * of the shell that installed it, so the agent's PATH and settings do not reach the manifest's
 * hooks. The ssh agent is the one running now.
 */
function syncEnv({
  findOnPath,
  timerEnv,
}: typeof import("./selfinstall.ts")): Record<string, string> {
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
function startSync(why: string, self: typeof import("./selfinstall.ts")) {
  const installed = join(paths.app(), "cli.mjs");
  const cli = existsSync(installed) ? installed : process.argv[1];
  if (!cli) return;
  mkdirSync(paths.logs(), { recursive: true });
  const log = openSync(syncLog(), "a");
  try {
    writeFileSync(log, `${new Date().toISOString()} ${why}: starting a sync\n`);
    // Loaded here, as the hook seldom starts a sync.
    const { spawn } = process.getBuiltinModule("node:child_process");
    const child = spawn(process.execPath, [cli, "sync"], {
      cwd: stateDir(),
      env: syncEnv(self),
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

/** Notes that this agent's hook ran, at most once an hour, for `doctor`. */
function markRan(agent: HookAgent) {
  const file = paths.hookRan(agent);
  try {
    if (Date.now() - statSync(file).mtimeMs < 60 * 60_000) return;
  } catch {}
  mkdirSync(stateDir(), { recursive: true });
  writeFileSync(file, String(Date.now()));
}

/**
 * Starts a sync when none was attempted lately and none is running. The modules that take the claim
 * and start the sync load only past the first look at the stamp, which nearly every hook stops at.
 */
async function syncIfStale(why: string) {
  if (attemptedRecently()) return;
  const [lock, self] = await Promise.all([import("./lock.ts"), import("./selfinstall.ts")]);
  mkdirSync(stateDir(), { recursive: true });
  const release = claim(`${paths.hookAttempt()}.claim`, lock);
  if (!release) return;
  try {
    // For tests: hold the claim a while, so hooks that started together meet it.
    const hold = Number(process.env.SKILLFLEET_HOOK_CLAIM_HOLD_MS);
    if (hold > 0) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, hold);
    // Another hook may have attempted between the first look and the claim.
    if (attemptedRecently()) return;
    const stamp = `${paths.hookAttempt()}.${process.pid}.tmp`;
    writeFileSync(stamp, String(Date.now()));
    renameSync(stamp, paths.hookAttempt());
    // A running sync brings the skills up to date itself.
    if (!lock.syncRunning()) startSync(why, self);
  } finally {
    release();
  }
}

/** The variables that place skillfleet's config and state folders (paths.ts). */
const PLACES = ["XDG_CONFIG_HOME", "XDG_STATE_HOME", "APPDATA", "LOCALAPPDATA"] as const;

/**
 * Where skillfleet was installed, for an agent whose environment lacks the installing shell's
 * XDG_CONFIG_HOME or XDG_STATE_HOME. The hook runs the installed copy, `<state>/app/cli.mjs`, so
 * its own path names the state folder; the hook-env.json `hook install` saved there has the
 * variables that place the config and state folders, which this process takes before it looks.
 * Run from anywhere else (npx, a checkout), it keeps its own environment.
 */
function adoptInstalledPlaces() {
  const script = process.argv[1];
  if (!script || basename(script) !== "cli.mjs" || basename(dirname(script)) !== "app") return;
  const saved = readJsonOrNothing(join(dirname(dirname(script)), "hook-env.json"));
  if (!isRecord(saved)) return;
  for (const key of PLACES)
    if (typeof saved[key] === "string") process.env[key] = saved[key];
    else delete process.env[key];
}

/** Whether this machine has a config.json that names a manifest: `skillfleet init` ran. */
function configured(): boolean {
  if (!existsSync(paths.config())) return false;
  const config = readJsonOrNothing(paths.config());
  return isRecord(config) && typeof config.manifest === "string";
}

/**
 * `skillfleet hook run <agent>`, with the event the agent passes on stdin as `hook_event_name`. On
 * UserPromptSubmit, where older versions put the hook too, it does nothing: syncs start only with a
 * session. On a machine without skillfleet's config it does nothing and creates nothing.
 */
export async function runHook(agent: HookAgent) {
  try {
    adoptInstalledPlaces();
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
      isRecord(parsed) && typeof parsed.hook_event_name === "string"
        ? parsed.hook_event_name
        : "a session hook";
    if (name === "UserPromptSubmit") return;
    try {
      markRan(agent);
    } catch {}
    try {
      await syncIfStale(`${agent} ${name}`);
    } catch {}
  } catch {
    // The agent shows a hook's failure to the user, and the hook is the agent's, not skillfleet's.
  } finally {
    process.exitCode = 0;
  }
}
