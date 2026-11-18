import { isIP } from "node:net";
import { exec } from "./exec.ts";
import { dict, isRecord, readJsonOrNothing, writeJson } from "./fs.ts";
import { paths } from "./paths.ts";
import type { Report } from "./report.ts";

export type FleetAction = "status" | "sync" | "upgrade" | "init";

export interface HostResult {
  host: string;
  /** The Tailscale tag the host came from, for a host a `tag:` entry expanded to. */
  via?: string;
  /** The host answered over ssh. */
  reachable: boolean;
  /** False when skillfleet could not try the host: ssh is not installed, or the name is not one ssh takes. */
  checked: boolean;
  /** The host's last run, fresh or from the local cache when unreachable. */
  lastRun?: Pick<Report, "finishedAt" | "ok" | "skillfleet" | "host"> & {
    skills: number;
    held: string[];
    errors: string[];
    sources: Record<string, string | undefined>;
  };
  /** `fleet upgrade`: the version the host ran before, when known, and the one it runs now. */
  upgrade?: { from?: string; to: string };
  /** `fleet init`: the host was set up now, or already had this manifest and only synced. */
  setup?: "set up" | "already set up";
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
    "skillfleet is installed there, but the node its launcher and timer run is gone, as after a Node.js upgrade; run `npx skillfleet@latest self-install` on it",
  "no-node":
    "skillfleet is not installed there, and node is not on the PATH ssh commands get; install Node.js 22.12 or newer, then run `npx skillfleet init <manifest>` on it",
  "no-npx":
    "node is there, but npx is not on the PATH ssh commands get; install Node.js 22.12 or newer with npm, then run `skillfleet fleet init` again",
  "init-no-node":
    "node is not on the PATH ssh commands get; install Node.js 22.12 or newer, then run `skillfleet fleet init` again",
  /** `fleet init` says which manifest, from the host's `has` line. */
  "other-manifest": "it has another manifest; pass --force to set it up with this one",
} as const;

/**
 * Told to stderr first, so a timeout can tell a host that answered and was slow from one that never
 * answered.
 */
const ANSWERED = `echo "${NOTE} answered" >&2`;
/** The version the installed launcher runs, told to stderr before `fleet upgrade` replaces it. */
const WAS = `if [ -x "$l" ]; then echo "${NOTE} was $("$l" --version </dev/null 2>/dev/null)" >&2; fi`;
/** The version the launcher runs once `fleet upgrade` installed it, told before the sync that follows, which may fail. */
const NOW = `echo "${NOTE} now $("$l" --version </dev/null 2>/dev/null)" >&2`;

/**
 * Runs `command`, a simple command, so that it stops when the connection drops. Without a tty sshd
 * sends no SIGHUP, and a sync prints nothing until it ends, so it would run on, holding the sync
 * lock, after fleet's timeout killed ssh. fleet writes a line to stdin and holds it open; sshd closes
 * it when the connection goes, and the watcher then kills the command. A stdin that ends before any
 * line, as with `ssh -n`, leaves the command alone. A background list reads /dev/null unless told
 * otherwise, hence fd 3.
 */
const watched = (command: string) =>
  `{ exec 3<&0; ${command} </dev/null 3<&- & p=$!; { read -r _ && { while read -r _; do :; done; kill $p; }; } <&3 >/dev/null 2>&1 & w=$!; exec 3<&-; wait $p; s=$?; kill $w 2>/dev/null; exit $s; }`;

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
/**
 * npx in `x`: the one next to the launcher's node, with that node first on PATH for npx's own
 * `#!/usr/bin/env node`, else the one on PATH.
 */
const NPX = `x=; if [ -n "$n" ] && [ -x "\${n%/*}/npx" ]; then x="\${n%/*}/npx"; PATH="\${n%/*}:$PATH"; export PATH; elif command -v npx >/dev/null 2>&1; then x=npx; fi`;
/**
 * The manifest the host's config.json names, in `m`: empty without one, or without a node to read
 * it, the launcher's or one on PATH.
 */
