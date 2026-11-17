import { randomBytes } from "node:crypto";
import {
  copyFileSync,
  existsSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { hostname, tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { agentTargets, formerTargets } from "./agents.ts";
import { UserError } from "./errors.ts";
import { checkForks } from "./edits.ts";
import { exec, stopAll } from "./exec.ts";
import {
  changedFiles,
  hashDir,
  isErrno,
  isRecord,
  isRunning,
  lstat,
  moveDir,
  readJsonOrNothing,
  resolvedHashes,
  sameTree,
  sha256,
  writeJson,
} from "./fs.ts";
import { matchesGlob } from "./glob.ts";
import {
  type DesiredLink,
  errorText,
  linkTargetDir,
  MANIFEST_FILE,
  readTargetManifest,
  type TargetReport,
} from "./linker.ts";
import {
  isVendoredKind,
  type LoadedManifest,
  loadManifest,
  ManifestError,
  readConfig,
  remoteManifest,
} from "./manifest.ts";
import { nameKey } from "./names.ts";
import { paths, tildify } from "./paths.ts";
import {
  sameBoot as bootsMatch,
  processAge,
  processStartedAt,
  processStartTicks,
  type Whereabouts,
  whereabouts,
} from "./process.ts";
import type { HookRun, Report } from "./report.ts";
import { failedResult, type SourceResult, sourceFiles, syncSource } from "./sources.ts";
import { loadState, saveState, sourceState, type State } from "./state.ts";
import { version } from "./version.ts";

export interface SyncOptions {
  /** Fetch only this source; the others are linked from what is already on disk. */
  only?: string;
  offline?: boolean;
  dryRun?: boolean;
  copy?: boolean;
  /** Apply review-mode updates of this source (`skillfleet update <source>`). */
  apply?: string;
  /** Manifest spec, instead of the one in config.json. */
  manifest?: string;
  /** An already loaded manifest (init plans with one that is not on disk yet). */
  loaded?: LoadedManifest;
}

export function manifestSpec(override?: string): string {
  if (override) return override;
  const config = readConfig();
  if (!config) throw new ManifestError("no manifest yet: run `skillfleet init <manifest>` first");
  return config.manifest;
}

/** Agents that skip a skill whose SKILL.md is a symlink, found by running them. */
const SKIP_LINKED_SKILL_MD: Record<string, string> = { codex: "Codex", cursor: "Cursor" };

/**
 * No sync takes this long (a whole run is stopped after `SYNC_TIMEOUT_MS`); a lock older than this
 * was left by one that hung or was killed.
 */
const LOCK_MAX_AGE_MS = 2 * 60 * 60 * 1000;

/**
 * How far the start the OS records for a process may come after the start it measured itself
 * (`performance.timeOrigin`): `ps` gives whole seconds, and Linux places a start through the boot
 * time, which moves when the clock is set.
 */
const START_SLACK_MS = 10_000;

export interface LockHolder {
  pid: number;
  /** When the holder started, by its own clock, to tell it from a later process with its pid. */
  started?: number;
  at: number;
  /** The holder's machine (hostname), boot and pid namespace; see `Whereabouts`. */
  host?: string;
  boot?: string;
  ns?: string;
  /** Milliseconds since boot when the lock was taken, to age it on a clock nobody sets. */
  uptime?: number;
  /** Linux: the holder's start in clock ticks since boot, which setting the clock does not move. */
  ticks?: number;
}

const optional = <T extends "string" | "number">(
  raw: Record<string, unknown>,
  key: string,
  type: T,
) => (typeof raw[key] === type ? (raw[key] as T extends "string" ? string : number) : undefined);

function readLock(file: string): { text: string; holder: LockHolder } | undefined {
  let text: string;
  let mtime: number;
  try {
    text = readFileSync(file, "utf8");
    mtime = statSync(file).mtimeMs;
  } catch (error) {
    if (isErrno(error, "ENOENT")) return undefined;
    throw error;
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {}
  if (isRecord(raw) && typeof raw.pid === "number")
    return {
      text,
      holder: {
        pid: raw.pid,
        started: optional(raw, "started", "number"),
        at: optional(raw, "at", "number") ?? mtime,
        host: optional(raw, "host", "string"),
        boot: optional(raw, "boot", "string"),
        ns: optional(raw, "ns", "string"),
        uptime: optional(raw, "uptime", "number"),
        ticks: optional(raw, "ticks", "number"),
      },
    };
  return { text, holder: { pid: typeof raw === "number" ? raw : 0, at: mtime } };
}

/** What this process writes into the sync lock: who it is, and where. */
export function lockText(): string {
  const here = whereabouts();
  const ticks = processStartTicks();
  return JSON.stringify({
    pid: process.pid,
    started: Math.floor(performance.timeOrigin),
    at: Date.now(),
    ...here,
    ...(ticks === undefined ? {} : { ticks }),
  });
}

/** Where a lock's holder runs, when that is not here: another machine, or another container. */
function elsewhere(holder: LockHolder, here: Whereabouts): string | undefined {
  if (holder.host !== undefined && holder.host !== here.host) return `on ${holder.host}`;
  if (holder.ns !== undefined && here.ns !== undefined && holder.ns !== here.ns)
    return `in another container on ${holder.host ?? here.host}`;
  return undefined;
}

/**
 * Why a lock no longer guards a running sync, or undefined while it does. The holder is the
 * process with its pid that started no later than it did; one that started after it got the pid
 * when the holder was gone. A pid names a process only on its own machine, boot and pid
 * namespace, so a lock taken elsewhere (two containers or two machines sharing HOME) is held until
 * it is too old.
 */
function staleBecause(holder: LockHolder): string | undefined {
  const here = whereabouts();
  const { pid } = holder;
  const sameBoot = holder.boot !== undefined && bootsMatch(holder.boot, here.boot);
  // On one boot, the time since boot ages a lock whatever the clock does.
  const lockAge =
    sameBoot && holder.uptime !== undefined ? here.uptime - holder.uptime : Date.now() - holder.at;
  const away = elsewhere(holder, here);
  if (away)
    return lockAge > LOCK_MAX_AGE_MS
      ? `its sync ${away} took it more than two hours ago`
      : undefined;
  // A boot id differs only after a restart; a boot time elsewhere moves with the clock too.
  if (
    process.platform === "linux" &&
    holder.boot !== undefined &&
    !holder.boot.startsWith("t:") &&
    !sameBoot
  )
    return `the machine restarted since its sync (pid ${pid}) took it`;
  if (!(pid > 0) || pid === process.pid) return `it names no running sync`;
  try {
    process.kill(pid, 0);
  } catch (error) {
    if (!isErrno(error, "EPERM")) return `its sync (pid ${pid}) is gone`;
  }
  // Every lock since 0.0.1 says when its holder started; an older one can't tell a live sync from
  // another program, and none was ever released.
  if (holder.started === undefined && holder.ticks === undefined)
    return `an older skillfleet wrote it`;
  if (holder.ticks !== undefined && sameBoot) {
    const ticks = processStartTicks(pid);
    if (ticks !== undefined && ticks !== holder.ticks) return `pid ${pid} is now another program`;
  } else {
    // By the clock: a process that started after the holder did and after the lock was taken got
    // the pid later. Both, since a clock set forward moves where the OS places a start.
    const started = processStartedAt(pid);
    if (
      started !== undefined &&
      started > (holder.started ?? 0) + START_SLACK_MS &&
      started > holder.at + START_SLACK_MS
    )
      return `pid ${pid} is now another program`;
  }
  // The holder is this process, so the lock is no older than it: a clock set forward ages the lock
  // by the clock, never the process by its time since boot.
  const age = Math.min(lockAge, processAge(pid) ?? lockAge);
  if (age > LOCK_MAX_AGE_MS) return `it is more than two hours old`;
  return undefined;
}

/** Another sync holds the lock and is still running. */
export class LockHeldError extends UserError {
  readonly pid: number;
  constructor(pid: number, where?: string) {
    super(`another skillfleet sync is running (pid ${pid}${where ? ` ${where}` : ""})`);
    this.pid = pid;
  }
}

const heldError = (holder: LockHolder) =>
  new LockHeldError(holder.pid, elsewhere(holder, whereabouts()));

/** How `takeLock` judges a lock and, in tests, lets other contenders in between its steps. */
export interface LockOptions {
  /** Why a holder no longer guards a running sync, or undefined while it does. */
  staleBecause?: (holder: LockHolder) => string | undefined;
  /** Called after each step that reads or changes the lock's files. */
  step?: () => void;
}

/** Takes the sync lock atomically; a stale lock is moved aside first. Returns the release and a note. */
function acquireLock(): { release: () => void; note?: string } {
  const file = paths.lock();
  mkdirSync(dirname(file), { recursive: true });
  const mine = lockText();
  const release = () => {
    if (readLock(file)?.text === mine) rmSync(file, { force: true });
  };
  return { release, note: takeLock(file, mine) };
}

/**
 * Creates the lock `file` holding `mine`, breaking a stale lock first. Returns a note when it broke
 * one. Throws LockHeldError while a running sync holds it, or is breaking it.
 */
export function takeLock(
  file: string,
  mine: string,
  options: LockOptions = {},
): string | undefined {
  const judge = options.staleBecause ?? staleBecause;
  const step = options.step ?? (() => {});
  let note: string | undefined;
  for (let attempt = 0; attempt < 5; attempt++) {
    if (create(file, mine)) {
      sweepBreakMarkers(file, judge);
      return note;
    }
    step();
    const lock = readLock(file);
    if (!lock) continue;
    const reason = judge(lock.holder);
    if (!reason) throw heldError(lock.holder);
    step();
    if (breakLock(file, lock.text, mine, judge, step))
      note = `removed a stale sync lock: ${reason}`;
  }
  throw new Error(`could not take the sync lock ${tildify(file)}`);
}

/** The marker that one breaker of the lock `file` holding `text` creates; named for that text. */
const breakMarker = (file: string, text: string) => `${file}.${sha256(text).slice(0, 16)}.break`;

/**
 * Deletes the lock `file` if it still holds `text`, the lock judged stale. Breakers of one lock go
 * one at a time: each first creates its marker, exclusively. A lock leaves its path only through its
 * breaker, or its own sync's release, so while the marker is held, the lock read again is still the
 * one judged stale, and a sync that took the path since is never removed. A marker left by a breaker
 * that died is broken the same way. Returns whether it deleted the lock.
 */
function breakLock(
  file: string,
  text: string,
  mine: string,
  judge: (holder: LockHolder) => string | undefined,
  step: () => void,
  depth = 0,
): boolean {
  const marker = breakMarker(file, text);
  if (!create(marker, mine)) {
    step();
    const breaker = readLock(marker);
    if (!breaker) return false;
    if (depth >= 3 || !judge(breaker.holder)) throw heldError(breaker.holder);
    breakLock(marker, breaker.text, mine, judge, step, depth + 1);
    return false;
  }
  try {
    step();
    if (readLock(file)?.text !== text) return false;
    rmSync(file, { force: true });
    step();
    return true;
  } finally {
    rmSync(marker, { force: true });
  }
}

/** Deletes break markers whose breaker is gone; the caller holds the lock, so none is in use for it. */
function sweepBreakMarkers(file: string, judge: (holder: LockHolder) => string | undefined) {
  const dir = dirname(file);
  const prefix = `${basename(file)}.`;
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return;
  }
  for (const name of names) {
    if (!name.startsWith(prefix) || !name.endsWith(".break")) continue;
    const marker = readLock(join(dir, name));
    if (marker && judge(marker.holder)) rmSync(join(dir, name), { force: true });
  }
}

/**
 * Deletes the temporary files a killed sync left while it wrote state.json or last-run.json
 * (`writeJson`). Other commands write state.json without the lock, so a file goes only when its
 * process is gone, or when it is older than any write takes, in case its pid was reused.
 */
function sweepJsonTemps() {
  const dir = dirname(paths.state());
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return;
  }
  for (const name of names) {
    const match = /^(?:state|last-run)\.json\.(\d+)(?:\.[0-9a-f]+)?\.tmp$/.exec(name);
    if (!match) continue;
    const file = join(dir, name);
    const age = Date.now() - (lstat(file)?.mtimeMs ?? Date.now());
    if (!isRunning(Number(match[1])) || age > 10 * 60_000) rmSync(file, { force: true });
  }
}

/** Creates `file` with `text` only if it does not exist, never leaving it half written. */
function create(file: string, text: string): boolean {
  // Unique across machines and containers that share this folder, where pids repeat.
  const temp = `${file}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
  writeFileSync(temp, text);
  try {
    linkSync(temp, file);
    return true;
  } catch (error) {
    if (isErrno(error, "EEXIST")) return false;
    // File systems without hard links: an exclusive create is atomic too.
    try {
      writeFileSync(file, text, { flag: "wx" });
      return true;
    } catch (inner) {
      if (isErrno(inner, "EEXIST")) return false;
      throw inner;
    }
  } finally {
    rmSync(temp, { force: true });
  }
}

/**
 * The longest a whole sync may take: well under `LOCK_MAX_AGE_MS`, so a lock this old is never a
 * live sync's. SKILLFLEET_SYNC_TIMEOUT_MS sets it, for tests.
 */
function syncTimeoutMs(): number {
  const set = Number(process.env.SKILLFLEET_SYNC_TIMEOUT_MS);
  return set > 0 && set < LOCK_MAX_AGE_MS ? set : 60 * 60_000;
}

/** Hooks run while the sync holds its lock, so a stuck one is stopped after this long. */
const HOOK_TIMEOUT_MS = 5 * 60_000;

const splitPattern = (pattern: string) => {
  const at = pattern.indexOf(":");
  return at < 0
    ? { id: "*", glob: pattern }
    : { id: pattern.slice(0, at), glob: pattern.slice(at + 1) };
};

/**
 * One warning for each hook pattern that matches no file of the sources it names, so a hook that
 * can never run is not silent. Changed paths start at the root of the source's repository.
 */
async function unmatchedHooks(loaded: LoadedManifest, results: SourceResult[]): Promise<string[]> {
  const warnings: string[] = [];
  const files = new Map<string, Promise<string[]>>();
  const filesOf = (result: SourceResult) => {
    const source = loaded.sources.find((candidate) => candidate.id === result.id)!;
    if (!files.has(result.id)) files.set(result.id, sourceFiles(source, result));
    return files.get(result.id)!;
  };
  for (const hook of loaded.root.hooks)
    for (const pattern of hook.on) {
      const { id, glob } = splitPattern(pattern);
      const named = results.filter(
        (result) => (id === "*" || result.id === id) && !result.error && result.skills.length > 0,
      );
      if (id !== "*" && !results.some((result) => result.id === id)) {
        if (!loaded.failed?.length)
          warnings.push(`hook ${hook.name}: "${pattern}" names no source "${id}"`);
        continue;
      }
      let example: string | undefined;
      let matched = named.length === 0;
      for (const result of named) {
        const list = await filesOf(result);
        if (list.some((file) => matchesGlob(file, glob))) matched = true;
        example ??= list.find((file) => /(^|\/)SKILL\.md$/.test(file)) ?? list[0];
        if (matched) break;
      }
      if (!matched && example)
        warnings.push(
          `hook ${hook.name}: "${pattern}" matches no file in ${id === "*" ? "any source" : id}, so it never runs; paths start at the root of the source, as in ${example}`,
        );
    }
  return warnings;
}

/**
 * `sync <source>` and `update <source>` read the other sources from disk only. What only a fetch
 * finds out, such as a working clone held back or waiting for review, or a source that failed, is
 * carried over from the last run for them, so `status` keeps showing it.
 */
function carryOver(report: Report, only: string) {
  const raw = readJsonOrNothing(paths.lastRun());
  if (!isRecord(raw) || raw.version !== 1 || !Array.isArray(raw.sources)) return;
  const last = raw as unknown as Report;
  for (const [i, entry] of report.sources.entries()) {
    if (entry.id === only || entry.status !== "offline") continue;
    const before = last.sources.find((source) => source.id === entry.id);
    if (!before || before.kind !== entry.kind) continue;
    if (before.status === "error" && before.error) {
      // Not fetched this time, so it is not known to work again.
      report.sources[i] = { ...entry, status: "error", error: before.error };
      report.errors.push(`${entry.id}: ${before.error}`);
      continue;
    }
    if (before.status !== "held" && before.status !== "review") continue;
    report.sources[i] = { ...entry, status: before.status, held: before.held };
    report.held.push(...(last.held ?? []).filter((held) => held.source === entry.id));
    for (const pending of last.pending ?? [])
      if (
        pending.source === entry.id &&
        !report.pending.some((now) => now.source === entry.id && now.skill === pending.skill)
      )
        report.pending.push(pending);
  }
}

/** Runs each hook whose `on` patterns match a changed `<source>:<file>`; the report JSON goes to stdin. */
async function runHooks(
  loaded: LoadedManifest,
  results: SourceResult[],
  report: Report,
): Promise<HookRun[]> {
  const changed = results.flatMap((result) =>
    result.changed.map((file) => ({ source: result.id, file })),
  );
  const runs: HookRun[] = [];
  for (const hook of loaded.root.hooks) {
    const matched = changed
      .filter(({ source, file }) =>
        hook.on.some((pattern) => {
          const { id, glob } = splitPattern(pattern);
          return (id === "*" || id === source) && matchesGlob(file, glob);
        }),
      )
      .map(({ source, file }) => `${source}:${file}`);
    if (matched.length === 0) continue;
    const run = await exec(hook.run, [], {
      shell: true,
      input: JSON.stringify(report),
      env: { ...process.env, SKILLFLEET_HOOK: hook.name, SKILLFLEET_CHANGED: matched.join("\n") },
      timeoutMs: HOOK_TIMEOUT_MS,
      maxOutput: 8000,
    });
    const output = `${run.stdout}${run.stderr}`;
    runs.push({
      name: hook.name,
      matched,
      code: run.code,
      output: run.timedOut
        ? `${output.slice(-7900)}\nstopped after ${HOOK_TIMEOUT_MS / 60_000} minutes`
        : output.slice(-8000),
    });
  }
  return runs;
}

/** The skill of the same source that `name` renames, when the two differ only in case or Unicode form. */
function renamedFrom(
  state: State,
  winners: ReadonlyMap<string, DesiredLink>,
  name: string,
): string | undefined {
  if (state.skills[name]) return undefined;
  return Object.keys(state.skills).find(
    (old) =>
      !winners.has(old) &&
      nameKey(old) === nameKey(name) &&
      state.skills[old]!.source === winners.get(name)?.source,
  );
}

function recordSkills(
  state: State,
  winners: Map<string, DesiredLink>,
  results: SourceResult[],
  now: string,
): boolean {
  let changed = false;
  const touched = new Set(
    results.flatMap((result) =>
      [...result.updated, ...result.added].map((skill) => `${result.id}/${skill}`),
    ),
  );
  const clonesChanged = new Set(
    results
      .filter(
        (result) =>
          result.changed.length > 0 && (result.kind === "clone" || result.kind === "local"),
      )
      .map((result) => result.id),
  );
  for (const [name, link] of winners) {
    const record = state.skills[name];
    if (!record) {
      // Renamed only in case or Unicode form: the same skill, so it keeps when it arrived.
      const old = renamedFrom(state, winners, name);
      const addedAt = old === undefined ? now : state.skills[old]!.addedAt;
      state.skills[name] = { source: link.source, dir: link.target, addedAt, changedAt: now };
      changed = true;
    } else if (
      record.dir !== link.target ||
      touched.has(`${link.source}/${name}`) ||
      clonesChanged.has(link.source)
    ) {
      Object.assign(record, { source: link.source, dir: link.target, changedAt: now });
      changed = true;
    }
  }
  for (const name of Object.keys(state.skills)) {
    if (winners.has(name)) continue;
    delete state.skills[name];
    changed = true;
  }
  return changed;
}

async function postToHub(hub: string, report: Report): Promise<string | undefined> {
  try {
    const response = await fetch(hub, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(report),
      signal: AbortSignal.timeout(15_000),
    });
    return response.ok ? undefined : `hub ${hub} answered ${response.status}`;
  } catch (error) {
    return `hub ${hub}: ${(error as Error).message}`;
  }
}

export async function sync(options: SyncOptions = {}): Promise<Report> {
  const startedAt = new Date().toISOString();
  const dryRun = options.dryRun ?? false;
  const offline = options.offline ?? false;
  const scratch = dryRun ? mkdtempSync(join(tmpdir(), "skillfleet-dry-")) : undefined;
  const lock = dryRun ? { release: () => {} } : acquireLock();
  if (!dryRun) sweepJsonTemps();
  const warnings: string[] = lock.note ? [lock.note] : [];
  // Every download and command has its own timeout; this bounds the whole run, so a sync stuck
  // anyway lets go of the lock and says so, and the next timer run starts over.
  let doing = "loading the manifest";
  const limit = syncTimeoutMs();
  const watchdog = setTimeout(() => {
    stopAll();
    lock.release();
    process.stderr.write(
      `skillfleet: the sync was stopped after ${limit >= 60_000 ? `${Math.round(limit / 60_000)} minutes` : `${limit / 1000} s`} while ${doing}; its lock is released, and the next sync starts over\n`,
    );
    process.exit(1);
  }, limit);
  watchdog.unref();
  try {
    // A remote manifest's file is a cache copy (a scratch one in a dry run), so reports name its spec.
    const spec = options.loaded ? options.loaded.root.file : manifestSpec(options.manifest);
    const loaded =
      options.loaded ??
      (await loadManifest(spec, {
        offline,
        ...(scratch ? { cacheRoot: join(scratch, "manifests") } : {}),
      }));
    if (options.only && !loaded.sources.some((source) => source.id === options.only))
      throw new ManifestError(`no source "${options.only}" in the manifest`);
    const state = loadState(dryRun ? undefined : warnings);
    const targets = await agentTargets(loaded.root.agents);
    const adoptionErrors: string[] = [];
    // Before the sources look for local edits, so they find the ones made in a copy.
    warnings.push(
      ...adoptCopyEdits(
        targets.map((target) => target.dir),
        dryRun,
        adoptionErrors,
      ),
    );
    // Skills linked last time, by source: what a source that fails, or can't be read, keeps.
    const lastLinked = (id: string) =>
      Object.entries(state.skills)
        .filter(([, record]) => record.source === id && existsSync(record.dir))
        .map(([name, record]) => ({ name, dir: record.dir }));
    const backupRoot = join(paths.backup(), startedAt.replace(/[:.]/g, "-"));
    const results: SourceResult[] = [];
    for (const source of loaded.sources) {
      const before = state.sources[source.id];
      if (before && isVendoredKind(before.kind) && !isVendoredKind(source.kind)) {
        // Linked in place now: the vendored copies go, and edited ones are kept in the backup.
        const why = `${source.id} is a ${source.kind === "clone" ? "working clone" : "local folder"} now`;
        if (dryRun) warnings.push(`${why}; sync removes its vendored copies`);
        else
          try {
            warnings.push(...retireStore(source.id, state, backupRoot, why));
          } catch (error) {
            warnings.push(`${why}, but its vendored copies stay: ${errorText(error)}`);
          }
      }
      const ctx = {
        offline: offline || (options.only !== undefined && options.only !== source.id),
        offlineRequested: offline,
        dryRun,
        apply: options.apply === source.id,
        cacheDir: scratch ?? paths.cache(),
        storeDir: paths.store(source.id),
        now: startedAt,
      };
      doing = `fetching ${source.id}`;
      try {
        results.push(await syncSource(source, sourceState(state, source), ctx));
      } catch (error) {
        results.push({ ...failedResult(source, errorText(error)), skills: lastLinked(source.id) });
      }
    }

    // Sources in the state that the manifest no longer declares.
    const carried: DesiredLink[] = [];
    const missing = Object.keys(state.sources).filter(
      (id) => !loaded.sources.some((source) => source.id === id),
    );
    if (missing.length > 0 && loaded.failed?.length) {
      // An extended manifest did not load, so these may still be declared there: keep them.
      for (const id of missing)
        for (const skill of lastLinked(id))
          carried.push({ name: skill.name, target: skill.dir, source: id });
      warnings.push(
        `kept ${missing.join(", ")} as last synced, because ${loaded.failed.join(", ")} did not load`,
      );
    } else if (!dryRun) {
      for (const id of missing)
        try {
          warnings.push(
            ...retireStore(id, state, backupRoot, `${id} is no longer in the manifest`),
          );
        } catch (error) {
          warnings.push(
            `${id} is no longer in the manifest, but its store stays: ${errorText(error)}`,
          );
        }
    }

    // First source with a name wins; later ones are shadowed. Names that differ only by case or
    // Unicode normalization count as one, since macOS and Windows keep them in one folder.
    const winners = new Map<string, DesiredLink>();
    const byKey = new Map<string, DesiredLink>();
    const shadowed: Report["shadowed"] = [];
    for (const result of results) {
      for (const skill of result.skills) {
        const winner = byKey.get(nameKey(skill.name));
        if (winner) {
          if (winner.source !== result.id)
            shadowed.push({ skill: skill.name, winner: winner.source, loser: result.id });
          continue;
        }
        const link: DesiredLink = {
          name: skill.name,
          target: skill.dir,
          source: result.id,
          ...(skill.root ? { root: skill.root } : {}),
        };
        winners.set(skill.name, link);
        byKey.set(nameKey(skill.name), link);
      }
    }
    for (const link of carried)
      if (!byKey.has(nameKey(link.name))) {
        winners.set(link.name, link);
        byKey.set(nameKey(link.name), link);
      }

    if (targets.length === 0)
      warnings.push(
        loaded.root.agents === "all"
          ? 'no agent is installed here, so no skills were linked: "agents": "all" means every agent whose folder is in your home, such as ~/.claude for Claude Code. Install one, or name agents in the manifest (`skillfleet agents` lists the ids)'
          : "none of the manifest's agents has a global skills folder, so no skills were linked",
      );
    const desired = [...winners.values()];
    doing = "linking skills into agent folders";
    // One folder that can't be written must not stop the others.
    const linkInto = (dir: string, links: DesiredLink[]): TargetReport => {
      try {
        return linkTargetDir(dir, links, { copy: options.copy, dryRun });
      } catch (error) {
        return {
          dir,
          created: [],
          replaced: [],
          removed: [],
          foreign: [],
          warnings: [],
          errors: [`${tildify(dir)}: ${errorText(error)}`],
        };
      }
    };
    const targetReports = targets.map((target) => linkInto(target.dir, desired));
    // Links skillfleet made in folders it no longer links into are removed. A folder that is a
    // link, or another path to a current target, is left alone.
    const real = (dir: string) => {
      let path = dir;
      try {
        if (existsSync(dir)) path = realpathSync.native(dir);
      } catch {
        // Windows opens the folder to resolve it, which an ACL that denies writing refuses; the
        // folder is still reported by the link step.
      }
      return process.platform === "win32" ? path.toLowerCase() : path;
    };
    const current = new Set(targets.map((target) => real(target.dir)));
    for (const dir of formerTargets(targets)) {
      if (!lstat(dir)?.isDirectory() || current.has(real(dir))) continue;
      if (!existsSync(join(dir, MANIFEST_FILE))) continue;
      const former = linkInto(dir, []);
      former.former = true;
      targetReports.push(former);
      if (!dryRun && Object.keys(readTargetManifest(dir).links).length === 0)
        rmSync(join(dir, MANIFEST_FILE), { force: true });
    }

    // Skills linked in place keep their SKILL.md as it is, and a link there is skipped by these.
    const strict = Object.entries(SKIP_LINKED_SKILL_MD)
      .filter(([id]) => targets.some((target) => target.agents.includes(id)))
      .map(([, name]) => name);
    if (strict.length > 0 && !options.copy)
      for (const result of results) {
        if (result.kind !== "local" && result.kind !== "clone") continue;
        for (const skill of result.skills)
          if (
            winners.get(skill.name)?.source === result.id &&
            lstat(join(skill.dir, "SKILL.md"))?.isSymbolicLink()
          )
            warnings.push(
              `${result.id}: ${strict.join(" and ")} won't load ${skill.name}: its SKILL.md is a symlink (${tildify(join(skill.dir, "SKILL.md"))}); make it a regular file, or sync with --copy`,
            );
      }

    // Upstream changes to forks, said once; and a fork shadowing its source is what forking meant.
    const forks =
      dryRun || offline
        ? { updates: [], warnings: [] }
        : await checkForks(loaded, results, state, paths.cache());
    const forked = new Set(Object.keys(loaded.root.forks).map(nameKey));
    const sourceWon = (result: SourceResult, skill: string) =>
      winners.get(skill)?.source === result.id;
    const report: Report = {
      version: 1,
      host: hostname(),
      skillfleet: version,
      manifest: remoteManifest(spec) ? spec : loaded.root.file,
      startedAt,
      finishedAt: startedAt,
      dryRun,
      offline,
      ok: true,
      sources: results.map(({ skills: _skills, ...rest }) => rest),
      skills: {
        total: winners.size,
        names: [...winners.keys()].sort(),
        added: [...new Set(targetReports.flatMap((target) => target.created))].sort(),
        removed: [...new Set(targetReports.flatMap((target) => target.removed))].sort(),
        updated: [
          ...new Set(
            results.flatMap((result) => result.updated.filter((skill) => sourceWon(result, skill))),
          ),
        ].sort(),
      },
      shadowed: shadowed.filter((entry) => !forked.has(nameKey(entry.skill))),
      renamed: [...winners.keys()].flatMap((name) => {
        const from = renamedFrom(state, winners, name);
        return from === undefined ? [] : [{ from, to: name }];
      }),
      edited: results.flatMap((result) =>
        result.edited.map((entry) => ({ source: result.id, ...entry })),
      ),
      held: results.flatMap((result) =>
        result.held ? [{ source: result.id, ...result.held }] : [],
      ),
      pending: [
        ...results.flatMap((result) =>
          result.pending.map((entry) => ({ source: result.id, ...entry })),
        ),
        ...forks.updates.map((update) => ({ ...update, reason: "fork" as const })),
      ],
      targets: targetReports,
      hooks: [],
      warnings: [
        ...warnings,
        ...forks.warnings,
        ...loaded.warnings,
        ...results.flatMap((result) => result.warnings),
        ...(await unmatchedHooks(loaded, results)),
      ],
      errors: [
        ...adoptionErrors,
        ...results.flatMap((result) => (result.error ? [`${result.id}: ${result.error}`] : [])),
        ...targetReports.flatMap((target) => target.errors),
      ],
    };
    if (options.only) carryOver(report, options.only);
    if (!dryRun) {
      doing = "running hooks";
      report.hooks = await runHooks(loaded, results, report);
      for (const hook of report.hooks)
        if (hook.code !== 0) report.errors.push(`hook ${hook.name} exited with ${hook.code}`);
      if (recordSkills(state, winners, results, startedAt)) state.lastChange = startedAt;
      saveState(state);
    }
    report.ok = report.errors.length === 0;
    report.finishedAt = new Date().toISOString();
    if (!dryRun) {
      writeJson(paths.lastRun(), report);
      if (loaded.root.report) {
        const run = await exec(loaded.root.report.run, [], {
          shell: true,
          input: JSON.stringify(report),
          timeoutMs: 120_000,
        });
        if (run.code !== 0)
          report.warnings.push(
            `report.run exited with ${run.code}: ${(run.stderr || run.stdout).trim()}`,
          );
      }
      if (loaded.root.hub) {
        const failed = await postToHub(loaded.root.hub, report);
        if (failed) report.warnings.push(failed);
      }
      if (report.warnings.length) writeJson(paths.lastRun(), report);
    }
    return report;
  } finally {
    clearTimeout(watchdog);
    lock.release();
    if (scratch) rmSync(scratch, { recursive: true, force: true });
  }
}

