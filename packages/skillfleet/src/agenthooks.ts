// `skillfleet hook install` and `hook remove`: skillfleet's entry in Claude Code's settings.json and
// in Codex's hooks.json, which runs `skillfleet hook run <agent>` when a session starts and on each
// prompt. Both files take Claude Code's hook format:
//   { "hooks": { "SessionStart": [{ "hooks": [{ "type": "command", "command": "…" }] }], … } }
// Codex reads $CODEX_HOME/hooks.json, which may hold only "description" and "hooks" (openai/codex,
// codex-rs/hooks/src/engine/discovery.rs and codex-rs/config/src/hook_config.rs). On Windows,
// Claude Code's entry is in exec form, `"command"` and `"args"`, which Claude Code starts with no
// shell (code.claude.com/docs/en/hooks, "Exec form and shell form").
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { isErrno, isRecord, JsonFileError, lstat, readJson } from "./fs.ts";
import { HOOK_AGENTS, type HookAgent } from "./hook.ts";
import { editJsonText } from "./jsonedit.ts";
import { tildify } from "./paths.ts";
import { installedCli, launcherPath, linkedNode, stableNode } from "./selfinstall.ts";

export { HOOK_AGENTS, type HookAgent };

/** The events skillfleet's hook runs on. */
const EVENTS = ["SessionStart", "UserPromptSubmit"] as const;

export const AGENT_NAMES: Record<HookAgent, string> = {
  "claude-code": "Claude Code",
  codex: "Codex",
};

/** The agent's config folder, whose presence means the agent is installed here. */
export function agentHome(agent: HookAgent): string {
  if (agent === "claude-code")
    return process.env.CLAUDE_CONFIG_DIR?.trim() || join(homedir(), ".claude");
  return process.env.CODEX_HOME?.trim() || join(homedir(), ".codex");
}

/** The file that holds the agent's hooks. */
export const hookFile = (agent: HookAgent) =>
  join(agentHome(agent), agent === "claude-code" ? "settings.json" : "hooks.json");

/** A hook entry in an event's matcher group: shell form, or with `args`, exec form. */
export interface HookHandler {
  type: "command";
  command: string;
  args?: string[];
}

/** What the shell-form command runs after the launcher. */
const RUN = (agent: HookAgent) => `hook run ${agent}`;

/** The launcher in double quotes, for sh, bash, zsh and fish: `"`, `$`, `` ` `` and `\` escaped. */
const dq = (text: string) => `"${text.replace(/[$`"\\]/g, "\\$&")}"`;

/**
 * The launcher in a shell command, by its absolute path so the agent's PATH does not matter.
 * Claude Code runs shell form with sh on macOS and Linux, and Codex with `$SHELL -lc` (sh, bash,
 * zsh or fish 3+) or `cmd /C` on Windows.
 *
 * On macOS and Linux a launcher under HOME is written as `"$HOME/…"`, so a settings file shared
 * between machines through dotfiles works on each; and a launcher or node that is gone exits 0
 * quietly instead of failing every prompt: `test -x <launcher> && <launcher> hook run <agent>
 * 2>/dev/null; true`. It reads the same in those four shells. `<launcher> … || true` does not:
 * fish stops at a command it can't find, before `|| true`, says so and exits 127.
 *
 * On Windows cmd expands `%NAME%` even inside quotes, so a path that holds a `%` goes through
 * `%USERPROFILE%`, which cmd expands once, without expanding the result. Known limit: a `%` in a
 * custom XDG_STATE_HOME outside the profile is written as it is, and cmd may expand it.
 */
function shellCommand(
  agent: HookAgent,
  launcher: string,
  platform: NodeJS.Platform,
  profile = process.env.USERPROFILE,
  home = homedir(),
): string {
  if (platform === "win32") {
    const rest =
      profile && launcher.toLowerCase().startsWith(`${profile.toLowerCase()}\\`)
        ? launcher.slice(profile.length)
        : undefined;
    const path =
      launcher.includes("%") && rest !== undefined && !rest.includes("%")
        ? `%USERPROFILE%${rest}`
        : launcher;
    return `"${path}" ${RUN(agent)}`;
  }
  const path = launcher.startsWith(`${home}/`)
    ? `"$HOME${dq(launcher.slice(home.length)).slice(1)}`
    : dq(launcher);
  return `test -x ${path} && ${path} ${RUN(agent)} 2>/dev/null; true`;
}

