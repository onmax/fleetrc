import { existsSync, readFileSync } from "node:fs";
import { userInfo } from "node:os";
import { dirname, resolve } from "node:path";
import { parseArgs } from "node:util";
import { agentRows } from "./agents.ts";
import { doctor, formatChecks } from "./doctor.ts";
import {
  adoptSkill,
  diffPending,
  diffSkill,
  forkSkill,
  manifestToEdit,
  type ManifestTarget,
  mergeSkill,
} from "./edits.ts";
import { UserError } from "./errors.ts";
import { GitError } from "./exec.ts";
import {
  fleet,
  type FleetAction,
  formatFleet,
  hostProblem,
  tailscalePeers,
  unpublished,
} from "./fleet.ts";
import { isRecord, JsonFileError, readJsonOrNothing } from "./fs.ts";
import { applyPlan, cloneBeforeAdopt, formatPlan, planInit } from "./init.ts";
import { gitUrl } from "./gitcache.ts";
import { errorText } from "./linker.ts";
import {
  canonicalManifestSpec,
  closest,
  defaultSourceId,
  editManifest,
  loadManifest,
  type Manifest,
  ManifestError,
  readConfig,
  updateConfig,
  webPage,
} from "./manifest.ts";
import { findName } from "./names.ts";
import { paths, tildify } from "./paths.ts";
import { formatReport, type Report } from "./report.ts";
import {
  commandOnPath,
  findOnPath,
  installedCli,
  launcherPath,
  selfInstall,
  stableNode,
} from "./selfinstall.ts";
import { promptHook, staleSessions } from "./sessions.ts";
import { loadState } from "./state.ts";
import { LockHeldError, manifestSpec, sync } from "./sync.ts";
import {
  foreignTimer,
  foreignTimerResource,
  formatTimerStatus,
  forgetTimer,
  installTimer as installOsTimer,
  machineTimeZone,
  missingTimer,
  noSystemdMessage,
  recordTimer,
  removeTimer,
  sameAsInstalled,
  systemdMissing,
  TIMER_NAME,
  TimerError,
  timerKind,
  type TimerSpec,
  type TimerStatus,
  timerEnv,
  timerNode,
  timerStatus,
} from "./timer.ts";
import { version } from "./version.ts";

const OPTIONS = {
  offline: { type: "boolean", help: "Use what is already fetched" },
  "dry-run": { type: "boolean", help: "Print what would change and change nothing" },
  json: { type: "boolean", help: "Print one JSON document on stdout; messages go to stderr" },
  copy: {
    type: "boolean",
    help: "Copy skill folders instead of linking them, on this run and every later one",
  },
  "no-copy": { type: "boolean", help: "Link skill folders again after --copy" },
  manifest: { type: "string", help: "<m>  Use this manifest instead of the configured one" },
  timeout: { type: "string", help: "<s>  Seconds to wait for each host (default 30)" },
  "no-timer": { type: "boolean", help: "Do not install the timer" },
  force: { type: "boolean", help: "Go ahead even when skill names would be lost" },
  id: {
    type: "string",
    help: "<id>  The source's id (default: the repository, host or package name)",
  },
  skills: { type: "string", help: "<glob>  Skill folders inside the source, such as skills/*" },
  include: { type: "string", multiple: true, help: "<name>  Only this skill; repeat for more" },
  exclude: { type: "string", multiple: true, help: "<name>  Never this skill; repeat for more" },
  review: { type: "boolean", help: 'Hold the source\'s updates for review ("update": "review")' },
  version: { type: "boolean", short: "v", help: "Print the version" },
  help: { type: "boolean", short: "h", help: "Show help" },
} as const;

type Option = keyof typeof OPTIONS;

interface Command {
  usage: string;
  summary: string;
  /** More on what it does, for `skillfleet <command> --help`. */
  details?: string;
  options: Option[];
}

const SYNC_OPTIONS: Option[] = ["offline", "dry-run", "json", "copy", "no-copy", "manifest"];
/** Commands that change the manifest or move a skill, then sync. */
const EDIT_OPTIONS: Option[] = ["dry-run", "json", "manifest", "offline", "copy", "no-copy"];

