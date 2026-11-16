#!/usr/bin/env node
import { existsSync, readFileSync } from "node:fs";
import { userInfo } from "node:os";
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { doctor, formatChecks } from "./doctor.ts";
import { adoptSkill, diffSkill, forkSkill, mergeSkill, UserError } from "./edits.ts";
import { fleet, type FleetAction, formatFleet, hostProblem, tailscalePeers } from "./fleet.ts";
import { isRecord, JsonFileError, readJsonOrNothing } from "./fs.ts";
import { applyPlan, formatPlan, planInit } from "./init.ts";
import {
  defaultSourceId,
  editManifest,
  loadManifest,
  ManifestError,
  readConfig,
} from "./manifest.ts";
import { paths, tildify } from "./paths.ts";
import { exec } from "./exec.ts";
import { formatReport, type Report } from "./report.ts";
import { installedCli, selfInstall } from "./selfinstall.ts";
import { promptHook, staleSessions } from "./sessions.ts";
import { loadState } from "./state.ts";
import { manifestSpec, sync } from "./sync.ts";
import {
  formatTimerStatus,
  installTimer as installOsTimer,
  machineTimeZone,
  removeTimer,
  TIMER_NAME,
  TimerError,
  timerKind,
  type TimerSpec,
  type TimerStatus,
  timerEnv,
  timerStatus,
} from "./timer.ts";
import { version } from "./version.ts";

const USAGE = `Usage: skillfleet [command] [options]

Keeps the same skills in every agent's skills folder, from the sources a manifest lists.

Commands:
  sync [source]            Fetch sources and link skills (the default command)
  init [manifest]          Point this machine at a manifest, migrate the folders, install the timer
  status                   Last run, held and pending updates, edited skills, sessions to restart
  list                     Linked skills and where each comes from
  doctor                   Check node, git access, the timer and duplicate skills
  add <source>             Add a source: owner/repo, a git or index URL, npm:<package>, or a path
  remove <source|skill>    Remove a source, or exclude one skill from its source
  adopt <path>             Move a hand-made skill folder into the personal repository
  fork <skill>             Move a vendored skill into the personal repository to edit it
  diff <skill>             Show local edits, or an update waiting for review
  merge <skill>            Merge an upstream update into an edited skill or a fork
  update <source>          Apply the updates a review-mode source is holding
  timer install|remove|status
  fleet sync|status|upgrade|add [host...]
  hook prompt              Claude Code UserPromptSubmit hook: announce skills newer than the session

Options:
  --offline        Use what is already fetched
  --dry-run        Print what would change and change nothing
  --json           Print the report as JSON
  --copy           Copy skill folders instead of linking them
  --manifest <m>   Use this manifest instead of the configured one
  --timeout <s>    fleet: seconds to wait for each host (default 30)
  --no-timer       init: do not install the timer
  --force          init: go ahead even when skill names would be lost
  -v, --version    Print the version
  -h, --help       Show this help`;

let args;
try {
  args = parseArgs({
    allowPositionals: true,
    options: {
      offline: { type: "boolean" },
      "dry-run": { type: "boolean" },
      json: { type: "boolean" },
      copy: { type: "boolean" },
      manifest: { type: "string" },
      timeout: { type: "string" },
      "no-timer": { type: "boolean" },
      force: { type: "boolean" },
      id: { type: "string" },
      skills: { type: "string" },
      include: { type: "string", multiple: true },
      exclude: { type: "string", multiple: true },
      review: { type: "boolean" },
      version: { type: "boolean", short: "v" },
      help: { type: "boolean", short: "h" },
    },
  });
} catch (error) {
  console.error(`skillfleet: ${(error as Error).message}\n\n${USAGE}`);
  process.exit(2);
}
const { values, positionals } = args;
const [command = "sync", ...rest] = positionals;
const dryRun = values["dry-run"] ?? false;
const json = values.json ?? false;

process.env.DO_NOT_TRACK ??= "1";

function usage(message: string): never {
  console.error(`skillfleet: ${message}\n\n${USAGE}`);
  process.exit(2);
}

function one(name: string): string {
  if (rest.length !== 1) usage(`${command} takes one ${name}`);
  return rest[0]!;
}

function printReport(report: Report) {
  console.log(json ? JSON.stringify(report, null, 2) : formatReport(report));
  return report.ok ? 0 : 1;
}

async function runSync(options: { only?: string; apply?: string } = {}) {
  const report = await sync({
    ...options,
    offline: values.offline,
    dryRun,
    copy: values.copy,
    manifest: values.manifest,
  });
  return printReport(report);
}

