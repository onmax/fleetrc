import { delimiter, dirname } from "node:path";

export const TIMER_NAME = "skillfleet-sync";

export interface TimerSpec {
  name: string;
  cron: string;
  timeZone?: string;
  /** Absolute node path, then the installed CLI and its arguments. */
  command: string[];
  env: Record<string, string>;
  logDir: string;
  /** Print the units instead of installing them. */
  dryRun: boolean;
}

export interface InstalledTimer {
  platform: string;
  files: { path: string; content?: string }[];
}

export interface TimerStatus {
  installed: boolean;
  detail: string;
}

/** What skillfleet needs from an OS scheduler (systemd user timers, launchd agents, Task Scheduler). */
export interface Scheduler {
  install(spec: TimerSpec): Promise<InstalledTimer>;
  /** Status and removal get the spec the timer was installed with, as kept in the state folder. */
  status(spec: TimerSpec): Promise<TimerStatus>;
  uninstall(spec: TimerSpec): Promise<void>;
}

export class SchedulerUnavailable extends Error {}

export const BLOCKED_REASON =
  "the OS timer comes from @vite-hub/schedule/os (installOsSchedule), which is not published yet: " +
  "it is being built on the feat/schedule-os branch of vite-hub/vitehub. Until then run `skillfleet sync` " +
  "from cron, a systemd timer or Task Scheduler yourself.";

interface OsScheduleModule {
  installOsSchedule: (
    name: string,
    schedule: unknown,
    options: {
      command: string[];
      scope: "user";
      catchUp: boolean;
      env: Record<string, string>;
      logDir: string;
      dryRun?: boolean;
    },
  ) => Promise<{
    platform: string;
    files: ({ path: string; content?: string } | string)[];
    status(): Promise<unknown>;
    uninstall(): Promise<void>;
  }>;
}

interface ScheduleModule {
  defineSchedule: (definition: {
    cron: string;
    timeZone?: string;
    handler: () => unknown;
  }) => unknown;
}

const hasFunction = (value: unknown, key: string) =>
  typeof value === "object" &&
  value !== null &&
  key in value &&
  typeof (value as Record<string, unknown>)[key] === "function";

/**
 * Loads the scheduler. `@vite-hub/schedule/os` is imported at runtime by name so this build works
 * without it; once it is published it becomes a bundled dependency and this adapter stays the same.
 */
export async function loadScheduler(): Promise<Scheduler> {
  const osSpecifier = "@vite-hub/schedule/os";
  const coreSpecifier = "@vite-hub/schedule";
  let os: unknown;
  let core: unknown;
  try {
    os = await import(osSpecifier);
    core = await import(coreSpecifier);
  } catch {
    throw new SchedulerUnavailable(BLOCKED_REASON);
  }
  if (!hasFunction(os, "installOsSchedule") || !hasFunction(core, "defineSchedule"))
    throw new SchedulerUnavailable(
      `${osSpecifier} does not export installOsSchedule/defineSchedule`,
    );
  const { installOsSchedule } = os as OsScheduleModule;
  const { defineSchedule } = core as ScheduleModule;
  const install = (spec: TimerSpec) =>
    installOsSchedule(
      spec.name,
      defineSchedule({ cron: spec.cron, timeZone: spec.timeZone, handler: () => {} }),
      {
        command: spec.command,
        scope: "user",
        catchUp: true,
        env: spec.env,
        logDir: spec.logDir,
        dryRun: spec.dryRun,
      },
    );
  return {
    async install(spec) {
      const installed = await install(spec);
      return {
        platform: installed.platform,
        files: installed.files.map((file) => (typeof file === "string" ? { path: file } : file)),
      };
    },
    async status(spec) {
      const installed = await install({ ...spec, dryRun: true });
      const status = await installed.status();
      return {
        installed: Boolean(status),
        detail: typeof status === "string" ? status : JSON.stringify(status),
      };
    },
    async uninstall(spec) {
      const installed = await install({ ...spec, dryRun: true });
      await installed.uninstall();
    },
  };
}

/** PATH for scheduled runs: node's folder and git's, ahead of the system defaults. */
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
    "XDG_CONFIG_HOME",
    "XDG_STATE_HOME",
    "CLAUDE_CONFIG_DIR",
    "CODEX_HOME",
    "SSH_AUTH_SOCK",
  ]) {
    const value = process.env[key];
    if (value) env[key] = value;
  }
  return env;
}
