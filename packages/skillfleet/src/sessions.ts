import { join, basename } from "node:path";
import { exec } from "./exec.ts";
import { isRecord, readJson, writeJson } from "./fs.ts";
import { paths } from "./paths.ts";
import type { State } from "./state.ts";

export interface AgentProcess {
  pid: number;
  agent: "claude" | "codex";
  startedAt: Date;
  command: string;
}

/** Which agent a command line runs, judged by the program and, for node/bun, its script. */
export function agentOf(args: string[]): AgentProcess["agent"] | undefined {
  const name = (token: string | undefined) =>
    basename(token ?? "")
      .replace(/\.(exe|cmd|js|mjs|cjs)$/i, "")
      .toLowerCase();
  const [program, script] = args;
  const candidates = ["node", "bun"].includes(name(program)) ? [script] : [program];
  for (const token of candidates) {
    if (!token) continue;
    if (name(token) === "claude" || token.includes("@anthropic-ai/claude-code")) return "claude";
    if (name(token) === "codex" || token.includes("@openai/codex")) return "codex";
  }
  return undefined;
}

/** Running Claude Code and Codex processes with their start times. */
export async function agentProcesses(): Promise<AgentProcess[]> {
  if (process.platform === "win32") {
    const script =
      "Get-CimInstance Win32_Process | Where-Object { $_.CommandLine } | ForEach-Object { [pscustomobject]@{ pid = $_.ProcessId; start = $_.CreationDate.ToString('o'); cmd = $_.CommandLine } } | ConvertTo-Json -Compress";
    const out = await exec("powershell.exe", ["-NoProfile", "-Command", script], {
      timeoutMs: 20_000,
    });
    if (out.code !== 0 || !out.stdout.trim()) return [];
    const parsed: unknown = JSON.parse(out.stdout);
    const rows = Array.isArray(parsed) ? parsed : [parsed];
    return rows.flatMap((row: unknown) => {
      if (!isRecord(row) || typeof row.cmd !== "string" || typeof row.start !== "string") return [];
      const args = row.cmd.match(/"[^"]*"|\S+/g)?.map((arg) => arg.replace(/^"|"$/g, "")) ?? [];
      const agent = agentOf(args);
      return agent
        ? [{ pid: Number(row.pid), agent, startedAt: new Date(row.start), command: row.cmd }]
        : [];
    });
  }
  const out = await exec("ps", ["-A", "-ww", "-o", "pid=,lstart=,args="], {
    env: { ...process.env, LC_ALL: "C" },
    timeoutMs: 20_000,
  });
  if (out.code !== 0) return [];
  return out.stdout.split("\n").flatMap((line) => {
    // "  123 Mon Nov 16 10:00:00 2026 /usr/bin/claude --resume"
    const match = line
      .trim()
      .match(/^(\d+)\s+\w{3}\s+(\w{3})\s+(\d+)\s+([\d:]+)\s+(\d{4})\s+(.*)$/);
    if (!match) return [];
    const [, pid, month, day, time, year, command] = match;
    const args = command!.split(/\s+/);
    const agent = agentOf(args);
    if (!agent || Number(pid) === process.pid) return [];
    return [
      {
        pid: Number(pid),
        agent,
        startedAt: new Date(`${month} ${day} ${year} ${time}`),
        command: command!,
      },
    ];
  });
}

/** Sessions started before the last skill change, which have not loaded it. */
export async function staleSessions(state: State): Promise<AgentProcess[]> {
  if (!state.lastChange) return [];
  // ps reports start times to the second.
  const changed = new Date(state.lastChange).getTime() - 1000;
  return (await agentProcesses()).filter((proc) => proc.startedAt.getTime() < changed);
}

interface SessionRecord {
  startedAt: string;
  announced: string[];
}

/**
 * `skillfleet hook prompt`, a Claude Code UserPromptSubmit hook: prints the skills that arrived
 * after the session started, once each. Claude Code adds the output to the prompt's context.
 */
export function promptHook(input: string, state: State, now = new Date()): string {
  let sessionId = "unknown";
  try {
    const parsed: unknown = JSON.parse(input);
    if (isRecord(parsed) && typeof parsed.session_id === "string") sessionId = parsed.session_id;
  } catch {}
  const raw = readJson(paths.sessions());
  const sessions: Record<string, SessionRecord> = {};
  if (isRecord(raw))
    for (const [id, record] of Object.entries(raw))
      if (
        isRecord(record) &&
        typeof record.startedAt === "string" &&
        Array.isArray(record.announced)
      )
        sessions[id] = {
          startedAt: record.startedAt,
          announced: record.announced.filter((name): name is string => typeof name === "string"),
        };
  const week = 7 * 24 * 60 * 60 * 1000;
  for (const [id, record] of Object.entries(sessions))
    if (now.getTime() - new Date(record.startedAt).getTime() > week) delete sessions[id];
  const session = sessions[sessionId] ?? { startedAt: now.toISOString(), announced: [] };
  sessions[sessionId] = session;
  const fresh = Object.entries(state.skills)
    .filter(
      ([name, record]) => record.addedAt > session.startedAt && !session.announced.includes(name),
    )
    .map(([name, record]) => ({ name, file: join(record.dir, "SKILL.md") }));
  session.announced.push(...fresh.map((skill) => skill.name));
  writeJson(paths.sessions(), sessions);
  if (fresh.length === 0) return "";
  return [
    `skillfleet: ${fresh.length === 1 ? "a new skill arrived" : `${fresh.length} new skills arrived`} after this session started, so it is not loaded here.`,
    "Read its SKILL.md before using it:",
    ...fresh.map((skill) => `- ${skill.name}: ${skill.file}`),
  ].join("\n");
}