const COMMANDS: Record<string, Command> = {
  sync: {
    usage: "sync [source]",
    summary: "Fetch sources and link skills (the default command)",
    details:
      "With a source id, fetch only that source; the others are linked from what is already on disk.",
    options: SYNC_OPTIONS,
  },
  init: {
    usage: "init [manifest]",
    summary: "Point this machine at a manifest, migrate the folders, install the timer",
    details:
      "The manifest is a repository (owner/repo, github:owner/repo, gitlab:group/repo or a git URL ending in .git, read for its skills.json), <repo>//<file>, or a file or folder on this machine. Without one, init uses the configured manifest again.",
    options: [...SYNC_OPTIONS, "no-timer", "force"],
  },
  status: {
    usage: "status",
    summary: "Last run, held and pending updates, edited skills, sessions to restart",
    options: ["json"],
  },
  list: { usage: "list", summary: "Linked skills and where each comes from", options: ["json"] },
  agents: {
    usage: "agents",
    summary: "Agent ids for the manifest's agents, which are installed, and where skills go",
    details:
      '"agents": "all" in the manifest means every agent marked installed here: one whose folder is in your home, such as ~/.claude for Claude Code.',
    options: ["json", "manifest"],
  },
  doctor: {
    usage: "doctor",
    summary: "Check node, git access, the timer and duplicate skills",
    options: ["json", "manifest"],
  },
  add: {
    usage: "add <source>",
    summary: "Add a source: owner/repo, a git or index URL, npm:<package>, or a path",
    details:
      "Adds the source to the manifest and syncs. A manifest kept in a repository is changed in a working clone of it (a source with a path), which you then push.",
    options: [...EDIT_OPTIONS, "id", "skills", "include", "exclude", "review"],
  },
  remove: {
    usage: "remove <source|skill>",
    summary: "Remove a source, or exclude one skill from its source",
    options: EDIT_OPTIONS,
  },
  adopt: {
    usage: "adopt <path>",
    summary: "Move a hand-made skill folder into the personal repository",
    details:
      'The personal repository is the first source marked "adopt": true, else the first git source with a path.',
    options: EDIT_OPTIONS,
  },
  fork: {
    usage: "fork <skill>",
    summary: "Move a vendored skill into the personal repository to edit it",
    details:
      'Records the skill under "forks" in the manifest, with the upstream commit it started from, and excludes it from its source.',
    options: EDIT_OPTIONS,
  },
  diff: {
    usage: "diff [skill]",
    summary: "Show updates waiting for review, or one skill's local edits",
    details:
      "Without a skill, shows every update a source is holding: the skills a review-mode source holds, edited copies whose upstream changed, and the commits a review-mode working clone has not merged.",
    options: ["manifest"],
  },
  merge: {
    usage: "merge <skill>",
    summary: "Merge an upstream update into an edited skill or a fork",
    options: ["dry-run", "json", "manifest"],
  },
  update: {
    usage: "update <source>",
    summary: "Apply the updates a review-mode source is holding",
    options: SYNC_OPTIONS,
  },
  timer: {
    usage: "timer install|remove|status",
    summary: "Install, remove or show the timer that syncs on the manifest's schedule",
    options: ["dry-run", "json", "manifest"],
  },
  fleet: {
    usage: "fleet sync|status|upgrade|add [host...]",
    summary: "Run on the manifest's machines over SSH, or add machines to it",
    details:
      "fleet sync and fleet status take host names to run on fewer machines than the manifest lists. fleet add with no host suggests machines on your tailnet. fleet upgrade installs this version on every host with npx.",
    options: ["dry-run", "json", "manifest", "timeout"],
  },
  hook: {
    usage: "hook prompt",
    summary: "Claude Code UserPromptSubmit hook: announce skills newer than the session",
    options: [],
  },
  "self-install": {
    usage: "self-install",
    summary:
      "Copy this skillfleet into the state folder for the timer (init and fleet upgrade run it)",
    options: [],
  },
};

const optionLine = (name: Option) => {
  const option = OPTIONS[name];
  const short = "short" in option ? `-${option.short}, ` : "";
  const [arg, text] = option.help.includes("  ")
    ? [` ${option.help.split("  ")[0]!}`, option.help.split("  ").slice(1).join("  ")]
    : ["", option.help];
  return `  ${`${short}--${name}${arg}`.padEnd(18)} ${text}`;
};

const USAGE = [
  "Usage: skillfleet [command] [options]",
  "",
  "Keeps the same skills in every agent's skills folder, from the sources a manifest lists.",
  "",
  "Commands:",
  ...Object.values(COMMANDS).map((entry) =>
    entry.usage.length < 25
      ? `  ${entry.usage.padEnd(24)} ${entry.summary}`
      : `  ${entry.usage}\n  ${"".padEnd(24)} ${entry.summary}`,
  ),
  "",
  "Options:",
  ...(
    ["offline", "dry-run", "json", "copy", "no-copy", "manifest", "version", "help"] as const
  ).map(optionLine),
  "",
  "`skillfleet <command> --help` shows a command's options.",
].join("\n");

