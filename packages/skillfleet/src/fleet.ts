import { exec } from "./exec.ts";
import { isRecord, readJsonOrNothing, writeJson } from "./fs.ts";
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

/** What a host prints, instead of a report, when it cannot give one. */
const NOTE = "skillfleet-fleet:";
const HOST_NOTES = {
  "never-synced": undefined,
  "not-installed": "skillfleet is not installed there; run `npx skillfleet init <manifest>` on it",
  "node-gone":
    "skillfleet is installed there, but the node its launcher and timer run is gone, as after a Node.js upgrade; run `npx skillfleet@latest timer install` on it",
  "no-node":
    "skillfleet is not installed there, and node is not on the PATH ssh commands get; install Node.js 22.12 or newer, then run `npx skillfleet init <manifest>` on it",
} as const;

/** Finds skillfleet on the host: the installed launcher, else a `skillfleet` on PATH. */
const FIND = `f=${STATE}/bin/skillfleet; [ -x "$f" ] || f=$(command -v skillfleet) || f=`;
/**
 * The node the installed launcher runs, in `n` when it is still there. ssh runs commands in a
 * non-interactive shell, without what ~/.zprofile or ~/.bashrc add to PATH (on macOS PATH is
 * /usr/bin:/bin:/usr/sbin:/sbin), so the launcher's node is the one to trust. The launcher's line is
 * `exec "<node>" "<cli>" "$@"`, with `\`, `"`, `$` and a backtick escaped by a backslash. A node
 * the launcher names that is gone, as after a Node.js upgrade, is in `g`.
 */
const LAUNCHER_NODE = `l=${STATE}/bin/skillfleet; n=; g=; if [ -f "$l" ]; then n=$(sed -n 's/^exec "\\([^"]*\\)" .*/\\1/p' "$l" | sed 's/\\\\\\(.\\)/\\1/g'); if [ -n "$n" ] && [ ! -x "$n" ]; then g=$n; n=; fi; fi`;
/** Prints why there is no skillfleet to run. */
const MISSING = `if command -v node >/dev/null 2>&1; then echo "${NOTE} not-installed"; else echo "${NOTE} no-node"; fi`;

/** The POSIX sh script each action runs on a host. */
export function remoteScript(action: FleetAction, version: string): string {
  switch (action) {
    case "status":
      return `r=${STATE}/last-run.json; if [ -f "$r" ]; then cat "$r"; else ${FIND}; if [ -n "$f" ]; then echo "${NOTE} never-synced"; else ${MISSING}; fi; fi`;
    case "sync":
      return `${LAUNCHER_NODE}; ${FIND}; if [ -n "$g" ] && [ "$f" = "$l" ]; then echo "${NOTE} node-gone"; elif [ -n "$f" ]; then "$f" sync --json; else ${MISSING}; fi`;
    case "upgrade":
      // npx next to the launcher's node, with that node first on PATH for npx's own `#!/usr/bin/env node`.
      return `${LAUNCHER_NODE}; x=; if [ -n "$n" ] && [ -x "\${n%/*}/npx" ]; then x="\${n%/*}/npx"; PATH="\${n%/*}:$PATH"; export PATH; elif command -v npx >/dev/null 2>&1; then x=npx; fi; if [ -n "$x" ]; then "$x" -y skillfleet@${version} self-install && "$l" sync --json; else echo "${NOTE} no-node"; fi`;
    default: {
      const exhaustive: never = action;
      return exhaustive;
    }
  }
}

const USER = "[A-Za-z0-9._-]+";
/** A hostname, an ssh_config alias, an IPv4 address, or an IPv6 address with an optional zone. */
const NAME = "(?:[A-Za-z0-9_][A-Za-z0-9._-]*|[0-9A-Fa-f:.]*:[0-9A-Fa-f:.]*(?:%[A-Za-z0-9._-]+)?)";
const BRACKETED = "\\[[0-9A-Fa-f:.]+(?:%[A-Za-z0-9._-]+)?\\]";
const PLAIN_HOST = new RegExp(`^(?:${USER}@)?${NAME}$`);
const SSH_URL = new RegExp(
  `^ssh://(?:${USER}@)?(?:[A-Za-z0-9_][A-Za-z0-9._-]*|${BRACKETED})(?::[0-9]{1,5})?$`,
);

/**
 * Why `host` cannot be handed to ssh, or undefined when it can: `host`, `user@host`, an IP address,
 * an ssh_config alias, or `ssh://user@host:port`. Nothing that ssh would read as an option or a
 * shell would split.
 */
