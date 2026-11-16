import { existsSync, readFileSync, realpathSync } from "node:fs";
import { homedir, userInfo } from "node:os";
import { delimiter, dirname, isAbsolute, join } from "node:path";
import {
  installOsSchedule,
  osScheduleErrors,
  osScheduleStatus,
  type OsScheduleStatus,
  uninstallOsSchedule,
} from "@vite-hub/schedule/os";
import { parseCronExpression } from "cron-schedule";
import { exec } from "./exec.ts";
import { tildify, xdgDir } from "./paths.ts";
import { lastingPathDirs } from "./selfinstall.ts";

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

/** Why `cron` is not a five-field cron the OS timers run, or undefined when it is. */
export function cronProblem(cron: string): string | undefined {
  const example = 'such as "*/30 * * * *" (minute, hour, day of month, month, day of week)';
  if (cron.trim() !== cron) return `"${cron}" has spaces around it`;
  if (cron.split(/\s+/).length !== 5) return `"${cron}" must have five fields, ${example}`;
  try {
    parseCronExpression(cron);
  } catch (error) {
    return `"${cron}" is not a valid cron: ${(error as Error).message.replace(/^Failed to parse [^:]*: /, "")}`;
  }
  return undefined;
}

/**
 * IANA names without a "/", which @vite-hub/schedule takes. Intl also takes offsets such as "+01:00"
 * and lowercase names, which it refuses.
 */
const SLASHLESS_ZONES = new Set(
  "CET CST6CDT Cuba EET EST EST5EDT Egypt Eire Factory GB GB-Eire GMT GMT+0 GMT-0 GMT0 Greenwich HST Hongkong Iceland Iran Israel Jamaica Japan Kwajalein Libya MET MST MST7MDT NZ NZ-CHAT Navajo PRC PST8PDT Poland Portugal ROC ROK Singapore Turkey UCT UTC Universal W-SU WET Zulu".split(
    " ",
  ),
);

/**
 * Why `timeZone` is not a zone the timer takes, or undefined when it is: `"local"`, or an IANA name
 * such as "Europe/Madrid" or "UTC" that this Node.js knows.
 */
export function timeZoneProblem(timeZone: string): string | undefined {
  if (timeZone === "local") return undefined;
  let known = false;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone });
    known = timeZone.includes("/") || SLASHLESS_ZONES.has(timeZone);
  } catch {}
  return known
    ? undefined
    : `"${timeZone}" is not an IANA time zone; use one such as "Europe/Madrid" or "UTC", or "local" for the machine's zone`;
}

const SCHEDULERS: Record<string, string> = {
  linux: "systemd",
  darwin: "launchd",
  win32: "Task Scheduler",
};

const shQuote = (value: string) => `'${value.replace(/'/g, `'\\''`)}'`;

const unxml = (text: string) =>
  text.replace(/&(lt|gt|quot|apos|amp);/g, (_, name: string) =>
    name === "lt" ? "<" : name === "gt" ? ">" : name === "quot" ? '"' : name === "apos" ? "'" : "&",
  );

/**
 * What to tell the user about `resource`, the unit, plist or task that holds the timer's name and
 * that this install did not write. When it is another skillfleet install's (another HOME or
 * XDG_STATE_HOME under the same user), it names that install's state folder and how to remove it.
 */
export function foreignTimer(name: string, resource: string): string {
  const scheduler = SCHEDULERS[process.platform] ?? "the scheduler";
  let text = "";
  try {
    if (isAbsolute(resource)) text = readFileSync(resource, "utf8");
  } catch {}
  // The timer runs <node> <state>/app/cli.mjs sync; systemd doubles "%", a plist escapes XML.
  const plain = unxml(text).replace(/%%/g, "%");
  // An argument in a plist <string> or a quoted ExecStart one may have spaces; a bare one has none.
  const state =
    plain.match(/(?:<string>|")([^<"]+?)[\\/]app[\\/]cli\.mjs(?:<\/string>|")/)?.[1] ??
    plain.match(/([^\s"'<>]+)[\\/]app[\\/]cli\.mjs/)?.[1];
  if (!state)
    return `${scheduler} already has a timer named ${name} that skillfleet did not install: ${tildify(resource)}. Remove it yourself, then run \`skillfleet timer install\` again.`;
  const home =
    plain.match(/<key>HOME<\/key>\s*<string>([^<]*)<\/string>/)?.[1] ??
    plain.match(/^Environment="?HOME=([^"\n]*)"?$/m)?.[1];
  const launcher = join(
    state,
    "bin",
    process.platform === "win32" ? "skillfleet.cmd" : "skillfleet",
  );
  const remove =
    process.platform === "win32"
      ? `run \`${launcher} timer remove\` with the LOCALAPPDATA that install uses`
      : `run \`${home ? `HOME=${shQuote(home)} ` : ""}XDG_STATE_HOME=${shQuote(dirname(state))} ${existsSync(launcher) ? shQuote(launcher) : "npx skillfleet@latest"} timer remove\``;
  return `the ${name} timer belongs to another skillfleet install, whose state folder is ${tildify(state)} (${tildify(resource)}). One user account has one skillfleet timer. To move it to this one, remove it there: ${remove}; then run \`skillfleet timer install\` here again.`;
}

