import { delimiter, dirname } from "node:path";
import {
  installOsSchedule,
  osScheduleStatus,
  type OsScheduleStatus,
  uninstallOsSchedule,
} from "@vite-hub/schedule/os";
import { xdgDir } from "./paths.ts";

export const TIMER_NAME = "skillfleet-sync";

export interface TimerSpec {
  name: string;
  cron: string;
  /** An IANA name, or `"local"`: the machine's zone, following its clock changes. */
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

/** The machine's time zone now. A timer without `timer.timeZone` runs in it as it changes (`"local"`). */
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
 * Installs or updates the timer: a systemd user timer, a launchd agent, or a Task Scheduler task.
 * Installing the same spec again changes nothing.
 */
export async function installTimer(spec: TimerSpec): Promise<InstalledTimer> {
  const [error, unit] = await installOsSchedule(
    spec.name,
    { cron: spec.cron, timeZone: spec.timeZone },
    { command: spec.command, scope: "user", catchUp: true, env: spec.env, logDir: spec.logDir },
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
  const [error, status] = await osScheduleStatus(name, { scope: "user" });
  if (error) throw new TimerError(error);
  return status;
}

/** Stops and removes the timer and its files. Returns the files it deleted. */
export async function removeTimer(
  name = TIMER_NAME,
): Promise<{ existed: boolean; removed: string[] }> {
  const [error, removal] = await uninstallOsSchedule(name, { scope: "user" });
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
  // __SKILLS_AGENT_ENV__: what `skills` reads to place agents' folders (CODEX_HOME, GROK_HOME, …).
  for (const key of new Set([
    "HOME",
    "USERPROFILE",
    "APPDATA",
    "LOCALAPPDATA",
    "SSH_AUTH_SOCK",
    ...__SKILLS_AGENT_ENV__,
  ])) {
    const value = process.env[key];
    if (value) env[key] = value;
  }
  for (const key of ["XDG_CONFIG_HOME", "XDG_STATE_HOME"] as const) {
    const value = xdgDir(key);
    if (value) env[key] = value;
  }
  return env;
}
