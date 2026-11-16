import { realpathSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import {
  installOsSchedule,
  osScheduleStatus,
  type OsScheduleStatus,
  uninstallOsSchedule,
} from "@vite-hub/schedule/os";
import { exec } from "./exec.ts";
import { xdgDir } from "./paths.ts";

export const TIMER_NAME = "skillfleet-sync";

export interface TimerSpec {
  name: string;
  cron: string;
  timeZone: string;
  /** Absolute node path, then the installed CLI and its arguments. */
  command: [string, ...string[]];
  env: Record<string, string>;
  logDir: string;
}

export interface InstalledTimer {
  platform: string;
  /** Unit files, plist or task wrapper, and the log file. */
  files: string[];
  /** `false` when the same timer was already installed and nothing changed. */
  changed: boolean;
  /** Linux: whether systemd lingering is on, so the timer runs while the user is logged out. */
  linger?: boolean;
}

export type TimerStatus = OsScheduleStatus;

/** A scheduler failure, with the fix @vite-hub/schedule suggests. */
export class TimerError extends Error {
  constructor(error: { code: string; message: string; fix?: string }) {
    super(`${error.code}: ${error.message}${error.fix ? `\n  fix: ${error.fix}` : ""}`);
  }
}

/** The machine's time zone, which the timer uses when the manifest names none. */
export const machineTimeZone = () => Intl.DateTimeFormat().resolvedOptions().timeZone;

/** What each OS installs, for `timer install --dry-run`. */
export const timerKind = (platform: string = process.platform) =>
  platform === "linux"
    ? "a systemd user timer"
    : platform === "darwin"
      ? "a launchd agent"
      : platform === "win32"
        ? "a Task Scheduler task"
        : `nothing: ${platform} has no supported scheduler`;

/**
 * The folder the systemd user manager reads user units from, as the manager sees it.
 * @vite-hub/schedule writes units to `$XDG_CONFIG_HOME/systemd/user` (else `~/.config/...`) of
 * the installing process. When that shell's HOME or XDG_CONFIG_HOME differs from the manager's,
 * as with an XDG_CONFIG_HOME set only in a shell profile, or a throwaway HOME, the unit lands
 * where the manager never looks and `systemctl --user enable` fails. The manager's first unit path
 * is `<config home>/systemd/user.control`.
 */
async function systemdConfigHome(): Promise<string | undefined> {
  const uid = process.getuid?.();
  const env =
    process.env.XDG_RUNTIME_DIR || uid === undefined
      ? process.env
      : { ...process.env, XDG_RUNTIME_DIR: `/run/user/${uid}` };
  const run = await exec("systemctl", ["--user", "show", "-p", "UnitPath", "--value"], {
    env,
    timeoutMs: 10_000,
  });
  if (run.code !== 0) return undefined;
  const control = run.stdout
    .trim()
    .split(/\s+/)
    .find((path) => path.endsWith("/systemd/user.control") && !path.startsWith("/run/"));
  return control ? dirname(dirname(control)) : undefined;
}

/** Runs `operation` with one environment variable changed, and puts it back after. */
async function withEnv<T>(key: string, value: string, operation: () => Promise<T>): Promise<T> {
  const saved = process.env[key];
  if (saved === value) return operation();
  process.env[key] = value;
  try {
    return await operation();
  } finally {
    if (saved === undefined) delete process.env[key];
    else process.env[key] = saved;
  }
}

/**
 * Runs a @vite-hub/schedule operation where it finds the timer the OS knows.
 * - Linux: XDG_CONFIG_HOME points where the systemd user manager reads units.
 * - macOS: HOME is a real path. launchd reports the real path of the plist it loaded, and
 *   @vite-hub/schedule treats a job loaded from another path than `$HOME/Library/LaunchAgents`
 *   as someone else's: with HOME under a symlink, such as /var/folders (/private/var/folders),
 *   status says "not installed", remove leaves the job loaded, and a second install fails with
 *   SCHEDULE_OS_NAME_TAKEN.
 */
async function inSchedulerEnv<T>(operation: () => Promise<T>): Promise<T> {
  if (process.platform === "darwin") return withEnv("HOME", realpathSync(homedir()), operation);
  if (process.platform !== "linux") return operation();
  // A relative XDG_CONFIG_HOME is ignored, as the XDG spec says, so units never land under the cwd.
  const ours = xdgDir("XDG_CONFIG_HOME") ?? join(homedir(), ".config");
  return withEnv("XDG_CONFIG_HOME", (await systemdConfigHome()) ?? ours, operation);
}

/**
 * Installs or updates the timer: a systemd user timer, a launchd agent, or a Task Scheduler task.
 * Installing the same spec again changes nothing.
 */
export async function installTimer(spec: TimerSpec): Promise<InstalledTimer> {
  const [error, unit] = await inSchedulerEnv(() =>
    installOsSchedule(
      spec.name,
      { cron: spec.cron, timeZone: spec.timeZone },
      { command: spec.command, scope: "user", catchUp: true, env: spec.env, logDir: spec.logDir },
    ),
  );
  if (error) throw new TimerError(error);
  return {
    platform: unit.platform,
    files: unit.files,
    changed: unit.changed,
    ...(unit.linger === undefined ? {} : { linger: unit.linger }),
  };
}

export async function timerStatus(name = TIMER_NAME): Promise<TimerStatus> {
  const [error, status] = await inSchedulerEnv(() => osScheduleStatus(name, { scope: "user" }));
  if (error) throw new TimerError(error);
  return status;
}

/** Stops and removes the timer and its files. Returns the files it deleted. */
export async function removeTimer(
  name = TIMER_NAME,
): Promise<{ existed: boolean; removed: string[] }> {
  const [error, removal] = await inSchedulerEnv(() => uninstallOsSchedule(name, { scope: "user" }));
  if (error) throw new TimerError(error);
  return { existed: removal.existed, removed: removal.removed };
}

/** One line about the timer for `status` and `timer status`. */
export function formatTimerStatus(status: TimerStatus): string {
  if (!status.installed) return "not installed; run `skillfleet timer install`";
  const parts = [`installed (${timerKind(status.platform)})`];
  if (status.running) parts.push("running now");
  if (status.lastRunAt) parts.push(`last run ${status.lastRunAt.toISOString()}`);
  if (status.lastExitCode !== undefined) parts.push(`last exit code ${status.lastExitCode}`);
  if (status.nextRunAt) parts.push(`next run ${status.nextRunAt.toISOString()}`);
  if (status.linger === false) parts.push("linger off: it stops when you log out");
  if (status.logFile) parts.push(`log ${status.logFile}`);
  return parts.join(", ");
}

/**
 * Environment of scheduled runs: PATH with node's folder and git's ahead of the system defaults,
 * and every variable skillfleet reads to find its config, state and the agents' folders, so the
 * timer works on the same folders as the shell that installed it.
 */
export function timerEnv(git: string | undefined): Record<string, string> {
  const dirs = [
    dirname(process.execPath),
    git ? dirname(git) : undefined,
    ...(process.env.PATH ?? "").split(delimiter),
  ];
  const env: Record<string, string> = {
    PATH: [...new Set(dirs.filter((dir): dir is string => Boolean(dir)))].join(delimiter),
    DO_NOT_TRACK: "1",
  };
  for (const key of [
    "HOME",
    "USERPROFILE",
    "APPDATA",
    "LOCALAPPDATA",
    "CLAUDE_CONFIG_DIR",
    "CODEX_HOME",
    "SSH_AUTH_SOCK",
  ]) {
    const value = process.env[key];
    if (value) env[key] = value;
  }
  for (const key of ["XDG_CONFIG_HOME", "XDG_STATE_HOME"] as const) {
    const value = xdgDir(key);
    if (value) env[key] = value;
  }
  return env;
}