/** Absolute path of git, so the timer's PATH has it even when the scheduler's own PATH does not. */
async function gitPath(): Promise<string | undefined> {
  const run = await exec(process.platform === "win32" ? "where" : "which", ["git"], {
    timeoutMs: 5000,
  });
  return run.code === 0 ? run.stdout.split(/\r?\n/)[0]?.trim() || undefined : undefined;
}

async function installTimer(): Promise<{
  code: number;
  lines: string[];
  json: Record<string, unknown>;
}> {
  const loaded = await loadManifest(manifestSpec(values.manifest), { offline: true });
  const installed = dryRun ? undefined : selfInstall();
  const spec: TimerSpec = {
    name: TIMER_NAME,
    cron: loaded.root.timer.cron,
    timeZone: loaded.root.timer.timeZone ?? machineTimeZone(),
    command: [installed?.node ?? process.execPath, installed?.cli ?? installedCli(), "sync"],
    env: timerEnv(await gitPath()),
    logDir: paths.logs(),
  };
  const lines = [
    `timer ${TIMER_NAME}: \`${spec.command.join(" ")}\` on "${spec.cron}" (${spec.timeZone})`,
  ];
  if (dryRun) {
    lines.push(`would install ${timerKind()}`);
    return { code: 0, lines, json: { dryRun: true, ...spec } };
  }
  try {
    const result = await installOsTimer(spec);
    lines.push(
      result.changed
        ? `installed ${timerKind(result.platform)}`
        : `${timerKind(result.platform)}: already installed, unchanged`,
      ...result.files.map((file) => `  ${tildify(file)}`),
    );
    if (result.linger === false)
      lines.push(
        `systemd linger is off, so the timer runs only while you are logged in; run \`loginctl enable-linger ${userInfo().username}\``,
      );
    return { code: 0, lines, json: { ...spec, ...result } };
  } catch (error) {
    if (!(error instanceof TimerError)) throw error;
    lines.push(`the timer was not installed: ${error.message}`);
    return { code: 1, lines, json: { ...spec, error: error.message } };
  }
}

/** The OS's view of the timer, or why it could not be read. */
async function readTimer(): Promise<TimerStatus | TimerError> {
  try {
    return await timerStatus();
  } catch (error) {
    if (error instanceof TimerError) return error;
    throw error;
  }
}

async function timer(action: string | undefined) {
  switch (action) {
    case "install": {
      const result = await installTimer();
      console.log(json ? JSON.stringify(result.json, null, 2) : result.lines.join("\n"));
      return result.code;
    }
    case "status": {
      const status = await readTimer();
      if (status instanceof TimerError) {
        console.error(`skillfleet: ${status.message}`);
        return 1;
      }
      console.log(
        json ? JSON.stringify(status, null, 2) : `${TIMER_NAME}: ${formatTimerStatus(status)}`,
      );
      return status.installed ? 0 : 1;
    }
    case "remove": {
      const removal = await removeTimer();
      if (json) console.log(JSON.stringify(removal, null, 2));
      else if (!removal.existed) console.log("no timer installed");
      else {
        console.log(`removed ${TIMER_NAME}`);
        for (const file of removal.removed) console.log(`  ${tildify(file)}`);
      }
      return 0;
    }
    default:
      return usage("timer takes install, remove or status");
  }
}

function lastRun(): Report | undefined {
  const raw = readJsonOrNothing(paths.lastRun());
  return isRecord(raw) && raw.version === 1 ? (raw as unknown as Report) : undefined;
}

async function status() {
  const report = lastRun();
  const state = loadState();
  const stale = await staleSessions(state);
  const config = readConfig();
  const timerState = await readTimer();
  if (json) {
    console.log(
      JSON.stringify(
        {
          manifest: config?.manifest,
          lastRun: report,
          lastChange: state.lastChange,
          staleSessions: stale,
          timer: timerState instanceof TimerError ? { error: timerState.message } : timerState,
        },
        null,
        2,
      ),
    );
    return 0;
  }
  console.log(`manifest: ${config?.manifest ?? "none; run `skillfleet init <manifest>`"}`);
  if (!report) console.log("no sync has run on this machine yet");
  else {
    console.log(`last run: ${report.finishedAt}${report.ok ? "" : " (with errors)"}`);
    console.log(formatReport(report));
  }
  console.log(
    `timer: ${timerState instanceof TimerError ? `unknown (${timerState.message.split("\n")[0]})` : formatTimerStatus(timerState)}`,
  );
  for (const proc of stale)
    console.log(
      `restart: ${proc.agent} (pid ${proc.pid}) started ${proc.startedAt.toISOString()}, before the last skill change at ${state.lastChange}`,
    );
  return 0;
}