const CONFIGURED = `c="\${XDG_CONFIG_HOME:-$HOME/.config}/skillfleet/config.json"; k=\${n:-node}; m=; if [ -f "$c" ] && command -v "$k" >/dev/null 2>&1; then m=$("$k" -e 'try{const m=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).manifest;if(typeof m==="string")process.stdout.write(m)}catch{}' "$c" </dev/null 2>/dev/null); fi`;
/** Prints why there is no skillfleet to run. */
const MISSING = `if command -v node >/dev/null 2>&1; then echo "${NOTE} not-installed"; else echo "${NOTE} no-node"; fi`;

/** What `fleet init` sets a host up with. */
export interface InitSetup {
  /** The manifest spec, as this machine's config.json keeps it. */
  spec: string;
  /** Options for the host's `init`: --copy, --no-copy, --timer, --no-hooks, --force. */
  flags: readonly string[];
  /** Set the host up even when its config.json names another manifest. */
  force: boolean;
  /** Whether a manifest spec a host's config.json names is `spec` in another spelling. */
  same: (configured: string) => boolean;
}

/**
 * The npx arguments that run `skillfleet init` on a host: this version from npm, or the package
 * SKILLFLEET_PACKAGE names (a tarball, a URL or a pkg.pr.new preview).
 */
export function initArgs(version: string, { spec, flags }: InitSetup): string[] {
  const pkg = process.env.SKILLFLEET_PACKAGE || `skillfleet@${version}`;
  return ["-y", "--package", pkg, "--", "skillfleet", "init", spec, ...flags];
}

/** `npx <args>` as a person would type it, quoting only the words a shell would split. */
export const commandLine = (args: readonly string[]) =>
  ["npx", ...args.map((arg) => (/^[\w@%+=:,./-]+$/.test(arg) ? arg : quote(arg)))].join(" ");

/**
 * The POSIX sh script each action runs on a host. A dry run asks the host's sync for one too.
 * `init` needs `setup`.
 */