/**
 * What the agent runs. Claude Code on Windows gets exec form: in shell form it uses Git Bash, or
 * PowerShell without it, which refuses a quoted path followed by arguments; and exec form needs a
 * real executable, not the .cmd launcher. So it runs node, through the node link in bin/ that
 * `self-install` points at each new node, with the installed copy's entry, as the launcher does.
 */
export function hookHandler(
  agent: HookAgent,
  options: {
    platform?: NodeJS.Platform;
    launcher?: string;
    node?: string;
    cli?: string;
    profile?: string;
    home?: string;
  } = {},
): HookHandler {
  const platform = options.platform ?? process.platform;
  if (agent === "claude-code" && platform === "win32")
    return {
      type: "command",
      command: options.node ?? linkedNode(stableNode()),
      args: [options.cli ?? installedCli(), "hook", "run", agent],
    };
  return {
    type: "command",
    command: shellCommand(
      agent,
      options.launcher ?? launcherPath(),
      platform,
      options.profile,
      options.home,
    ),
  };
}

/** A launcher path as skillfleet writes it: double-quoted (escapes allowed) or bare, ending in skillfleet. */
const LAUNCHER = String.raw`(?:"(?:[^"\\]|\\.)*[\\/]skillfleet(?:\.cmd)?"|[^\s"'\`;&|<>()$]*[\\/]skillfleet(?:\.cmd)?)`;

/**
 * The commands skillfleet writes, by this install or another one: `test -x <launcher> &&
 * <launcher> hook run <agent> 2>/dev/null; true`, one launcher (any path, also `"$HOME/…"`) named
 * twice; on Windows the launcher (also `"%USERPROFILE%\…"`) with `hook run <agent>`. And, so they
 * are replaced, what earlier versions wrote: the launcher with `hook run <agent>` alone or with
 * `2>/dev/null || true`, and the documented prompt hook, `[npx] skillfleet hook prompt` or the
 * launcher with `hook prompt`. Nothing else: a user's command that only mentions them is not
 * skillfleet's.
 */
const OWN_COMMAND = new RegExp(
  String.raw`^(?:test -x (${LAUNCHER}) && \1 hook run (?:claude-code|codex) 2>/dev/null; true|${LAUNCHER} hook run (?:claude-code|codex)(?: 2>/dev/null \|\| true)?|(?:npx (?:-y )?)?skillfleet hook prompt|${LAUNCHER} hook prompt)$`,
);

export const isOwnCommand = (command: unknown) =>
  typeof command === "string" && OWN_COMMAND.test(command.trim());

/**
 * An entry skillfleet wrote: a command above, or exec form, node with skillfleet's installed copy
 * (`…/skillfleet/app/cli.mjs`) and `hook run <agent>`.
 */
export function isOwnHandler(hook: unknown): boolean {
  if (!isRecord(hook)) return false;
  if (hook.args === undefined) return isOwnCommand(hook.command);
  const args = hook.args;
  return (
    typeof hook.command === "string" &&
    Array.isArray(args) &&
    args.length === 4 &&
    typeof args[0] === "string" &&
    /[\\/]skillfleet[\\/]app[\\/]cli\.mjs$/i.test(args[0]) &&
    args[1] === "hook" &&
    args[2] === "run" &&
    (args[3] === "claude-code" || args[3] === "codex")
  );
}

const sameHandler = (a: Record<string, unknown>, b: HookHandler) =>
  a.command === b.command && JSON.stringify(a.args) === JSON.stringify(b.args);

type Json = Record<string, unknown>;

/** The handlers of `groups` (an event's matcher groups) that are not skillfleet's. */
function withoutOwn(groups: unknown): { groups: unknown[]; removed: number } {
  if (!Array.isArray(groups)) return { groups: [], removed: 0 };
  let removed = 0;
  const kept = groups.flatMap((group: unknown) => {
    if (!isRecord(group) || !Array.isArray(group.hooks)) return [group];
    const hooks = group.hooks.filter((hook: unknown) => !isOwnHandler(hook));
    if (hooks.length === group.hooks.length) return [group];
    removed += group.hooks.length - hooks.length;
    // A group that held only skillfleet's handler goes with it.
    return hooks.length === 0 ? [] : [{ ...group, hooks }];
  });
  return { groups: kept, removed };
}

