import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { detectAgents, getSupportedAgents } from "skills";
import type { Manifest } from "./manifest.ts";

export interface AgentTarget {
  /** Global skills folder. */
  dir: string;
  /** Agents that read it. */
  agents: string[];
}

/**
 * The global skills folders of the manifest's agents, one entry per folder. `all` means every
 * agent `skills` detects on this machine. Codex reads `~/.agents/skills` (its folder in `skills`)
 * and the deprecated `~/.codex/skills`; skillfleet only writes the first.
 */
export async function agentTargets(agents: Manifest["agents"]): Promise<AgentTarget[]> {
  const supported = getSupportedAgents();
  let chosen;
  if (agents === "all") {
    chosen = (await detectAgents({ cwd: homedir(), config: { telemetry: false } })).agents;
  } else {
    const unknown = agents.filter((id) => !supported.some((agent) => agent.id === id));
    if (unknown.length > 0)
      throw new Error(`unknown agent${unknown.length > 1 ? "s" : ""}: ${unknown.join(", ")}`);
    chosen = supported.filter((agent) => agents.includes(agent.id));
  }
  const byDir = new Map<string, AgentTarget>();
  for (const agent of chosen) {
    if (!agent.globalSkillsDir) continue;
    const dir = resolve(agent.globalSkillsDir);
    const target = byDir.get(dir) ?? { dir, agents: [] };
    target.agents.push(agent.id);
    byDir.set(dir, target);
  }
  return [...byDir.values()].sort((a, b) => (a.dir < b.dir ? -1 : 1));
}

/** Codex's deprecated folder, which skillfleet empties during `init` instead of writing to. */
export const codexLegacyDir = () =>
  join(process.env.CODEX_HOME ?? join(homedir(), ".codex"), "skills");