function list() {
  const state = loadState();
  const names = Object.keys(state.skills).sort();
  if (json) console.log(JSON.stringify(state.skills, null, 2));
  else
    for (const name of names)
      console.log(`${name}  ${state.skills[name]!.source}  ${tildify(state.skills[name]!.dir)}`);
  return 0;
}

/** What `add` writes for a source string. */
function sourceFromSpec(spec: string): Record<string, unknown> {
  if (spec.startsWith("npm:")) return { npm: spec.slice(4) };
  // A bare repository or a URL that names one.
  if (
    /\.git[\\/]?$/.test(spec) ||
    spec.startsWith("git@") ||
    spec.startsWith("github:") ||
    spec.startsWith("gitlab:")
  )
    return { git: spec };
  if (
    spec.startsWith(".") ||
    spec.startsWith("/") ||
    spec.startsWith("~") ||
    /^[A-Za-z]:[\\/]/.test(spec) ||
    existsSync(spec)
  )
    return { local: spec.startsWith("~") ? spec : resolve(spec) };
  if (
    /^https?:\/\//.test(spec) &&
    !spec.endsWith(".git") &&
    !/^https?:\/\/(github\.com|gitlab\.com)\//.test(spec)
  )
    return { index: spec };
  return { git: spec };
}

async function add() {
  const spec = one("source");
  const entry: Record<string, unknown> = sourceFromSpec(spec);
  entry.id = values.id ?? defaultSourceId(entry);
  if (values.skills) entry.skills = values.skills;
  if (values.include) entry.include = values.include;
  if (values.exclude) entry.exclude = values.exclude;
  if (values.review) entry.update = "review";
  const file = (await loadManifest(manifestSpec(values.manifest), { offline: true })).root.file;
  editManifest(file, (raw) => {
    const sources = Array.isArray(raw.sources) ? raw.sources : [];
    raw.sources = [...sources, { id: entry.id, ...entry }];
  });
  console.log(`added ${String(entry.id)} to ${tildify(file)}`);
  return runSync();
}

async function remove() {
  const name = one("source or skill");
  const loaded = await loadManifest(manifestSpec(values.manifest), { offline: true });
  const file = loaded.root.file;
  if (loaded.root.sources.some((source) => source.id === name)) {
    editManifest(file, (raw) => {
      raw.sources = (Array.isArray(raw.sources) ? raw.sources : []).filter(
        (source: unknown) => !isRecord(source) || (source.id ?? defaultSourceId(source)) !== name,
      );
    });
    console.log(`removed source ${name} from ${tildify(file)}`);
    return runSync();
  }
  const owner = loadState().skills[name]?.source;
  const source = loaded.sources.find((candidate) => candidate.id === owner);
  if (!source) throw new UserError(`no source or linked skill named "${name}"`);
  if (source.origin !== file)
    throw new UserError(
      `${name} comes from ${source.id} in ${tildify(source.origin)}; exclude it there`,
    );
  editManifest(file, (raw) => {
    for (const entry of Array.isArray(raw.sources) ? raw.sources : [])
      if (isRecord(entry) && (entry.id ?? defaultSourceId(entry)) === source.id)
        entry.exclude = [
          ...new Set([...(Array.isArray(entry.exclude) ? entry.exclude : []), name]),
        ];
  });
  console.log(`excluded ${name} from ${source.id}`);
  return runSync();
}

async function init() {
  if (rest.length > 1) usage("init takes one manifest");
  const spec = rest[0] ?? values.manifest ?? readConfig()?.manifest;
  if (!spec)
    usage(
      "init needs a manifest: a path, or <repo>//<file> such as github:org/agents//skills.json",
    );
  const plan = await planInit(spec, { offline: values.offline, dryRun });
  if (json && dryRun) {
    console.log(JSON.stringify(plan, null, 2));
    return plan.lost.length > 0 ? 1 : 0;
  }
  console.log(formatPlan(plan));
  if (dryRun) return plan.lost.length > 0 ? 1 : 0;
  if (plan.lost.length > 0 && !values.force) {
    console.error(
      `skillfleet: init would lose ${plan.lost.join(", ")}; add a source for them, or pass --force`,
    );
    return 1;
  }
  for (const line of applyPlan(plan)) console.log(`  ${line}`);
  const code = await runSync();
  if (values["no-timer"]) return code;
  const timerResult = await installTimer();
  console.log(timerResult.lines.join("\n"));
  return code || timerResult.code;
}