/** The events of `raw` that run skillfleet's hook, and its entries. */
function ownHandlers(raw: unknown): { event: string; handler: Record<string, unknown> }[] {
  if (!isRecord(raw) || !isRecord(raw.hooks)) return [];
  return Object.entries(raw.hooks).flatMap(([event, groups]) =>
    Array.isArray(groups)
      ? groups.flatMap((group: unknown) =>
          isRecord(group) && Array.isArray(group.hooks)
            ? group.hooks.flatMap((hook: unknown) =>
                isRecord(hook) && isOwnHandler(hook) ? [{ event, handler: hook }] : [],
              )
            : [],
        )
      : [],
  );
}

export interface HookChange {
  agent: HookAgent;
  file: string;
  /** The file changed, or would in a dry run. */
  changed: boolean;
  /** Not done: the agent's folder is missing, or the file does not read. */
  skipped?: string;
  error?: string;
}

/** The file's text, or undefined when it does not exist. */
function readText(file: string): string | undefined {
  try {
    return readFileSync(file, "utf8");
  } catch (error) {
    if (isErrno(error, "ENOENT")) return undefined;
    throw error;
  }
}

/** A hooks file's text as a JSON object. */
function parseObject(text: string, file: string): Json {
  let raw: unknown;
  try {
    raw = JSON.parse(text.replace(/^﻿/, ""));
  } catch (error) {
    throw new JsonFileError(`${file} is not valid JSON: ${(error as Error).message}`);
  }
  if (!isRecord(raw)) throw new JsonFileError(`${file} is not a JSON object`);
  return raw;
}

const copy = (value: Json): Json => JSON.parse(JSON.stringify(value)) as Json;

/**
 * Changes a hooks file with `change`, keeping its layout and mode, through a link to its target.
 * The edit comes from one read of the file, and is written only if the file still holds what was
 * read: the agent or the user may write it meanwhile. Then it tries once more, and after that
 * reports a conflict and writes nothing. A link to a file that does not exist is left alone. `step`
 * runs before that last check, for tests.
 */
export function editHooksFile(
  file: string,
  change: (raw: Json) => void,
  options: { dryRun?: boolean; create?: boolean; step?: () => void } = {},
): { changed: boolean; error?: string } {
  let target = file;
  if (lstat(file)?.isSymbolicLink())
    try {
      target = realpathSync(file);
    } catch {
      return {
        changed: false,
        error: `${tildify(file)} is a link to ${readlinkSync(file)}, which does not exist; skillfleet left it alone`,
      };
    }
  for (let attempt = 0; attempt < 2; attempt++) {
    const snapshot = readText(target);
    if (snapshot === undefined && !options.create) return { changed: false };
    let before: Json;
    try {
      before = snapshot === undefined ? {} : parseObject(snapshot, file);
    } catch (error) {
      return { changed: false, error: (error as Error).message };
    }
    const after = copy(before);
    change(after);
    if (JSON.stringify(after) === JSON.stringify(before)) return { changed: false };
    if (options.dryRun) return { changed: true };
    const out =
      (snapshot === undefined ? undefined : editJsonText(snapshot, before, after)) ??
      `${JSON.stringify(after, null, 2)}\n`;
    mkdirSync(dirname(target), { recursive: true });
    const temp = `${target}.skillfleet-${process.pid}.tmp`;
    writeFileSync(temp, out);
    if (snapshot !== undefined) chmodSync(temp, statSync(target).mode & 0o7777);
    options.step?.();
    if (readText(target) !== snapshot) {
      rmSync(temp, { force: true });
      continue;
    }
    renameSync(temp, target);
    return { changed: true };
  }
  return {
    changed: false,
    error: `${tildify(file)} changed while skillfleet was editing it, so nothing was written; run the command again`,
  };
}

/** Changes the agent's hooks file with `change`; a file that would not change is left alone. */
function changeFile(
  agent: HookAgent,
  change: (raw: Json) => void,
  options: { dryRun: boolean; create: boolean },
): HookChange {
  const file = hookFile(agent);
  return { agent, file, ...editHooksFile(file, change, options) };
}

/**
 * The agents to act on: those named, else Claude Code and Codex where their folder exists. A named
 * agent whose folder is missing gets one.
 */
function chosen(
  agents: readonly HookAgent[] | undefined,
): { agent: HookAgent; skipped?: string }[] {
  if (agents) return agents.map((agent) => ({ agent }));
  return HOOK_AGENTS.map((agent) =>
    existsSync(agentHome(agent))
      ? { agent }
      : { agent, skipped: `${tildify(agentHome(agent))} does not exist` },
  );
}

/**
 * Puts `handler` in `raw`'s SessionStart and UserPromptSubmit, in place of any entry of
 * skillfleet's; an event that already holds it, once, is left alone.
 */