export function remoteScript(
  action: FleetAction,
  version: string,
  { dryRun = false, setup }: { dryRun?: boolean; setup?: InitSetup } = {},
): string {
  switch (action) {
    case "status":
      return `${ANSWERED}; r=${STATE}/last-run.json; if [ -f "$r" ]; then cat "$r"; else ${FIND}; if [ -n "$f" ]; then echo "${NOTE} never-synced"; else ${MISSING}; fi; fi`;
    case "sync":
      return `${ANSWERED}; ${LAUNCHER_NODE}; ${FIND}; if [ -n "$g" ] && [ "$f" = "$l" ]; then echo "${NOTE} node-gone"; elif [ -n "$f" ]; then ${watched(`"$f" sync --json${dryRun ? " --dry-run" : ""}`)}; else ${MISSING}; fi`;
    case "upgrade":
      return `${ANSWERED}; ${LAUNCHER_NODE}; ${WAS}; ${NPX}; if [ -n "$x" ]; then "$x" -y skillfleet@${version} self-install </dev/null && ${NOW} && ${watched('"$l" sync --json')}; elif [ -n "$g" ]; then echo "${NOTE} node-gone"; else echo "${NOTE} no-node"; fi`;
    case "init": {
      if (!setup) throw new Error("remoteScript: init needs a setup");
      const init = ['"$x"', ...initArgs(version, setup).map(quote), "--json"].join(" ");
      // A host with another manifest says which, unless --force sets it up with this one anyway.
      const other = setup.force
        ? ""
        : `elif [ -n "$m" ]; then printf '%s has %s\\n' "${NOTE}" "$m" >&2; echo "${NOTE} other-manifest"; `;
      // A host with this manifest and a skillfleet that runs only syncs.
      return `${ANSWERED}; ${LAUNCHER_NODE}; ${FIND}; ${NPX}; ${CONFIGURED}; if [ -n "$m" ] && [ "$m" = ${quote(setup.spec)} ] && [ -n "$f" ] && [ -z "$g" ]; then echo "${NOTE} already" >&2; ${watched('"$f" sync --json')}; ${other}elif [ -n "$x" ]; then ${watched(init)}; elif [ -n "$n" ] || command -v node >/dev/null 2>&1; then echo "${NOTE} no-npx"; else echo "${NOTE} init-no-node"; fi`;
    }
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
export async function unpublished(
  version: string,
  command: "upgrade" | "init" = "upgrade",
): Promise<string | undefined> {
  const fix =
    command === "upgrade"
      ? "run the upgrade from a release, such as `npx skillfleet@latest fleet upgrade`"
      : "run it from a release, such as `npx skillfleet@latest fleet init`, or name a package hosts can install in SKILLFLEET_PACKAGE";
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

/** `fallback`, or the program `variable` names (a .js/.mjs file runs with node). */
function program(variable: string, fallback: string): { command: string; prefix: string[] } {
  const custom = process.env[variable];
  if (!custom) return { command: fallback, prefix: [] };
  if (/\.(m?js)$/.test(custom)) return { command: process.execPath, prefix: [custom] };
  return { command: custom, prefix: [] };
}

function notInstalled(command: string, fallback: string, variable: string): string {
  return command === fallback
    ? `${fallback} is not installed, or not on PATH`
    : `${command}, which ${variable} names, is not installed or not on PATH`;
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
  const sources = dict<string | undefined>();
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
  const cache = dict<NonNullable<HostResult["lastRun"]>>();
  if (isRecord(raw))
    for (const [host, entry] of Object.entries(raw)) {
      const run = summarize(entry);
      if (run) cache[host] = run;
    }
  return cache;
}

async function runOnHost(
  host: string,
  action: FleetAction,
  version: string,
  timeoutMs: number,
  dryRun: boolean,
  setup?: InitSetup,
) {
  const problem = hostProblem(host);
  if (problem) return { error: problem, reached: false, checked: false };
  const { command, prefix } = program("SKILLFLEET_SSH", "ssh");
  const args = [
    ...prefix,
    "-o",
    "BatchMode=yes",
    "-o",
    `ConnectTimeout=${Math.ceil(timeoutMs / 1000)}`,
    // hostProblem already refuses a leading "-"; this keeps ssh from reading any host as an option.
    "--",
    host,
    `sh -c ${quote(remoteScript(action, version, { dryRun, ...(setup ? { setup } : {}) }))}`,
  ];
  // The report is parsed whole, so it is not cut to the default tail. stdin stays open for `watched`.
  const run = await exec(command, args, {
    timeoutMs,
    maxOutput: 64 * 1024 * 1024,
    input: "fleet\n",
    holdStdin: true,
  });
  if (run.spawnError === "ENOENT")
    return {
      error: notInstalled(command, "ssh", "SKILLFLEET_SSH"),
      reached: false,
      checked: false,
    };
  const answered = new RegExp(`^${NOTE} answered\r?$`, "m").test(run.stderr);
  const told = (what: "was" | "now") =>
    run.stderr.match(new RegExp(`^${NOTE} ${what} (\\d+\\.\\d+\\.\\d+[\\w.+-]*)\r?$`, "m"))?.[1];
  const was = told("was");
  const now = told("now");
  // `fleet init`: the host had this manifest and only synced, or has another one.
  const already = new RegExp(`^${NOTE} already\r?$`, "m").test(run.stderr);
  const has = run.stderr.match(new RegExp(`^${NOTE} has (.*?)\r?$`, "m"))?.[1];
  const stderr = run.stderr.replace(new RegExp(`^${NOTE} .*\r?\n?`, "gm"), "");
  if (run.timedOut) {
    const after = `${Math.round(timeoutMs / 1000)} s`;
    if (!answered) return { error: `no answer within ${after}`, reached: false };
    // ssh is gone, so the host's `watched` sync stops.
    const tail =
      action === "status" ? "but sent no report" : "but its run did not finish, so it was stopped";
    return {
      error: `timed out after ${after} (the host answered, ${tail})`,
      reached: true,
      was,
      now,
    };
  }
  const note = run.stdout.match(new RegExp(`^${NOTE} ([\\w-]+)$`, "m"))?.[1];
  if (note !== undefined && Object.hasOwn(HOST_NOTES, note))
    return { note: note as keyof typeof HOST_NOTES, has };
  // sync --json prints the report last, and exits 1 when a source failed; status prints the file.
  // init --json prints its sync's report under "sync", or {"ok": false, "error"} when it stopped.
  const report = parseReport(run.stdout, action === "init" && !already);
  if (report !== undefined && "error" in report) return { error: report.error, reached: true };
  if (report !== undefined) return { report: report.report, was, now, already };
  if (run.code !== 0)
    return {
      error: (stderr || run.stdout).trim().split("\n").slice(-3).join(" ") || `exit ${run.code}`,
      reached: answered,
      was,
      now,
    };
  return {
    error: "the host answered with something that is not a skillfleet report",
    reached: true,
  };
}

/**
 * The skillfleet report a host printed, or undefined when its output holds none. From `init`, the
 * report of the sync it ran, or the error it stopped with.
 */
function parseReport(
  stdout: string,
  init = false,
): { report: unknown } | { error: string } | undefined {
  const text = stdout.trim();
  const start = text.indexOf("{");
  if (start < 0) return undefined;
  let raw: unknown;
  try {
    raw = JSON.parse(text.slice(start));
  } catch {
    return undefined;
  }
  if (init && isRecord(raw)) {
    if (raw.ok === false && typeof raw.error === "string") return { error: raw.error };
    raw = raw.sync;
  }
  return summarize(raw) ? { report: raw } : undefined;
}

/**
 * Runs an action on every host in parallel; unreachable hosts fall back to their cached last run.
 * A dry run of `sync` runs `sync --dry-run` on each host, and its reports are not cached as runs.
 */
export async function fleet(
  hosts: readonly (string | FleetTarget)[],
  action: FleetAction,
  version: string,
  timeoutMs = 30_000,
  { dryRun = false, setup }: { dryRun?: boolean; setup?: InitSetup } = {},
): Promise<HostResult[]> {
  const cache = readCache();
  const results = await Promise.all(
    hosts.map(async (target): Promise<HostResult> => {
      const { host, via, offline, error } = typeof target === "string" ? { host: target } : target;
      const from = via ? { via } : {};
      // A tag Tailscale could not expand.
      if (error !== undefined)
        return { host, ...from, reachable: false, checked: false, error, behind: [] };
      if (offline)
        return {
          host,
          ...from,
          reachable: false,
          checked: true,
          lastRun: cache[host],
          error: "offline in Tailscale",
          behind: [],
        };
      let answer = await runOnHost(host, action, version, timeoutMs, dryRun, setup);
      let already = "already" in answer && answer.already === true;
      if ("note" in answer && answer.note === "other-manifest" && setup && answer.has) {
        // The same manifest written another way (github:me/skills, me/skills): init writes it this
        // machine's way, and installs what the host lacks.
        if (setup.same(answer.has)) {
          answer = await runOnHost(host, "init", version, timeoutMs, false, {
            ...setup,
            force: true,
          });
          already = false;
        } else
          return {
            host,
            ...from,
            reachable: true,
            checked: true,
            lastRun: cache[host],
            error: `it has the manifest ${answer.has}; pass --force to set it up with ${setup.spec}`,
            behind: [],
          };
      }
      // The host answered, but has no report to give.
      if ("note" in answer && answer.note) {
        const note = HOST_NOTES[answer.note];
        return {
          host,
          ...from,
          reachable: true,
          checked: true,
          lastRun: cache[host],
          ...(note ? { error: note } : {}),
          behind: [],
        };
      }
      const run = "report" in answer ? summarize(answer.report) : undefined;
      const before = cache[host]?.skillfleet;
      // What the host runs once the upgrade went in, told before its sync, which may still fail.
      const to = ("now" in answer ? answer.now : undefined) || run?.skillfleet;
      const upgrade =
        action === "upgrade" && to
          ? {
              upgrade: {
                from: ("was" in answer ? answer.was : undefined) || before || undefined,
                to,
              },
            }
          : {};
      if (run) {
        if (!dryRun) cache[host] = run;
        return {
          host,
          ...from,
          reachable: true,
          checked: true,
          lastRun: run,
          ...upgrade,
          ...(action === "init" ? { setup: already ? "already set up" : "set up" } : {}),
          behind: [],
        };
      }
      return {
        host,
        ...from,
        reachable: answer.reached ?? false,
        checked: answer.checked ?? true,
        lastRun: cache[host],
        ...upgrade,
        error: answer.error ?? "no report",
        behind: [],
      };
    }),
  );
  if (!dryRun) writeJson(paths.fleet(), cache);
  markBehind(results);
  return results;
}

/**
 * A host is behind when its last run is over two hours old or a source sits at another commit than
 * on the freshest host. Only a host that answered can be said to have never run.
 */
export function markBehind(results: HostResult[], now = Date.now()) {
  const freshest = results
    .filter((result) => result.lastRun)
    .sort((a, b) => (a.lastRun!.finishedAt < b.lastRun!.finishedAt ? 1 : -1))[0]?.lastRun;
  for (const result of results) {
    const run = result.lastRun;
    if (!run) {
      if (result.reachable && result.error === undefined) result.behind.push("never ran");
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
      // A tag entry Tailscale could not expand.
      if (result.via === result.host) return `${result.host}: not expanded (${result.error})`;
      const run = result.lastRun;
      const last = run
        ? `last run ${age(run.finishedAt)} ago, ${run.skills} skills${run.ok ? "" : ", with errors"}`
        : "no run recorded";
      const state = !result.checked
        ? `not checked (${result.error}); ${last}`
        : !result.reachable
          ? `unreachable (${result.error}); ${last}`
          : result.error
            ? `${result.error}; ${last}`
            : last;
      return `${result.host}${result.via ? ` (${result.via})` : ""}: ${result.upgrade ? `${upgraded(result.upgrade)}; ` : ""}${result.setup ? `${result.setup}; ` : ""}${state}${result.behind.length ? `; behind: ${result.behind.join("; ")}` : ""}`;
    })
    .join("\n");
}

function upgraded({ from, to }: NonNullable<HostResult["upgrade"]>): string {
  if (!from) return `now on ${to}`;
  return from === to ? `already on ${to}` : `${from} → ${to}`;
}

/** A `tag:<name>` fleet entry: Tailscale's rule for a tag name, a letter and then letters, digits or dashes. */
const TAG = /^tag:[A-Za-z][A-Za-z0-9-]*$/;

export const isTag = (entry: string) => entry.startsWith("tag:");

/** Why `entry`, which starts with `tag:`, is not a Tailscale tag, or undefined when it is one. */
export function tagProblem(entry: string): string | undefined {
  if (TAG.test(entry)) return undefined;
  return `"${entry}" is not a Tailscale tag: write tag: and then a letter followed by letters, digits or dashes, such as "tag:servers"`;
}

/** Why a fleet entry, a host or a `tag:`, cannot be used, or undefined when it can. */
export const fleetEntryProblem = (entry: string) =>
  isTag(entry) ? tagProblem(entry) : hostProblem(entry);

/** A host to run on: named in the fleet, or a machine a `tag:` entry expanded to. */
export interface FleetTarget {
  host: string;
  /** The tag the host came from. */
  via?: string;
  /** Tailscale says the machine is offline, so ssh is not tried. */
  offline?: boolean;
  /** Set on a `tag:` entry that could not be expanded: why. */
  error?: string;
}

export interface TailscalePeer {
  /** The first label of its MagicDNS name, which ssh and `fleet add` take on the tailnet. */
  host: string;
  /** Its MagicDNS name without the trailing dot, or "" when it has none. */
  dns: string;
  ips: string[];
  tags: string[];
  online: boolean;
}

/** What `tailscale status --json` says: the peers, and whether MagicDNS names reach them. */
export interface Tailnet {
  peers: TailscalePeer[];
  /** False when the tailnet has MagicDNS off, so only a peer's Tailscale IP reaches it. */
  magicDNS: boolean;
}

/** The machines on the tailnet other than this one, or why Tailscale could not list them. */
export async function tailnet(): Promise<Tailnet | { error: string }> {
  const { command, prefix } = program("SKILLFLEET_TAILSCALE", "tailscale");
  const run = await exec(command, [...prefix, "status", "--json"], {
    timeoutMs: 10_000,
    maxOutput: 64 * 1024 * 1024,
  });
  if (run.spawnError === "ENOENT")
    return { error: notInstalled(command, "tailscale", "SKILLFLEET_TAILSCALE") };
  if (run.timedOut) return { error: "`tailscale status` did not answer within 10 s" };
  if (run.code !== 0) {
    const said = run.stderr.trim().split("\n")[0] || `exit ${run.code}`;
    return { error: `\`tailscale status\` failed: ${said}` };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(run.stdout);
  } catch {
    return { error: "`tailscale status --json` printed something that is not JSON" };
  }
  if (!isRecord(parsed)) return { error: "`tailscale status --json` printed no status" };
  if (parsed.BackendState === "NeedsLogin" || parsed.BackendState === "NoState")
    return { error: "Tailscale is not logged in; run `tailscale up`" };
  if (parsed.BackendState === "Stopped")
    return { error: "Tailscale is stopped; run `tailscale up`" };
  const self = isRecord(parsed.Self) ? parsed.Self : {};
  const peers = Object.values(isRecord(parsed.Peer) ? parsed.Peer : {}).flatMap((peer) => {
    if (!isRecord(peer)) return [];
    // Tailscale lists this machine under Self, not Peer; a Peer entry that is Self is skipped all the same.
    if (peer.PublicKey !== undefined && peer.PublicKey === self.PublicKey) return [];
    const dns = typeof peer.DNSName === "string" ? peer.DNSName.replace(/\.$/, "") : "";
    // HostName is the machine's own name, which can have spaces ("Maxi's MacBook Pro").
    const host = dns.split(".")[0] || (typeof peer.HostName === "string" ? peer.HostName : "");
    const strings = (value: unknown) =>
      Array.isArray(value)
        ? value.filter((item): item is string => typeof item === "string" && item !== "")
        : [];
    return [
      {
        host,
        dns,
        ips: strings(peer.TailscaleIPs),
        tags: strings(peer.Tags),
        online: peer.Online === true,
      },
    ];
  });
  // Older Tailscale versions leave CurrentTailnet out; MagicDNS is on unless it says otherwise.
  const current = isRecord(parsed.CurrentTailnet) ? parsed.CurrentTailnet : {};
  return { peers, magicDNS: current.MagicDNSEnabled !== false };
}

/** Machines on the tailnet, for `fleet add` to suggest; none when Tailscale can't say. */
export async function tailscalePeers(): Promise<TailscalePeer[]> {
  const answer = await tailnet();
  return "peers" in answer
    ? answer.peers.filter((peer) => peer.host && !hostProblem(peer.host))
    : [];
}

/**
 * Whether a name or address `tailscale status` gave is one to hand ssh: a DNS name or an IP
 * address, nothing ssh reads as an option or a user (`-oProxyCommand=x`, `user@x`).
 */
const tailnetHost = (host: string) =>
  !hostProblem(host) &&
  (isIP(host) !== 0 ||
    /^[A-Za-z0-9](?:[A-Za-z0-9_-]*[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9_-]*[A-Za-z0-9])?)*$/.test(
      host,
    ));

/**
 * A host name or address, normalised for comparing: lower case, no trailing dot, an IPv6 address
 * in its shortest form (`fd7a:0::9` is `fd7a::9`). A short name and a MagicDNS name are one
 * machine only when Tailscale says so: two tailnets can each have a `vps`.
 */
function hostKey(host: string): string {
  const name = host.replace(/\.$/, "").toLowerCase();
  if (name.includes(":")) {
    const [address = "", zone] = name.split("%", 2);
    let canonical = address;
    try {
      canonical = new URL(`http://[${address}]/`).hostname.slice(1, -1);
    } catch {}
    return zone === undefined ? canonical : `${canonical}%${zone}`;
  }
  return name;
}

/**
 * The machine, user and port a fleet entry names: `host`, `user@host`, a bare IP address (IPv6
 * has no port there, so its last group stays), or `ssh://[user@]host[:port]` with the host in
 * brackets for IPv6. A port is kept as written, since `~/.ssh/config` may give the bare name
 * another one.
 */
function sshTarget(entry: string): { machine: string; user: string; port: string } {
  const url = entry.startsWith("ssh://");
  let rest = url ? entry.slice("ssh://".length) : entry;
  const at = rest.lastIndexOf("@");
  const user = at >= 0 ? rest.slice(0, at) : "";
  rest = rest.slice(at + 1);
  let port = "";
  if (url) {
    const parts = rest.match(/^(?:\[([^\]]*)\]|([^:]*))(?::([0-9]+))?$/);
    if (parts) {
      rest = parts[1] ?? parts[2] ?? rest;
      port = parts[3] ?? "";
    }
  }
  return { machine: hostKey(rest), user, port };
}

/**
 * The hosts to run on: the explicit ones as they are, and each `tag:` entry as every tailnet
 * machine with that tag, by MagicDNS name, or its first Tailscale IP when it has none or the
 * tailnet has MagicDNS off. Tailscale is asked once, and only when there is a tag. A machine named
 * twice runs once. Entries are compared by the machine they reach: an IPv6 address in any
 * spelling, a MagicDNS name or its short name, and, when Tailscale was asked, any name or IP of the
 * same peer. Two explicit entries for one machine run once when they also have the same user and
 * port; an explicit host wins over a tag's match for its machine, whatever its user or port, and
 * the first tag wins over later ones. A tag that matches nothing gets a warning, and so does a
 * machine whose name ssh can't take; a tag that can't be expanded comes back as a target with its
 * `error`.
 */
export async function resolveFleet(
  entries: readonly string[],
): Promise<{ targets: FleetTarget[]; warnings: string[] }> {
  const warnings: string[] = [];
  const answer: Tailnet | { error: string } = entries.some(isTag)
    ? await tailnet()
    : { peers: [], magicDNS: true };
  // Every name and IP of a peer leads to the peer's first one, so they compare as one machine.
  const peerOf = new Map<string, string>();
  const names = (peer: TailscalePeer) =>
    [peer.dns, peer.host, ...peer.ips].filter(Boolean).map(hostKey);
  if ("peers" in answer)
    for (const peer of answer.peers) {
      const [id] = names(peer);
      for (const name of names(peer)) if (id && !peerOf.has(name)) peerOf.set(name, id);
    }
  const machine = (name: string) => peerOf.get(hostKey(name)) ?? hostKey(name);
  const explicit = new Set(
    entries.filter((entry) => !isTag(entry)).map((entry) => machine(sshTarget(entry).machine)),
  );
  const seen = new Set<string>();
  const targets: FleetTarget[] = [];
  for (const entry of entries) {
    if (!isTag(entry)) {
      const target = sshTarget(entry);
      const key = [machine(target.machine), target.user, target.port].join("\0");
      if (!seen.has(key)) targets.push({ host: entry });
      seen.add(key);
      continue;
    }
    if ("error" in answer) {
      targets.push({ host: entry, via: entry, error: answer.error });
      continue;
    }
    const tag = entry.toLowerCase();
    const matches = answer.peers.filter((peer) => peer.tags.some((t) => t.toLowerCase() === tag));
    if (matches.length === 0)
      warnings.push(`${entry} matches no machine on your tailnet besides this one`);
    for (const peer of matches) {
      const host = (answer.magicDNS && peer.dns) || peer.ips[0];
      if (!host || !tailnetHost(host)) {
        warnings.push(
          `${entry}: skipped a machine Tailscale calls ${JSON.stringify(peer.dns || peer.host)}, which has no name or address ssh takes`,
        );
        continue;
      }
      const id = machine(host);
      if (explicit.has(id) || seen.has(id)) continue;
      seen.add(id);
      targets.push({ host, via: entry, ...(peer.online ? {} : { offline: true }) });
    }
  }
  return { targets, warnings };
}

/**
 * The entries of `wanted` that `entries`, a manifest's fleet, does not cover yet: a host not named
 * there and, unless it names a user or a port, not on the tailnet under one of its tags; and a tag
 * not there. Tailscale is asked only when it could matter; when it can't say, a tag covers nothing.
 */
export async function notInFleet(
  entries: readonly string[],
  wanted: readonly string[],
): Promise<string[]> {
  const key = (entry: string) => {
    const { machine, user, port } = sshTarget(entry);
    return [machine, user, port].join("\0");
  };
  const named = new Set(entries.filter((entry) => !isTag(entry)).map(key));
  const tags = new Set(entries.filter(isTag).map((tag) => tag.toLowerCase()));
  const answer =
    tags.size > 0 && wanted.some((entry) => !isTag(entry)) ? await tailnet() : { peers: [] };
  const tagged = new Set(
    ("peers" in answer ? answer.peers : [])
      .filter((peer) => peer.tags.some((tag) => tags.has(tag.toLowerCase())))
      .flatMap((peer) => [peer.dns, peer.host, ...peer.ips])
      .filter(Boolean)
      .map(hostKey),
  );
  const missing: string[] = [];
  for (const entry of wanted) {
    const target = sshTarget(entry);
    // A tag's machines are reached as ssh's default user on port 22, so it covers only a bare name.
    const bare = !target.user && !target.port;
    const known = isTag(entry)
      ? tags.has(entry.toLowerCase())
      : named.has(key(entry)) || (bare && tagged.has(target.machine));
    if (!known && !missing.some((each) => key(each) === key(entry))) missing.push(entry);
  }
  return missing;
}
