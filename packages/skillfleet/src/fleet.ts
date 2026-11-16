import { exec } from "./exec.ts";
import { isRecord, readJson, writeJson } from "./fs.ts";
import { paths } from "./paths.ts";
import type { Report } from "./report.ts";

export type FleetAction = "status" | "sync" | "upgrade";

export interface HostResult {
  host: string;
  reachable: boolean;
  /** The host's last run, fresh or from the local cache when unreachable. */
  lastRun?: Pick<Report, "finishedAt" | "ok" | "skillfleet" | "host"> & {
    skills: number;
    held: string[];
    errors: string[];
    sources: Record<string, string | undefined>;
  };
  error?: string;
  behind: string[];
}

const STATE = '"${XDG_STATE_HOME:-$HOME/.local/state}/skillfleet"';

/** The POSIX sh script each action runs on a host. */
export function remoteScript(action: FleetAction, version: string): string {
  switch (action) {
    case "status":
      return `cat ${STATE}/last-run.json`;
    case "sync":
      return `f=${STATE}/bin/skillfleet; if [ -x "$f" ]; then "$f" sync --json; else npx -y skillfleet sync --json; fi`;
    case "upgrade":
      return `npx -y skillfleet@${version} self-install && ${STATE}/bin/skillfleet sync --json`;
    default: {
      const exhaustive: never = action;
      return exhaustive;
    }
  }
}

