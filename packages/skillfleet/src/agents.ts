import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { type AgentInfo, detectAgents, getSupportedAgents } from "skills";
import type { Manifest } from "./manifest.ts";

export interface AgentTarget {
  /** Global skills folder. */
  dir: string;
  /** Agents that read it. */
  agents: string[];
}

/** The folder every universal agent reads, and Codex's own. */
export const sharedSkillsDir = () => resolve(join(homedir(), ".agents", "skills"));

/** A universal agent that also reads ~/.agents/skills, so linking its own folder too shows each skill twice. */
const readsSharedDir = (agent: AgentInfo) =>
  agent.universal && !__SKILLS_OWN_GLOBAL_FOLDER__.includes(agent.id);

/**
 * The global skills folders of the manifest's agents, one entry per folder. `all` means every
 * agent `skills` detects on this machine. Codex reads `~/.agents/skills` (its folder in `skills`)
 * and the deprecated `~/.codex/skills`; skillfleet only writes the first.
 *
 * When ~/.agents/skills is a target, a universal agent (Gemini CLI, OpenCode, Copilot, Cursor, …)
 * reads its skills there and its own folder is left out, as `npx skills add -g` does: Gemini CLI
 * warns about a conflict for each skill it finds in both.
 */
export async function agentTargets(agents: Manifest["agents"]): Promise<AgentTarget[]> {
  const supported = getSupportedAgents();
  let chosen: readonly AgentInfo[];
  if (agents === "all") {
    chosen = (await detectAgents({ cwd: homedir(), config: { telemetry: false } })).agents;
  } else {
    const unknown = agents.filter((id) => !supported.some((agent) => agent.id === id));
    if (unknown.length > 0)
      throw new Error(`unknown agent${unknown.length > 1 ? "s" : ""}: ${unknown.join(", ")}`);
    chosen = supported.filter((agent) => agents.includes(agent.id));
  }
  const shared = sharedSkillsDir();
  const sharing = chosen.some(
    (agent) => agent.globalSkillsDir && resolve(agent.globalSkillsDir) === shared,
  );
  const byDir = new Map<string, AgentTarget>();
  for (const agent of chosen) {
    if (!agent.globalSkillsDir) continue;
    const dir = sharing && readsSharedDir(agent) ? shared : resolve(agent.globalSkillsDir);
    const target = byDir.get(dir) ?? { dir, agents: [] };
    target.agents.push(agent.id);
    byDir.set(dir, target);
  }
  return [...byDir.values()].sort((a, b) => (a.dir < b.dir ? -1 : 1));
}

/**
 * Global skills folders of supported agents that are not targets now. skillfleet may have linked
 * skills there before (an agent that left the manifest, or a universal agent's own folder before
 * ~/.agents/skills replaced it), so sync removes the links it recorded there.
 */
export function formerTargets(targets: readonly AgentTarget[]): string[] {
  const current = new Set(targets.map((target) => target.dir));
  const dirs = new Set<string>();
  for (const agent of getSupportedAgents())
    if (agent.globalSkillsDir) dirs.add(resolve(agent.globalSkillsDir));
  return [...dirs].filter((dir) => !current.has(dir)).sort();
}

/** Codex's deprecated folder, which skillfleet empties during `init` instead of writing to. */
export const codexLegacyDir = () =>
  join(process.env.CODEX_HOME ?? join(homedir(), ".codex"), "skills");