function commandHelp(name: string): string {
  const entry = COMMANDS[name]!;
  return [
    `Usage: skillfleet ${entry.usage}${entry.options.length ? " [options]" : ""}`,
    "",
    entry.summary,
    ...(entry.details ? ["", entry.details] : []),
    ...(entry.options.length ? ["", "Options:", ...entry.options.map(optionLine)] : []),
  ].join("\n");
}

/** Commands that only read, where a dry run would be the same as the real thing. */
const READ_ONLY = new Set(["status", "list", "agents", "doctor", "diff"]);

/** --json on the command line, read before (or without) parsing it. */
const jsonRequested = () => {
  const args = process.argv.slice(2);
  const end = args.indexOf("--");
  return (end < 0 ? args : args.slice(0, end)).includes("--json");
};

/**
 * One line on stderr and exit code 2, for a command line skillfleet can't run. Under --json,
 * stdout gets the error as a document too.
 */
function usageError(message: string): never {
  if (jsonRequested()) console.log(JSON.stringify({ ok: false, error: message }, null, 2));
  console.error(`skillfleet: ${message}`);
  process.exit(2);
}

let args;
try {
  args = parseArgs({
    allowPositionals: true,
    options: Object.fromEntries(
      Object.entries(OPTIONS).map(([name, { help: _help, ...option }]) => [name, option]),
    ) as { [name in Option]: Omit<(typeof OPTIONS)[name], "help"> },
  });
} catch (error) {
  // Node's message goes on about positionals after its first sentence.
  const said = (error as Error).message.split("\n")[0]!.replace(/(\.) .*/, "$1");
  usageError(`${said} See \`skillfleet --help\`.`);
}
const { values, positionals } = args;
const [command = "sync", ...rest] = positionals;
const dryRun = values["dry-run"] ?? false;
const json = values.json ?? false;

process.env.DO_NOT_TRACK ??= "1";

/** Human lines: on stdout, or on stderr under --json, so stdout holds only the JSON document. */
function say(...lines: string[]) {
  if (lines.length > 0) (json ? console.error : console.log)(lines.join("\n"));
}

const emit = (value: unknown) => console.log(JSON.stringify(value, null, 2));

function usage(message: string): never {
  usageError(`${message}; see \`skillfleet ${command} --help\``);
}

function one(name: string): string {
  if (rest.length !== 1) usage(`${command} takes one ${name}`);
  return rest[0]!;
}

/** --copy and --no-copy for this run, else the choice config.json remembers. */
function copyMode(): boolean {
  if (values.copy && values["no-copy"]) usageError("--copy and --no-copy contradict each other");
  if (values.copy) return true;
  if (values["no-copy"]) return false;
  try {
    return readConfig()?.copy ?? false;
  } catch {
    return false;
  }
}

/** The sync report as the timer's log gets it: the first line starts with the time of the run. */
function reportText(report: Report): string {
  const text = formatReport(report);
  return process.env.SKILLFLEET_TIMER ? `${report.finishedAt} ${text}` : text;
}

async function syncReport(options: { only?: string; apply?: string } = {}): Promise<Report> {
  const copy = copyMode();
  const report = await sync({
    ...options,
    offline: values.offline,
    dryRun,
    copy,
    manifest: values.manifest,
  });
  // Remembered, so the timer's next run copies too (or links again).
  if (!dryRun && (values.copy || values["no-copy"])) updateConfig({ copy });
  return report;
}

async function runSync(options: { only?: string; apply?: string } = {}) {
  let report: Report;
  try {
    report = await syncReport(options);
  } catch (error) {
    // The timer comes back on its next run, so meeting a manual sync is no failure for its unit.
    if (!(error instanceof LockHeldError) || !process.env.SKILLFLEET_TIMER) throw error;
    console.log(`${new Date().toISOString()} skipped: another sync is running (pid ${error.pid})`);
    return 0;
  }
  if (json) emit(report);
  else console.log(reportText(report));
  return report.ok ? 0 : 1;
}

