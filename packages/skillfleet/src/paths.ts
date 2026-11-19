import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";

export const claudeHome = () => process.env.CLAUDE_CONFIG_DIR?.trim() || join(homedir(), ".claude");

/** `~` and `~/x` become paths in the home directory; relative paths resolve against `base`. */
export function expandPath(path: string, base = process.cwd()): string {
  if (path === "~") return homedir();
  if (path.startsWith("~/") || path.startsWith("~\\")) return join(homedir(), path.slice(2));
  return isAbsolute(path) ? path : resolve(base, path);
}

/** The path with the home directory written as `~`, for messages. */
export function tildify(path: string): string {
  const home = homedir();
  return path === home || path.startsWith(home + "/") || path.startsWith(home + "\\")
    ? `~${path.slice(home.length)}`
    : path;
}

/** An XDG base directory variable, or undefined when it is unset or relative, as the XDG spec says. */
export function xdgDir(name: "XDG_CONFIG_HOME" | "XDG_STATE_HOME"): string | undefined {
  const value = process.env[name];
  return value && isAbsolute(value) ? value : undefined;
}

/** Where `config.json` lives: XDG config, else %APPDATA% on Windows, else ~/.config. */
export function configDir(): string {
  const env = process.env;
  const xdg = xdgDir("XDG_CONFIG_HOME");
  if (xdg) return join(xdg, "skillfleet");
  if (process.platform === "win32" && env.APPDATA) return join(env.APPDATA, "skillfleet");
  return join(homedir(), ".config", "skillfleet");
}

/** Per-machine state: XDG state, else %LOCALAPPDATA% on Windows, else ~/.local/state. */
export function stateDir(): string {
  const env = process.env;
  const xdg = xdgDir("XDG_STATE_HOME");
  if (xdg) return join(xdg, "skillfleet");
  if (process.platform === "win32" && env.LOCALAPPDATA) return join(env.LOCALAPPDATA, "skillfleet");
  return join(homedir(), ".local", "state", "skillfleet");
}

export const paths = {
  config: () => join(configDir(), "config.json"),
  state: () => join(stateDir(), "state.json"),
  lastRun: () => join(stateDir(), "last-run.json"),
  initPending: () => join(stateDir(), "init-pending"),
  fleet: () => join(stateDir(), "fleet.json"),
  /** Claude Code sessions, one record each (sessions.ts). */
  sessions: () => join(stateDir(), "sessions"),
  lock: () => join(stateDir(), "sync.lock"),
  store: (source: string) => join(stateDir(), "store", source),
  cache: () => join(stateDir(), "cache"),
  backup: () => join(stateDir(), "backup"),
  app: () => join(stateDir(), "app"),
  bin: () => join(stateDir(), "bin"),
  logs: () => join(stateDir(), "logs"),
  /** When a session hook last started a sync, or found one running; see hook.ts. */
  hookAttempt: () => join(stateDir(), "hook-attempt"),
  /** When an agent's `hook run` last ran, within the hour; for `doctor`. */
  hookRan: (agent: string) => join(stateDir(), `hook-ran-${agent}`),
  /** The environment a sync started by a session hook runs with, saved by `hook install`. */
  hookEnv: () => join(stateDir(), "hook-env.json"),
};
