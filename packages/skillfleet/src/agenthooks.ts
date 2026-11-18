// `skillfleet hook install` and `hook remove`: skillfleet's entry in Claude Code's settings.json and
// in Codex's hooks.json, which runs `skillfleet hook run <agent>` when a session starts and on each
// prompt. Both files take Claude Code's hook format:
//   { "hooks": { "SessionStart": [{ "hooks": [{ "type": "command", "command": "…" }] }], … } }
// Codex reads $CODEX_HOME/hooks.json, which may hold only "description" and "hooks" (openai/codex,
// codex-rs/hooks/src/engine/discovery.rs and codex-rs/config/src/hook_config.rs).
import {
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { isRecord, JsonFileError, readJson } from "./fs.ts";
import { HOOK_AGENTS, type HookAgent } from "./hook.ts";
import { editJsonText } from "./jsonedit.ts";
import { tildify } from "./paths.ts";
import { launcherPath } from "./selfinstall.ts";

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

/**
 * The launcher's absolute path, so the agent's PATH does not matter. Claude Code runs a hook with
 * sh (Git Bash on Windows) and Codex with $SHELL, or cmd on Windows: double quotes work in each.
 */
export function hookCommand(agent: HookAgent, launcher = launcherPath()): string {
  const path = /^[\w./:+-]+$/.test(launcher)
    ? launcher
    : `"${process.platform === "win32" ? launcher : launcher.replace(/[$`"\\]/g, "\\$&")}"`;
  return `${path} hook run ${agent}`;
}

/** A command skillfleet wrote, by this install or another one: `… skillfleet hook run|prompt`. */
export const isOwnCommand = (command: unknown) =>
  typeof command === "string" &&
  /(?:^|[\\/"'\s])skillfleet(?:\.cmd|\.ps1|\.mjs)?["']?\s+hook\s+(?:run|prompt)\b/.test(command);

type Json = Record<string, unknown>;

/** The handlers of `groups` (an event's matcher groups) that are not skillfleet's. */
function withoutOwn(groups: unknown): { groups: unknown[]; removed: number } {
  if (!Array.isArray(groups)) return { groups: [], removed: 0 };
  let removed = 0;
  const kept = groups.flatMap((group: unknown) => {
    if (!isRecord(group) || !Array.isArray(group.hooks)) return [group];
    const hooks = group.hooks.filter(
      (hook: unknown) => !(isRecord(hook) && isOwnCommand(hook.command)),
    );
    if (hooks.length === group.hooks.length) return [group];
    removed += group.hooks.length - hooks.length;
    // A group that held only skillfleet's handler goes with it.
    return hooks.length === 0 ? [] : [{ ...group, hooks }];
  });
  return { groups: kept, removed };
}

/** The events of `raw` that run skillfleet's hook, and their commands. */
function ownHandlers(raw: unknown): { event: string; command: string }[] {
  if (!isRecord(raw) || !isRecord(raw.hooks)) return [];
  return Object.entries(raw.hooks).flatMap(([event, groups]) =>
    Array.isArray(groups)
      ? groups.flatMap((group: unknown) =>
          isRecord(group) && Array.isArray(group.hooks)
            ? group.hooks.flatMap((hook: unknown) =>
                isRecord(hook) && isOwnCommand(hook.command)
                  ? [{ event, command: hook.command as string }]
                  : [],
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

/** Reads a hooks file: undefined when it does not exist, an error when it is not a JSON object. */
function readHooksFile(file: string): Json | undefined {
  const raw = readJson(file);
  if (raw === undefined) return undefined;
  if (!isRecord(raw)) throw new JsonFileError(`${file} is not a JSON object`);
  return raw;
}

/** Writes `after` over `file`, which held `before`, keeping its layout; through a link to its target. */
function writeHooksFile(file: string, before: Json | undefined, after: Json) {
  const target = existsSync(file) ? realpathSync(file) : file;
  const text = before === undefined ? undefined : readFileSync(target, "utf8");
  const out =
    (text === undefined ? undefined : editJsonText(text, before, after)) ??
    `${JSON.stringify(after, null, 2)}\n`;
  mkdirSync(dirname(target), { recursive: true });
  const temp = `${target}.skillfleet-${process.pid}.tmp`;
  writeFileSync(temp, out);
  renameSync(temp, target);
}

const copy = (value: Json): Json => JSON.parse(JSON.stringify(value)) as Json;

/** Changes the agent's hooks file with `change`; a file that would not change is left alone. */
function changeFile(
  agent: HookAgent,
  change: (raw: Json) => void,
  options: { dryRun: boolean; create: boolean },
): HookChange {
  const file = hookFile(agent);
  let before: Json | undefined;
  try {
    before = readHooksFile(file);
  } catch (error) {
    return { agent, file, changed: false, error: (error as Error).message };
  }
  if (before === undefined && !options.create) return { agent, file, changed: false };
  const after = copy(before ?? {});
  change(after);
  const changed = JSON.stringify(after) !== JSON.stringify(before ?? {});
  if (changed && !options.dryRun) writeHooksFile(file, before, after);
  return { agent, file, changed };
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

/** Adds skillfleet's hook to each agent's file, replacing an older entry of skillfleet's. */
export function installHooks(
  agents: readonly HookAgent[] | undefined,
  options: { dryRun?: boolean; launcher?: string } = {},
): HookChange[] {
  return chosen(agents).map(({ agent, skipped }) => {
    if (skipped) return { agent, file: hookFile(agent), changed: false, skipped };
    const command = hookCommand(agent, options.launcher);
    return changeFile(
      agent,
      (raw) => {
        const hooks: Json = isRecord(raw.hooks) ? raw.hooks : {};
        for (const event of EVENTS) {
          const own = ownHandlers({ hooks: { [event]: hooks[event] } });
          // Already there, once and as this install writes it: unchanged, wherever it is.
          if (own.length === 1 && own[0]!.command === command) continue;
          hooks[event] = [
            ...withoutOwn(hooks[event]).groups,
            { hooks: [{ type: "command", command }] },
          ];
        }
        raw.hooks = hooks;
      },
      { dryRun: options.dryRun ?? false, create: true },
    );
  });
}

/** Takes skillfleet's hook out of each agent's file, leaving every other hook and field. */
export function removeHooks(
  agents: readonly HookAgent[] | undefined,
  options: { dryRun?: boolean } = {},
): HookChange[] {
  return chosen(agents).map(({ agent, skipped }) => {
    if (skipped) return { agent, file: hookFile(agent), changed: false, skipped };
    return changeFile(
      agent,
      (raw) => {
        if (!isRecord(raw.hooks)) return;
        for (const [event, groups] of Object.entries(raw.hooks)) {
          const { groups: kept, removed } = withoutOwn(groups);
          if (removed === 0) continue;
          if (kept.length > 0) raw.hooks[event] = kept;
          else delete raw.hooks[event];
        }
        if (Object.keys(raw.hooks).length === 0) delete raw.hooks;
      },
      { dryRun: options.dryRun ?? false, create: false },
    );
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