async function fleetCommand(action: string | undefined) {
  const loaded = await loadManifest(manifestSpec(values.manifest), { offline: true });
  if (action === "add") {
    const hosts = rest.slice(1);
    if (hosts.length === 0) {
      const peers = await tailscalePeers();
      const known = new Set(loaded.root.fleet);
      const suggestions = peers.filter((peer) => !known.has(peer.host));
      if (suggestions.length === 0)
        console.log("no tailnet machines to suggest; name hosts: skillfleet fleet add <host>...");
      else {
        console.log(
          "machines on your tailnet; add the ones you want with `skillfleet fleet add <host>...`:",
        );
        for (const peer of suggestions)
          console.log(
            `  ${peer.host}${peer.online ? "" : " (offline)"}${peer.dns ? `  ${peer.dns}` : ""}`,
          );
      }
      return 0;
    }
    const problems = hosts.flatMap((host) => hostProblem(host) ?? []);
    if (problems.length > 0) throw new UserError(problems.join("\n"));
    editManifest(loaded.root.file, (raw) => {
      raw.fleet = [...new Set([...(Array.isArray(raw.fleet) ? raw.fleet : []), ...hosts])];
    });
    console.log(`added ${hosts.join(", ")} to the fleet in ${tildify(loaded.root.file)}`);
    return 0;
  }
  if (action !== "sync" && action !== "status" && action !== "upgrade")
    return usage("fleet takes sync, status, upgrade or add");
  const hosts = rest.length > 1 ? rest.slice(1) : loaded.root.fleet;
  if (hosts.length === 0) usage("the manifest has no fleet; add hosts with `skillfleet fleet add`");
  const timeout = values.timeout ? Number(values.timeout) * 1000 : 30_000;
  if (!Number.isFinite(timeout) || timeout <= 0) usage("--timeout takes seconds");
  const results = await fleet(hosts, action satisfies FleetAction, version, timeout);
  console.log(json ? JSON.stringify(results, null, 2) : formatFleet(results));
  return results.every((result) => result.reachable) ? 0 : 1;
}

async function main(): Promise<number> {
  if (values.version) {
    console.log(version);
    return 0;
  }
  if (values.help) {
    console.log(USAGE);
    return 0;
  }
  switch (command) {
    case "sync":
      if (rest.length > 1) usage("sync takes at most one source");
      return runSync({ only: rest[0] });
    case "update": {
      const id = one("source");
      return runSync({ only: id, apply: id });
    }
    case "init":
      return init();
    case "status":
      return status();
    case "list":
      return list();
    case "doctor": {
      const checks = await doctor();
      console.log(json ? JSON.stringify(checks, null, 2) : formatChecks(checks));
      return checks.every((check) => check.ok) ? 0 : 1;
    }
    case "add":
      return add();
    case "remove":
      return remove();
    case "adopt": {
      const result = await adoptSkill(resolve(one("path")));
      console.log(`moved ${result.name} to ${tildify(result.to)}; commit it there`);
      return runSync();
    }
    case "fork": {
      const result = await forkSkill(one("skill"));
      console.log(`forked into ${tildify(result.to)}; commit it there`);
      return runSync();
    }
    case "diff": {
      const out = await diffSkill(one("skill"));
      process.stdout.write(out || "no differences\n");
      return 0;
    }
    case "merge": {
      const result = await mergeSkill(one("skill"));
      if (result.merged.length) console.log(`merged: ${result.merged.join(", ")}`);
      if (result.conflicts.length) {
        console.log(
          `conflicts: ${result.conflicts.join(", ")} in ${tildify(result.into)}; resolve the markers by hand`,
        );
        return 1;
      }
      if (!result.merged.length) console.log("nothing to merge");
      return 0;
    }
    case "timer":
      return timer(rest[0]);
    case "fleet":
      return fleetCommand(rest[0]);
    case "hook":
      if (rest[0] !== "prompt") usage("hook takes prompt");
      process.stdout.write(promptHook(readFileSync(0, "utf8"), loadState()));
      return 0;
    case "self-install": {
      const result = selfInstall();
      console.log(`installed ${tildify(result.launcher)} (node ${result.node})`);
      return 0;
    }
    default:
      return usage(`unknown command "${command}"`);
  }
}

main().then(
  (code) => {
    process.exitCode = code;
  },
  (error: unknown) => {
    if (
      error instanceof UserError ||
      error instanceof ManifestError ||
      error instanceof JsonFileError
    )
      console.error(`skillfleet: ${error.message}`);
    else console.error(error);
    process.exitCode = 1;
  },
);