async function installTimer(settings?: Manifest["timer"]): Promise<{
  code: number;
  lines: string[];
  json: Record<string, unknown>;
  /** The machine has no systemd user manager, so it can't have a timer. */
  noSystemd?: boolean;
}> {
  const timer =
    settings ?? (await loadManifest(manifestSpec(values.manifest), { offline: true })).root.timer;
  const installed = dryRun ? undefined : selfInstall();
  const node = installed?.node ?? stableNode();
  const spec: TimerSpec = {
    name: TIMER_NAME,
    cron: timer.cron,
    timeZone: timer.timeZone ?? "local",
    command: [node, installed?.cli ?? installedCli(), "sync"],
    // SKILLFLEET_TIMER puts the time of each run in the log.
    env: { ...timerEnv(findOnPath("git"), node), SKILLFLEET_TIMER: "1" },
    logDir: paths.logs(),
  };
  const lines = [
    `timer ${TIMER_NAME}: \`${spec.command.join(" ")}\` on "${spec.cron}" (${spec.timeZone === "local" ? `the machine's time zone, now ${machineTimeZone()}` : spec.timeZone})`,
  ];
  if (dryRun) {
    if (systemdMissing()) {
      const error = noSystemdMessage(spec.cron);
      lines.push(`would not install a timer: ${error}`);
      return { code: 1, lines, json: { dryRun: true, ...spec, error }, noSystemd: true };
    }
    const same = sameAsInstalled(spec);
    lines.push(
      same
        ? `${timerKind()}: already installed, unchanged`
        : same === false
          ? `would update the installed timer (${timerKind()})`
          : `would install ${timerKind()}`,
    );
    return { code: 0, lines, json: { dryRun: true, ...spec, ...(same ? { changed: false } : {}) } };
  }
  try {
    const result = await installOsTimer(spec);
    recordTimer(spec, result.files);
    updateConfig({ timer: true });
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
    const message = error.noSystemd ? noSystemdMessage(spec.cron) : error.message;
    lines.push(`the timer was not installed: ${message}`);
    return {
      code: 1,
      lines,
      json: { ...spec, error: message },
      ...(error.noSystemd ? { noSystemd: true } : {}),
    };
  }
}

/**
 * After the launcher changed node (self-install or init under another Node.js), a timer installed
 * earlier would still run the old one, which may be gone: install it again with the new node.
 */