/**
 * An edited copy in an agent folder (`--copy`) is an edit of its skill: the files it changed go
 * into the folder it was copied from, the store or the folder linked in place, so every agent
 * shows the edit, sync holds upstream changes for it, and `status`, `diff` and `merge` find it.
 * When that folder changed too since the copy was made, both stay as they are and the link step
 * warns. Returns what to tell the user.
 */
function adoptCopyEdits(dirs: readonly string[], dryRun: boolean, errors: string[]): string[] {
  const said: string[] = [];
  for (const dir of dirs) {
    if (!existsSync(join(dir, MANIFEST_FILE))) continue;
    try {
      const manifest = readTargetManifest(dir);
      let changed = false;
      for (const [name, record] of Object.entries(manifest.links)) {
        if (record.kind !== "copy" || !record.hashes) continue;
        const copy = join(dir, name);
        try {
          if (!lstat(copy)?.isDirectory() || !lstat(record.target)?.isDirectory()) continue;
          const now = hashDir(copy);
          const files = changedFiles(record.hashes, now);
          if (files.length === 0) continue;
          if (!sameTree(resolvedHashes(record.target, record.root), record.hashes)) continue;
          // A link moves as the file it points to, and a linked SKILL.md in place stays a link.
          const linked = (path: string) => lstat(path)?.isSymbolicLink();
          if (files.some((file) => linked(join(copy, file)) || linked(join(record.target, file))))
            continue;
          if (dryRun) {
            said.push(
              `would move the edits in ${tildify(copy)} (${files.join(", ")}) into ${tildify(record.target)}, which every agent shows`,
            );
            continue;
          }
          for (const file of files) {
            const to = join(record.target, file);
            if (now[file] === undefined) rmSync(to, { force: true });
            else {
              mkdirSync(dirname(to), { recursive: true });
              copyFileSync(join(copy, file), to);
            }
          }
          record.hashes = now;
          changed = true;
          said.push(
            `${tildify(copy)} had local edits (${files.join(", ")}); they are now edits of ${name} in ${tildify(record.target)}, which every agent shows`,
          );
        } catch (error) {
          said.push(
            `${tildify(copy)} has local edits that could not be moved: ${errorText(error)}`,
          );
        }
      }
      if (changed) writeJson(join(dir, MANIFEST_FILE), manifest);
    } catch (error) {
      errors.push(`${tildify(dir)}: could not adopt copied edits: ${errorText(error)}`);
    }
  }
  return said;
}