const quote = (script: string) => `'${script.replace(/'/g, `'\\''`)}'`;

/** ssh, or `SKILLFLEET_SSH` (a program, or a .js/.mjs file run with node). */
function sshCommand(): { command: string; prefix: string[] } {
  const custom = process.env.SKILLFLEET_SSH;
  if (!custom) return { command: "ssh", prefix: [] };
  if (/\.(m?js)$/.test(custom)) return { command: process.execPath, prefix: [custom] };
  return { command: custom, prefix: [] };
}

function summarize(raw: unknown): HostResult["lastRun"] {
  if (!isRecord(raw) || typeof raw.finishedAt !== "string") return undefined;
  // A report has skills.total; the cached summary has the number itself.
  const skills =
    typeof raw.skills === "number"
      ? raw.skills
      : isRecord(raw.skills) && typeof raw.skills.total === "number"
        ? raw.skills.total
        : 0;
  const held = Array.isArray(raw.held)
    ? raw.held.flatMap((entry: unknown) =>
        typeof entry === "string"
          ? [entry]
          : isRecord(entry) && typeof entry.source === "string"
            ? [entry.source]
            : [],
      )
    : [];
  const errors = Array.isArray(raw.errors)
    ? raw.errors.filter((error): error is string => typeof error === "string")
    : [];
  const sources: Record<string, string | undefined> = {};
  if (Array.isArray(raw.sources)) {
    for (const source of raw.sources)
      if (isRecord(source) && typeof source.id === "string")
        sources[source.id] = typeof source.to === "string" ? source.to : undefined;
  } else if (isRecord(raw.sources))
    for (const [id, commit] of Object.entries(raw.sources))
      sources[id] = typeof commit === "string" ? commit : undefined;
  return {
    host: typeof raw.host === "string" ? raw.host : "",
    finishedAt: raw.finishedAt,
    ok: raw.ok === true,
    skillfleet: typeof raw.skillfleet === "string" ? raw.skillfleet : "",
    skills,
    held,
    errors,
    sources,
  };
}

function readCache(): Record<string, NonNullable<HostResult["lastRun"]>> {
  const raw = readJson(paths.fleet());
  const cache: Record<string, NonNullable<HostResult["lastRun"]>> = {};
  if (isRecord(raw))
    for (const [host, entry] of Object.entries(raw)) {
      const run = summarize(entry);
      if (run) cache[host] = run;
    }
  return cache;
}

async function runOnHost(host: string, action: FleetAction, version: string, timeoutMs: number) {
  const { command, prefix } = sshCommand();
  const args = [
    ...prefix,
    "-o",
    "BatchMode=yes",
    "-o",
    `ConnectTimeout=${Math.ceil(timeoutMs / 1000)}`,
    host,
    `sh -c ${quote(remoteScript(action, version))}`,
  ];
  const run = await exec(command, args, { timeoutMs });
  if (run.timedOut) return { error: `timed out after ${Math.round(timeoutMs / 1000)}s` };
  if (run.code !== 0)
    return {
      error:
        (run.stderr || run.stdout).trim().split("\n").slice(-3).join(" ") || `exit ${run.code}`,
    };
  try {
    // sync --json prints the report last; status prints the file.
    const text = run.stdout.trim();
    return { report: JSON.parse(text.slice(text.indexOf("{"))) as unknown };
  } catch {
    return { error: "the host answered with something that is not a skillfleet report" };
  }
}

/** Runs an action on every host in parallel; unreachable hosts fall back to their cached last run. */
export async function fleet(
  hosts: readonly string[],
  action: FleetAction,
  version: string,
  timeoutMs = 30_000,
): Promise<HostResult[]> {
  const cache = readCache();
  const results = await Promise.all(
    hosts.map(async (host): Promise<HostResult> => {
      const answer = await runOnHost(host, action, version, timeoutMs);
      const run = "report" in answer ? summarize(answer.report) : undefined;
      if (run) {
        cache[host] = run;
        return { host, reachable: true, lastRun: run, behind: [] };
      }
      return {
        host,
        reachable: false,
        lastRun: cache[host],
        error: answer.error ?? "no report",
        behind: [],
      };
    }),
  );
  writeJson(paths.fleet(), cache);
  markBehind(results);
  return results;
}

/** A host is behind when its last run is over two hours old or a source sits at another commit than on the freshest host. */
export function markBehind(results: HostResult[], now = Date.now()) {
  const freshest = results
    .filter((result) => result.lastRun)
    .sort((a, b) => (a.lastRun!.finishedAt < b.lastRun!.finishedAt ? 1 : -1))[0]?.lastRun;
  for (const result of results) {
    const run = result.lastRun;
    if (!run) {
      result.behind.push("never ran");
      continue;
    }
    if (now - new Date(run.finishedAt).getTime() > 2 * 60 * 60 * 1000)
      result.behind.push(`last run ${age(run.finishedAt, now)} ago`);
    if (freshest && run !== freshest)
      for (const [source, commit] of Object.entries(freshest.sources))
        if (commit && run.sources[source] && run.sources[source] !== commit)
          result.behind.push(`${source} at ${run.sources[source]!.slice(0, 7)}`);
    if (run.held.length) result.behind.push(`held: ${run.held.join(", ")}`);
  }
}

export function age(iso: string, now = Date.now()): string {
  const seconds = Math.max(0, Math.round((now - new Date(iso).getTime()) / 1000));
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.round(seconds / 60)}m`;
  if (seconds < 86400) return `${Math.round(seconds / 3600)}h`;
  return `${Math.round(seconds / 86400)}d`;
}

export function formatFleet(results: readonly HostResult[]): string {
  return results
    .map((result) => {
      const run = result.lastRun;
      const last = run
        ? `last run ${age(run.finishedAt)} ago, ${run.skills} skills${run.ok ? "" : ", with errors"}`
        : "no run recorded";
      const state = result.reachable ? last : `unreachable (${result.error}); ${last}`;
      return `${result.host}: ${state}${result.behind.length ? `; behind: ${result.behind.join("; ")}` : ""}`;
    })
    .join("\n");
}

export interface TailscalePeer {
  host: string;
  dns: string;
  online: boolean;
}

/** Machines on the tailnet, for `fleet add` to suggest. */
export async function tailscalePeers(): Promise<TailscalePeer[]> {
  const run = await exec("tailscale", ["status", "--json"], { timeoutMs: 10_000 });
  if (run.code !== 0) return [];
  const parsed: unknown = JSON.parse(run.stdout);
  if (!isRecord(parsed) || !isRecord(parsed.Peer)) return [];
  return Object.values(parsed.Peer).flatMap((peer) =>
    isRecord(peer) && typeof peer.HostName === "string"
      ? [
          {
            host: peer.HostName,
            dns: typeof peer.DNSName === "string" ? peer.DNSName.replace(/\.$/, "") : "",
            online: peer.Online === true,
          },
        ]
      : [],
  );
}