async function followLauncherNode(node: string): Promise<string[]> {
  const timer = timerNode();
  if (!timer || timer.node === node) return [];
  let settings: Manifest["timer"];
  try {
    settings = (await loadManifest(manifestSpec(values.manifest), { offline: true })).root.timer;
  } catch (error) {
    return [
      `the timer still runs ${timer.node}, and the manifest to install it again does not load (${(error as Error).message.split("\n")[0]}); run \`skillfleet timer install\``,
    ];
  }
  const result = await installTimer(settings);
  return [`the timer ran ${timer.node}; installing it again with ${node}`, ...result.lines];
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
  if (rest.length > 1) usage("timer takes one of install, remove or status");
  switch (action) {
    case "install": {
      const result = await installTimer();
      if (json) emit(result.json);
      else say(...result.lines);
      return result.code;
    }
    case "status": {
      if (dryRun) usageError("timer status changes nothing, so it has no --dry-run");
      const status = await readTimer();
      if (status instanceof TimerError) throw status;
      const foreign = status.installed ? undefined : await foreignTimerResource();
      if (json) emit(status);
      else
        say(
          `${TIMER_NAME}: ${foreign ? foreignTimer(TIMER_NAME, foreign) : formatTimerStatus(status)}`,
        );
      return status.installed ? 0 : 1;
    }
    case "remove": {
      if (dryRun) {
        const status = await readTimer();
        if (status instanceof TimerError) throw status;
        if (json) emit({ dryRun: true, existed: status.installed });
        else say(status.installed ? `would remove ${TIMER_NAME}` : "no timer installed");
        return 0;
      }
      const removal = await removeTimer();
      const foreign = removal.existed ? undefined : await foreignTimerResource();
      if (foreign) throw new UserError(`nothing removed: ${foreignTimer(TIMER_NAME, foreign)}`);
      forgetTimer();
      updateConfig({ timer: false });
      if (json) emit(removal);
      else if (!removal.existed) say("no timer installed");
      else say(`removed ${TIMER_NAME}`, ...removal.removed.map((file) => `  ${tildify(file)}`));
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
    emit({
      manifest: config?.manifest,
      lastRun: report,
      lastChange: state.lastChange,
      staleSessions: stale,
      timer: timerState instanceof TimerError ? { error: timerState.message } : timerState,
    });
    return 0;
  }
  say(`manifest: ${config?.manifest ?? "none; run `skillfleet init <manifest>`"}`);
  if (!report) say("no sync has run on this machine yet");
  else
    say(`last run: ${report.finishedAt}${report.ok ? "" : " (with errors)"}`, formatReport(report));
  const declined = config?.timer === false;
  say(
    `timer: ${
      timerState instanceof TimerError
        ? timerState.noSystemd || declined
          ? `${declined ? "not installed, as you chose; " : ""}${timerState.message.split("\n")[0]}`
          : `unknown (${timerState.message.split("\n")[0]})`
        : timerState.installed
          ? formatTimerStatus(timerState)
          : await missingTimer(timerState, declined)
    }`,
  );
  for (const proc of stale)
    say(
      `restart: ${proc.agent} (pid ${proc.pid}) started ${proc.startedAt.toISOString()}, before the last skill change at ${state.lastChange}`,
    );
  return 0;
}

function list() {
  const state = loadState();
  if (json) emit(state.skills);
  else
    for (const name of Object.keys(state.skills).sort())
      say(`${name}  ${state.skills[name]!.source}  ${tildify(state.skills[name]!.dir)}`);
  return 0;
}

async function agents() {
  let chosen;
  // Without a manifest the list still shows the ids and what is installed; a manifest named with
  // --manifest or in config.json that does not load is an error.
  const spec = values.manifest ?? readConfig()?.manifest;
  if (spec) chosen = (await loadManifest(spec, { offline: true })).root.agents;
  const rows = await agentRows(chosen);
  if (json) {
    emit(rows);
    return 0;
  }
  const width = Math.max(...rows.map((row) => row.id.length));
  say(
    ...rows.map((row) =>
      [
        row.id.padEnd(width),
        row.detected ? "installed" : "         ",
        row.linkedInto
          ? `linked into ${tildify(row.linkedInto)}`
          : row.dir
            ? tildify(row.dir)
            : "(no global skills folder)",
      ].join("  "),
    ),
  );
  return 0;
}

/** What `add` writes for a source string. */
function sourceFromSpec(spec: string): Record<string, unknown> {
  if (spec.startsWith("npm:")) return { npm: spec.slice(4) };
  // A GitHub or GitLab page: git clones the repository, not the page of a folder or file in it.
  const page = webPage(spec);
  if (page) {
    const folder =
      page.kind === "blob"
        ? page.path?.includes("/")
          ? dirname(page.path)
          : undefined
        : page.path;
    const skillFile = page.kind === "blob" && /(^|\/)SKILL\.md$/.test(page.path ?? "");
    return {
      git: page.repo,
      ...(page.ref ? { ref: page.ref } : {}),
      ...(folder ? { skills: skillFile ? folder : `${folder}/**` } : {}),
    };
  }
  // A bare repository or a URL that names one.
  if (
    /\.git[\\/]?$/.test(spec) ||
    spec.startsWith("git@") ||
    spec.startsWith("github:") ||
    spec.startsWith("gitlab:")
  )
    return { git: spec.replace(/[\\/]+$/, "") };
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
  return { git: spec.replace(/[\\/]+$/, "") };
}

/**
 * Changes the manifest at `target` (or, in a dry run, checks the change), says what changed, and
 * syncs when the change is in effect on this machine; in a working clone it waits for a push.
 */
async function changeManifest(
  what: string,
  target: ManifestTarget,
  change: (raw: Record<string, unknown>) => void,
  details: Record<string, unknown>,
) {
  editManifest(target.file, change, { dryRun });
  const where = tildify(target.file);
  const result = { ...details, file: target.file, push: target.push, dryRun };
  if (dryRun) {
    say(`would ${what} in ${where}`);
    if (json) emit(result);
    return 0;
  }
  if (target.push) {
    say(`${what} in ${where}; commit and push it, and the next sync uses it`);
    if (json) emit(result);
    return 0;
  }
  say(`${what} in ${where}`);
  return syncAfter(result);
}

/** Syncs after a change: the report is printed, or under --json goes into the command's document. */
async function syncAfter(result: Record<string, unknown>) {
  const report = await syncReport();
  if (json) emit({ ...result, sync: report });
  else console.log(reportText(report));
  return report.ok ? 0 : 1;
}

async function add() {
  const spec = one("source");
  const entry: Record<string, unknown> = sourceFromSpec(spec);
  entry.id = values.id ?? defaultSourceId(entry);
  if (values.skills) entry.skills = values.skills;
  if (values.include) entry.include = values.include;
  if (values.exclude) entry.exclude = values.exclude;
  if (values.review) entry.update = "review";
  const source = { id: entry.id, ...entry };
  const manifest = manifestSpec(values.manifest);
  const loaded = await loadManifest(manifest, { offline: true });
  const target = manifestToEdit(loaded, manifest, `Add ${JSON.stringify(source)} to "sources"`);
  return changeManifest(
    `add ${String(entry.id)}`,
    target,
    (raw) => {
      const sources = Array.isArray(raw.sources) ? raw.sources : [];
      raw.sources = [...sources, source];
    },
    { added: source },
  );
}

async function remove() {
  const name = one("source or skill");
  const manifest = manifestSpec(values.manifest);
  const loaded = await loadManifest(manifest, { offline: true });
  if (loaded.root.sources.some((source) => source.id === name)) {
    const target = manifestToEdit(loaded, manifest, `Remove the source "${name}" from "sources"`);
    return changeManifest(
      `remove source ${name}`,
      target,
      (raw) => {
        raw.sources = (Array.isArray(raw.sources) ? raw.sources : []).filter(
          (source: unknown) => !isRecord(source) || (source.id ?? defaultSourceId(source)) !== name,
        );
      },
      { removed: name },
    );
  }
  const linked = loadState().skills;
  // The skill as skillfleet keeps it, typed in any case or Unicode form.
  const skill = findName(Object.keys(linked), name);
  const owner = skill === undefined ? undefined : linked[skill]!.source;
  const source = loaded.sources.find((candidate) => candidate.id === owner);
  if (!skill || !source) throw new UserError(`no source or linked skill named "${name}"`);
  if (source.origin !== loaded.root.file)
    throw new UserError(
      `${skill} comes from ${source.id} in ${tildify(source.origin)}; exclude it there`,
    );
  const target = manifestToEdit(
    loaded,
    manifest,
    `Add "${skill}" to "exclude" of the source "${source.id}"`,
  );
  return changeManifest(
    `exclude ${skill} from ${source.id}`,
    target,
    (raw) => {
      for (const entry of Array.isArray(raw.sources) ? raw.sources : [])
        if (isRecord(entry) && (entry.id ?? defaultSourceId(entry)) === source.id)
          entry.exclude = [
            ...new Set([...(Array.isArray(entry.exclude) ? entry.exclude : []), skill]),
          ];
    },
    { excluded: skill, source: source.id },
  );
}

async function init() {
  if (rest.length > 1) usage("init takes one manifest");
  const given = rest[0] ?? values.manifest ?? readConfig()?.manifest;
  if (!given)
    usage(
      "init needs a manifest: a path, a repository such as owner/repo (its skills.json), or <repo>//<file> such as github:org/agents//skills.json",
    );
  const plan = await planInit(canonicalManifestSpec(given), { offline: values.offline, dryRun });
  if (dryRun) {
    const launcher = `would install ${tildify(launcherPath())}, the copy new shells, the timer and \`fleet\` run (node ${stableNode()})`;
    const timer = values["no-timer"] ? undefined : await installTimer(plan.timer);
    const timerLines = timer?.lines ?? ["no timer (--no-timer)"];
    if (json)
      emit({
        ...plan,
        launcher: { path: launcherPath(), node: stableNode() },
        timer: timer?.json ?? { declined: true },
      });
    else say(formatPlan(plan), ...[launcher, ...timerLines].map((line) => `  ${line}`));
    return plan.lost.length > 0 ? 1 : 0;
  }
  say(formatPlan(plan, { errors: false }));
  if (plan.lost.length > 0 && !values.force)
    throw new UserError(
      `init would lose ${plan.lost.join(", ")}; add a source for them, or pass --force`,
    );
  const applied = [...(await cloneBeforeAdopt(plan)), ...applyPlan(plan)];
  say(...applied.map((line) => `  ${line}`));
  if (values["no-timer"]) updateConfig({ timer: false });
  const report = await syncReport();
  if (!json) console.log(reportText(report));
  // The copy that new shells, the timer and `fleet` run, with or without the timer.
  const installed = selfInstall();
  const onPath = commandOnPath(installed.launcher);
  say(onPath, ...installed.notes);
  const timerResult = values["no-timer"] ? undefined : await installTimer(plan.timer);
  if (timerResult) say(...timerResult.lines);
  // With --no-timer, a timer installed before still runs; it must not keep a node that is gone.
  else say(...(await followLauncherNode(installed.node)));
  if (json)
    emit({
      plan,
      applied,
      sync: report,
      installed: { ...installed, onPath },
      ...(timerResult ? { timer: timerResult.json } : {}),
    });
  // A machine without systemd can't have a timer; init did its job and said what to use instead.
  return (report.ok ? 0 : 1) || (timerResult?.noSystemd ? 0 : (timerResult?.code ?? 0));
}

async function fleetCommand(action: string | undefined) {
  const loaded = await loadManifest(manifestSpec(values.manifest), { offline: true });
  if (action === "add") {
    const hosts = rest.slice(1);
    if (hosts.length === 0) {
      const peers = await tailscalePeers();
      const known = new Set(loaded.root.fleet);
      const suggestions = peers.filter((peer) => !known.has(peer.host) && !known.has(peer.dns));
      if (json) emit({ suggestions });
      else if (suggestions.length === 0)
        say("no tailnet machines to suggest; name hosts: skillfleet fleet add <host>...");
      else
        say(
          "machines on your tailnet; add the ones you want with `skillfleet fleet add <host>...`:",
          ...suggestions.map(
            (peer) =>
              `  ${peer.host}${peer.online ? "" : " (offline)"}${peer.dns ? `  ${peer.dns}` : ""}`,
          ),
        );
      return 0;
    }
    const problems = hosts.flatMap((host) => hostProblem(host) ?? []);
    if (problems.length > 0) throw new UserError(problems.join("\n"));
    const target = manifestToEdit(
      loaded,
      manifestSpec(values.manifest),
      `Add ${JSON.stringify(hosts)} to "fleet"`,
    );
    editManifest(
      target.file,
      (raw) => {
        raw.fleet = [...new Set([...(Array.isArray(raw.fleet) ? raw.fleet : []), ...hosts])];
      },
      { dryRun },
    );
    say(
      `${dryRun ? "would add" : "added"} ${hosts.join(", ")} to the fleet in ${tildify(target.file)}${target.push && !dryRun ? "; commit and push it" : ""}`,
    );
    if (json) emit({ added: hosts, file: target.file, push: target.push, dryRun });
    return 0;
  }
  if (action !== "sync" && action !== "status" && action !== "upgrade")
    return usage("fleet takes sync, status, upgrade or add");
  if (dryRun && action !== "sync")
    usageError(
      action === "status"
        ? "fleet status changes nothing, so it has no --dry-run"
        : "fleet upgrade has no --dry-run; `skillfleet fleet status` shows each host's version",
    );
  const hosts = rest.length > 1 ? rest.slice(1) : loaded.root.fleet;
  if (hosts.length === 0) usage("the manifest has no fleet; add hosts with `skillfleet fleet add`");
  if (action === "upgrade") {
    const reason = await unpublished(version);
    if (reason) throw new UserError(reason);
  }
  const timeout = values.timeout ? Number(values.timeout) * 1000 : 30_000;
  if (!Number.isFinite(timeout) || timeout <= 0) usage("--timeout takes seconds");
  const results = await fleet(hosts, action satisfies FleetAction, version, timeout, { dryRun });
  if (json) emit(results);
  else say(formatFleet(results));
  // A sync that ran with errors on a host fails here as it does there.
  const failed = (result: (typeof results)[number]) =>
    !result.reachable ||
    result.error !== undefined ||
    (action !== "status" && result.lastRun?.ok === false);
  return results.some(failed) ? 1 : 0;
}

async function main(): Promise<number> {
  if (values.version) {
    console.log(version);
    return 0;
  }
  if (positionals.length === 0 && values.help) {
    console.log(USAGE);
    return 0;
  }
  const entry = Object.hasOwn(COMMANDS, command) ? COMMANDS[command] : undefined;
  if (!entry) {
    const near = closest(command, Object.keys(COMMANDS));
    usageError(
      `unknown command "${command}"${near ? `; did you mean "${near}"?` : "."} \`skillfleet --help\` lists the commands`,
    );
  }
  if (values.help) {
    console.log(commandHelp(command));
    return 0;
  }
  for (const name of Object.keys(values) as Option[])
    if (!entry.options.includes(name) && name !== "help")
      usageError(
        name !== "dry-run"
          ? `${command} does not take --${name}; see \`skillfleet ${command} --help\``
          : READ_ONLY.has(command)
            ? `${command} changes nothing, so it has no --dry-run`
            : `${command} has no --dry-run`,
      );
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
    case "agents":
      return agents();
    case "doctor": {
      const checks = await doctor(values.manifest);
      if (json) emit(checks);
      else say(formatChecks(checks));
      return checks.every((check) => check.ok) ? 0 : 1;
    }
    case "add":
      return add();
    case "remove":
      return remove();
    case "adopt": {
      const result = await adoptSkill(manifestSpec(values.manifest), resolve(one("path")), {
        dryRun,
      });
      if (dryRun) {
        say(`would move ${result.name} to ${tildify(result.to)}`);
        if (json) emit({ ...result, dryRun });
        return 0;
      }
      say(`moved ${result.name} to ${tildify(result.to)}; commit it there`);
      return syncAfter({ ...result, dryRun });
    }
    case "fork": {
      const result = await forkSkill(manifestSpec(values.manifest), one("skill"), { dryRun });
      const where = tildify(result.manifest.file);
      const push = result.manifest.push ? `, then commit and push ${where}` : "";
      const details = { ...result, dryRun };
      if (dryRun) {
        say(
          `would copy ${tildify(result.from)} to ${tildify(result.to)}, record the fork in ${where}, and remove skillfleet's copy`,
        );
        if (json) emit(details);
        return 0;
      }
      say(`forked into ${tildify(result.to)}; commit it there${push}`);
      if (result.manifest.push) {
        if (json) emit(details);
        return 0;
      }
      return syncAfter(details);
    }
    case "diff": {
      if (rest.length > 1) usage("diff takes at most one skill");
      const spec = manifestSpec(values.manifest);
      const out = rest[0] ? await diffSkill(spec, rest[0]) : await diffPending(spec);
      process.stdout.write(
        out || (rest[0] ? "no differences\n" : "no updates are waiting for review\n"),
      );
      return 0;
    }
    case "merge": {
      const result = await mergeSkill(manifestSpec(values.manifest), one("skill"), { dryRun });
      const would = dryRun ? "would merge" : "merged";
      if (result.merged.length) say(`${would}: ${result.merged.join(", ")}`);
      if (result.conflicts.length)
        say(
          `${dryRun ? "would conflict" : "conflicts"}: ${result.conflicts.join(", ")} in ${tildify(result.into)}${dryRun ? "" : "; resolve the markers by hand"}`,
        );
      if (!result.merged.length && !result.conflicts.length) say("nothing to merge");
      if (result.manifest?.push && !dryRun)
        say(`recorded the new base in ${tildify(result.manifest.file)}; commit and push it`);
      if (json) emit({ ...result, dryRun });
      return result.conflicts.length && !dryRun ? 1 : 0;
    }
    case "timer":
      return timer(rest[0]);
    case "fleet":
      return fleetCommand(rest[0]);
    case "hook":
      if (rest[0] !== "prompt" || rest.length > 1) usage("hook takes prompt");
      process.stdout.write(promptHook(readFileSync(0, "utf8"), loadState()));
      return 0;
    case "self-install": {
      const result = selfInstall();
      say(
        `installed ${tildify(result.launcher)} (node ${result.node})`,
        commandOnPath(result.launcher),
        ...result.notes,
        ...(await followLauncherNode(result.node)),
      );
      return 0;
    }
    default:
      return usage(`unknown command "${command}"`);
  }
}