/**
 * Forgets the vendored copies of a source the manifest no longer declares, or no longer vendors
 * (`why` says which). Every copy in the store moves to the backup folder first when it has local
 * edits, or has no install record to tell: a sync killed before it saved state.json leaves copies
 * without one, which the user may have edited since. Unedited ones are deleted with the store.
 * Returns what to tell the user.
 */
function retireStore(id: string, state: State, backupRoot: string, why: string): string[] {
  const said: string[] = [];
  const store = paths.store(id);
  const records = state.sources[id]?.skills ?? {};
  const liveDir = join(store, "live");
  const onDisk = existsSync(liveDir) ? readdirSync(liveDir) : [];
  for (const name of onDisk) {
    const live = join(liveDir, name);
    if (!lstat(live)?.isDirectory()) continue;
    const record = Object.hasOwn(records, name) ? records[name] : undefined;
    const files = record ? changedFiles(record.hashes, hashDir(live)) : [];
    if (record && files.length === 0) continue;
    const to = join(backupRoot, id, name);
    moveDir(live, to);
    said.push(
      record
        ? `${why}; ${name} had local edits (${files.join(", ")}), so it was moved to ${tildify(to)}`
        : `${why}; ${name} had no install record to tell whether it was edited, so it was moved to ${tildify(to)}`,
    );
  }
  rmSync(store, { recursive: true, force: true });
  delete state.sources[id];
  return said;
}