export function withHook(raw: Json, handler: HookHandler) {
  const hooks: Json = isRecord(raw.hooks) ? raw.hooks : {};
  for (const event of EVENTS) {
    const own = ownHandlers({ hooks: { [event]: hooks[event] } });
    if (own.length === 1 && sameHandler(own[0]!.handler, handler)) continue;
    hooks[event] = [...withoutOwn(hooks[event]).groups, { hooks: [handler] }];
  }
  raw.hooks = hooks;
}

/** Takes every entry of skillfleet's out of `raw`, and the groups and events left empty by it. */
export function withoutHooks(raw: Json) {
  if (!isRecord(raw.hooks)) return;
  for (const [event, groups] of Object.entries(raw.hooks)) {
    const { groups: kept, removed } = withoutOwn(groups);
    if (removed === 0) continue;
    if (kept.length > 0) raw.hooks[event] = kept;
    else delete raw.hooks[event];
  }
  if (Object.keys(raw.hooks).length === 0) delete raw.hooks;
}

/**
 * Adds skillfleet's hook to each agent's file, replacing an older entry of skillfleet's. `node` is
 * the node the launcher runs (Claude Code on Windows runs it through bin/'s node link).
 */
export function installHooks(
  agents: readonly HookAgent[] | undefined,
  options: { dryRun?: boolean; node?: string } = {},
): HookChange[] {
  const node = options.node === undefined ? undefined : linkedNode(options.node);
  return chosen(agents).map(({ agent, skipped }) => {
    if (skipped) return { agent, file: hookFile(agent), changed: false, skipped };
    const handler = hookHandler(agent, node === undefined ? {} : { node });
    return changeFile(agent, (raw) => withHook(raw, handler), {
      dryRun: options.dryRun ?? false,
      create: true,
    });
  });
}

/** Takes skillfleet's hook out of each agent's file, leaving every other hook and field. */
export function removeHooks(
  agents: readonly HookAgent[] | undefined,
  options: { dryRun?: boolean } = {},
): HookChange[] {
  return chosen(agents).map(({ agent, skipped }) => {
    if (skipped) return { agent, file: hookFile(agent), changed: false, skipped };
    return changeFile(agent, withoutHooks, {
      dryRun: options.dryRun ?? false,
      create: false,
    });
  });
}

/** The agents whose hooks file runs skillfleet's hook, with the events it runs on. */
export function installedHooks(): { agent: HookAgent; file: string; events: string[] }[] {
  return HOOK_AGENTS.flatMap((agent) => {
    const file = hookFile(agent);
    let raw: unknown;
    try {
      raw = readJson(file);
    } catch {
      return [];
    }
    const events = [...new Set(ownHandlers(raw).map((handler) => handler.event))];
    return events.length > 0 ? [{ agent, file, events }] : [];
  });
}

/** One line for each agent, for `hook install`, `hook remove` and `init`. */
export function formatHookChanges(
  changes: readonly HookChange[],
  action: "install" | "remove",
  dryRun = false,
): string[] {
  return changes.map((change) => {
    const name = AGENT_NAMES[change.agent];
    const where = tildify(change.file);
    if (change.error) return `${name}: ${change.error}`;
    if (change.skipped) return `${name}: skipped, ${change.skipped}`;
    if (action === "remove")
      return change.changed
        ? `${name}: ${dryRun ? "would remove" : "removed"} skillfleet's hook from ${where}`
        : `${name}: no skillfleet hook in ${where}`;
    if (!change.changed) return `${name}: hook already in ${where}`;
    const done = `${name}: ${dryRun ? "would add" : "added"} skillfleet's hook to ${where}, run on session start and on each prompt`;
    // Codex runs a new hook only once the user trusts it.
    return change.agent === "codex"
      ? `${done}; Codex asks you to trust a new hook: open /hooks in Codex and approve it`
      : done;
  });
}

/** What starts a sync here, in words, for `status` and `doctor`; with neither, how to add one. */
export function describeTrigger(hooks: readonly { agent: HookAgent }[], timer: boolean): string {
  const agents = hooks.map((hook) => AGENT_NAMES[hook.agent]).join(" and ");
  if (hooks.length > 0 && timer) return `the session hooks of ${agents}, and the timer`;
  if (hooks.length > 0) return `the session hooks of ${agents}`;
  if (timer) return "the timer";
  return "nothing starts a sync on this machine; run `skillfleet hook install` where Claude Code or Codex runs, or `skillfleet timer install` on a machine where no agent runs";
}