/**
 * What to tell the user about an error, in one line. Mistakes and failures they can act on (a
 * wrong name, a repository git can't read, a bad manifest) never print a stack; an error skillfleet
 * did not expect does, with SKILLFLEET_DEBUG=1.
 */
function explain(error: unknown): { message: string; expected: boolean } {
  if (
    error instanceof UserError ||
    error instanceof ManifestError ||
    error instanceof JsonFileError ||
    error instanceof TimerError
  )
    return { message: error.message, expected: true };
  if (error instanceof GitError) return { message: gitProblem(error), expected: true };
  if (error instanceof Error && "code" in error && "path" in error)
    return { message: `${errorText(error)}: ${String(error.path)}`, expected: true };
  return { message: error instanceof Error ? error.message : String(error), expected: false };
}

/** A git failure in words: the repository it could not read, and what to check. */
function gitProblem(error: GitError): string {
  if (error.result.spawnError === "ENOENT") return error.message;
  // The subcommand: the first argument that is not an option or the value of -c.
  const verb = error.args.find((arg, i) => !arg.startsWith("-") && error.args[i - 1] !== "-c");
  // clone, fetch and ls-remote name the repository right after "--", unless it is a remote's name.
  const at = error.args.indexOf("--");
  const named = at >= 0 ? error.args[at + 1] : undefined;
  const repo =
    named && named !== "origin" && ["clone", "fetch", "ls-remote"].includes(verb ?? "")
      ? named
      : undefined;
  const said = (error.result.stderr || error.result.stdout)
    .split("\n")
    .map((line) => line.replace(/^(fatal|error):\s*/, "").trim())
    .filter(Boolean);
  const text = said.join(" ");
  const what = repo ? `the repository ${gitUrl(repo)}` : "the repository";
  if (
    /could not read (Username|Password)|Authentication failed|Repository not found|repository .* (not found|does not exist)|does not appear to be a git repository|Permission denied \(publickey|Could not read from remote repository/i.test(
      text,
    )
  )
    return `cannot read ${what}: it does not exist, or it is private and git has no credentials for it. Check the name, or your git credentials (git said: ${said[0]})`;
  if (/Could not resolve host|unable to access|Connection (refused|timed out)/i.test(text))
    return `cannot reach ${what}: check the network (git said: ${said[0]})`;
  return `git ${verb ?? ""} failed: ${said.at(-1) ?? `exit ${error.result.code}`}`;
}

main().then(
  (code) => {
    process.exitCode = code;
  },
  (error: unknown) => {
    const { message, expected } = explain(error);
    // Under --json, a failure is a document too.
    if (json) emit({ ok: false, error: message });
    const at = process.env.SKILLFLEET_TIMER ? `${new Date().toISOString()} ` : "";
    if (expected) console.error(`${at}skillfleet: ${message}`);
    else if (process.env.SKILLFLEET_DEBUG) console.error(error);
    else
      console.error(
        `${at}skillfleet: unexpected error: ${message}\n  run again with SKILLFLEET_DEBUG=1 for the stack trace, and report it at https://github.com/onmax/skillfleet/issues`,
      );
    process.exitCode = 1;
  },
);