/**
 * The plist launchd loaded the timer from, when it is not this HOME's: macOS keeps one job per label
 * and user, while the plist lives in each HOME. Other systems use one unit or task per user.
 */
export async function foreignTimerResource(name = TIMER_NAME): Promise<string | undefined> {
  if (process.platform !== "darwin" || typeof process.getuid !== "function") return undefined;
  const own = join(homedir(), "Library", "LaunchAgents", `${name}.plist`);
  const real = (path: string) => {
    try {
      return realpathSync(path);
    } catch {
      return path;
    }
  };
  for (const domain of [`gui/${process.getuid()}`, `user/${process.getuid()}`]) {
    const run = await exec("launchctl", ["print", `${domain}/${name}`], { timeoutMs: 10_000 });
    if (run.code !== 0) continue;
    const path = run.stdout.match(/^\tpath = (.+)$/m)?.[1]?.trim();
    if (!path) return `${domain}/${name}`;
    return real(path) === real(own) ? undefined : path;
  }
  return undefined;
}

interface ScheduleError {
  code: string;
  message: string;
  data?: unknown;
}

/** A scheduler failure, said in skillfleet's terms: the manifest's `timer` fields and its commands. */
function explain(error: ScheduleError): string {
  const scheduler = SCHEDULERS[process.platform] ?? "the scheduler";
  const bug = `skillfleet asked ${scheduler} for a timer it refused, which is a bug in skillfleet; please report it at https://github.com/onmax/skillfleet/issues`;
  if (osScheduleErrors.SCHEDULE_OS_COMMAND_FAILED.is(error)) {
    const { command, exitCode, output } = error.data;
    const why = `\`${command}\` failed with exit code ${exitCode}: ${output || "no output"}`;
    if (process.platform === "linux" && /connect to bus|XDG_RUNTIME_DIR/i.test(output))
      return `${why}\n  fix: this login has no systemd user manager; run \`loginctl enable-linger ${userInfo().username}\`, or run \`skillfleet timer install\` from a login session`;
    if (process.platform === "darwin" && /domain/i.test(output))
      return `${why}\n  fix: over SSH, launchd has no session for you until you log in at the Mac's screen; log in there once, then run \`skillfleet timer install\` again`;
    return why;
  }
  if (osScheduleErrors.SCHEDULE_OS_CRON_UNSUPPORTED.is(error)) {
    const { cron, reason } = error.data;
    return `${scheduler} cannot run timer.cron "${cron}" exactly: ${reason}\n  fix: change timer.cron in the manifest to fewer values, such as one weekday list without a month list, or a step that divides the hour or the day evenly`;
  }
  if (osScheduleErrors.SCHEDULE_OS_TIME_ZONE_UNSUPPORTED.is(error)) {
    const { timeZone, machineTimeZone: zone } = error.data;
    return `${scheduler} runs timers in the machine's time zone, ${zone}, where timer.cron gives other times than in timer.timeZone "${timeZone}"\n  fix: remove timer.timeZone from the manifest to run the cron in the machine's zone, or use a cron that gives the same times in both, such as an hourly one`;
  }
  if (osScheduleErrors.SCHEDULE_OS_NAME_TAKEN.is(error))
    return foreignTimer(error.data.name, error.data.resource);
  if (osScheduleErrors.SCHEDULE_OS_PLATFORM_UNSUPPORTED.is(error))
    return `skillfleet's timer runs on Linux with systemd, macOS and Windows, not on ${error.data.platform}; run \`skillfleet sync\` from cron or another scheduler instead`;
  if (osScheduleErrors.SCHEDULE_OS_INVALID_OPTIONS.is(error))
    return `${bug}: ${error.data.problem}`;
  if (osScheduleErrors.SCHEDULE_OS_OPTION_UNSUPPORTED.is(error))
    return `${bug}: ${error.data.reason}`;
  return `${bug}: ${error.code}: ${error.message}`;
}

export class TimerError extends Error {
  constructor(error: ScheduleError) {
    super(explain(error));
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
 * Environment of scheduled runs: PATH with node's folder and git's ahead of the user's own lasting
 * folders, and every variable skillfleet reads to find its config, state and the agents' folders,
 * so the timer works on the same folders as the shell that installed it. Installing from npx and
 * from the launcher gives the same environment, so switching between them leaves the timer alone.
 */
export function timerEnv(git: string | undefined, node: string): Record<string, string> {
  const dirs = [dirname(node), ...(git ? [dirname(git)] : []), ...lastingPathDirs()];
  const env: Record<string, string> = {
    PATH: [...new Set(dirs)].join(delimiter),
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