export function hostProblem(host: string): string | undefined {
  const invalid = `"${host}" is not a host name, user@host, an IP address or ssh://user@host:port`;
  if (host.startsWith("ssh://")) return SSH_URL.test(host) ? undefined : invalid;
  if (host.startsWith("-")) return `"${host}" starts with "-", so ssh would read it as an option`;
  if (/^(?:[^@]+@)?[A-Za-z0-9_][A-Za-z0-9._-]*:[0-9]+$/.test(host))
    return `"${host}" has a port; write it as ssh://${host}`;
  return PLAIN_HOST.test(host) ? undefined : invalid;
}

/**
 * Why hosts cannot install this version with npx, or undefined when they can or the registry
 * cannot be asked. 0.0.0 is the version in the repository, which development and preview builds
 * carry; any other version is looked up on the registry npm uses.
 */
export async function unpublished(version: string): Promise<string | undefined> {
  const fix = "run the upgrade from a release, such as `npx skillfleet@latest fleet upgrade`";
  if (version === "0.0.0")
    return `this skillfleet is a development or preview build (0.0.0), which hosts cannot install from npm; ${fix}`;
  const registry = (process.env.npm_config_registry || "https://registry.npmjs.org").replace(
    /\/+$/,
    "",
  );
  try {
    const response = await fetch(`${registry}/skillfleet/${encodeURIComponent(version)}`, {
      signal: AbortSignal.timeout(15_000),
    });
    if (response.status === 404) return `skillfleet ${version} is not on ${registry}; ${fix}`;
  } catch {}
  return undefined;
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
  const raw = readJsonOrNothing(paths.fleet());
  const cache: Record<string, NonNullable<HostResult["lastRun"]>> = {};
  if (isRecord(raw))
    for (const [host, entry] of Object.entries(raw)) {
      const run = summarize(entry);
      if (run) cache[host] = run;
    }
  return cache;
}

async function runOnHost(host: string, action: FleetAction, version: string, timeoutMs: number) {
  const problem = hostProblem(host);
  if (problem) return { error: problem };
  const { command, prefix } = sshCommand();
  const args = [
    ...prefix,
    "-o",
    "BatchMode=yes",
    "-o",
    `ConnectTimeout=${Math.ceil(timeoutMs / 1000)}`,
    // hostProblem already refuses a leading "-"; this keeps ssh from reading any host as an option.
    "--",
    host,
    `sh -c ${quote(remoteScript(action, version))}`,
  ];
  // The report is parsed whole, so it is not cut to the default tail.
  const run = await exec(command, args, { timeoutMs, maxOutput: 64 * 1024 * 1024 });
  if (run.timedOut) return { error: `timed out after ${Math.round(timeoutMs / 1000)}s` };
  const note = run.stdout.match(new RegExp(`^${NOTE} ([\\w-]+)$`, "m"))?.[1];
  if (note !== undefined && Object.hasOwn(HOST_NOTES, note))
    return { note: note as keyof typeof HOST_NOTES };
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
      // The host answered, but has no report to give.
      if ("note" in answer && answer.note) {
        const error = HOST_NOTES[answer.note];
        return {
          host,
          reachable: true,
          lastRun: cache[host],
          ...(error ? { error } : {}),
          behind: [],
        };
      }
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
      const state = !result.reachable
        ? `unreachable (${result.error}); ${last}`
        : result.error
          ? `${result.error}; ${last}`
          : last;
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
  const run = await exec("tailscale", ["status", "--json"], {
    timeoutMs: 10_000,
    maxOutput: 64 * 1024 * 1024,
  });
  if (run.code !== 0) return [];
  const parsed: unknown = JSON.parse(run.stdout);
  if (!isRecord(parsed) || !isRecord(parsed.Peer)) return [];
  // HostName is the machine's own name, which can have spaces ("Maxi's MacBook Pro"); the first
  // label of its MagicDNS name is the one ssh and `fleet add` take.
  return Object.values(parsed.Peer).flatMap((peer) => {
    if (!isRecord(peer)) return [];
    const dns = typeof peer.DNSName === "string" ? peer.DNSName.replace(/\.$/, "") : "";
    const host = dns.split(".")[0] || (typeof peer.HostName === "string" ? peer.HostName : "");
    return host && !hostProblem(host) ? [{ host, dns, online: peer.Online === true }] : [];
  });
}
