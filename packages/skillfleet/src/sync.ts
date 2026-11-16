import { execFileSync } from "node:child_process";
import {
  existsSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { hostname, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { agentTargets } from "./agents.ts";
import { exec } from "./exec.ts";
import { changedFiles, hashDir, isErrno, isRecord, moveDir, writeJson } from "./fs.ts";
import { matchesGlob } from "./glob.ts";
import { type DesiredLink, errorText, linkTargetDir, type TargetReport } from "./linker.ts";
import { type LoadedManifest, loadManifest, ManifestError, readConfig } from "./manifest.ts";
import { nameKey, segmentProblem } from "./names.ts";
import { paths, tildify } from "./paths.ts";
import type { HookRun, Report } from "./report.ts";
import { failedResult, type SourceResult, storePaths, syncSource } from "./sources.ts";
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

/** No sync takes this long; a lock older than this was left by one that hung or was killed. */
const LOCK_MAX_AGE_MS = 2 * 60 * 60 * 1000;

interface LockHolder {
  pid: number;
  /** The script the holder runs, to tell it from another program that got its pid. */
  script?: string;
  at: number;
}

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
  // Locks written before 0.0.1 hold just the pid.
  if (typeof raw === "number") return { text, holder: { pid: raw, at: mtime } };
  if (isRecord(raw) && typeof raw.pid === "number")
    return {
      text,
      holder: {
        pid: raw.pid,
        script: typeof raw.script === "string" ? raw.script : undefined,
        at: typeof raw.at === "number" ? raw.at : mtime,
      },
    };
  return { text, holder: { pid: 0, at: mtime } };
}

/** The command line of a running process, or undefined when the OS does not tell. */
function commandLine(pid: number): string | undefined {
  try {
    if (process.platform === "linux")
      return readFileSync(`/proc/${pid}/cmdline`, "utf8").split("\0").join(" ");
    if (process.platform === "win32")
      // Only runs when a lock names a live pid, so the second PowerShell takes is acceptable.
      return execFileSync(
        "powershell.exe",
        [
          "-NoProfile",
          "-NonInteractive",
          "-Command",
          `(Get-CimInstance Win32_Process -Filter "ProcessId=${pid}").CommandLine`,
        ],
        {
          encoding: "utf8",
          stdio: ["ignore", "pipe", "ignore"],
          timeout: 20_000,
          windowsHide: true,
        },
      );
    return execFileSync("ps", ["-o", "command=", "-p", String(pid)], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 5000,
    });
  } catch {}
  return undefined;
}

/** Why a lock no longer guards a running sync, or undefined while it does. */
function staleBecause(holder: LockHolder): string | undefined {
  const { pid } = holder;
  if (!(pid > 0) || pid === process.pid) return `it names no running sync`;
  try {
    process.kill(pid, 0);
  } catch (error) {
    if (!isErrno(error, "EPERM")) return `its sync (pid ${pid}) is gone`;
  }
  if (Date.now() - holder.at > LOCK_MAX_AGE_MS) return `it is more than two hours old`;
  // An empty answer means the OS would not say, not that the command line is empty.
  const command = commandLine(pid)?.trim() || undefined;
  const script = holder.script ?? process.argv[1];
  // Windows paths compare without case.
  const fold = (text: string) => (process.platform === "win32" ? text.toLowerCase() : text);
  if (command !== undefined && script && !fold(command).includes(fold(script)))
    return `pid ${pid} is now another program`;
  return undefined;
}

/** Takes the sync lock atomically; a stale lock is moved aside first. Returns the release and a note. */
function acquireLock(): { release: () => void; note?: string } {
  const file = paths.lock();
  mkdirSync(dirname(file), { recursive: true });
  const mine = JSON.stringify({ pid: process.pid, script: process.argv[1], at: Date.now() });
  const release = () => {
    if (readLock(file)?.text === mine) rmSync(file, { force: true });
  };
  let note: string | undefined;
  for (let attempt = 0; attempt < 5; attempt++) {
    if (create(file, mine)) return { release, note };
    const lock = readLock(file);
    if (!lock) continue;
    const reason = staleBecause(lock.holder);
    if (!reason) throw new Error(`another skillfleet sync is running (pid ${lock.holder.pid})`);
    // Move it aside, then check it is still the lock judged stale: another sync may have broken
    // it and taken a fresh one in between, and that one goes back.
    const aside = `${file}.${process.pid}.stale`;
    try {
      renameSync(file, aside);
    } catch (error) {
      if (isErrno(error, "ENOENT")) continue;
      throw error;
    }
    const moved = readFileSync(aside, "utf8");
    if (moved !== lock.text) {
      try {
        linkSync(aside, file);
      } catch {}
      rmSync(aside, { force: true });
      continue;
    }
    rmSync(aside, { force: true });
    note = `removed a stale sync lock: ${reason}`;
  }
  throw new Error(`could not take the sync lock ${tildify(file)}`);
}

/** Creates `file` with `text` only if it does not exist, never leaving it half written. */
function create(file: string, text: string): boolean {
  const temp = `${file}.${process.pid}.tmp`;
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

/** Hooks run while the sync holds its lock, so a stuck one is stopped after this long. */
const HOOK_TIMEOUT_MS = 5 * 60_000;

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
          const at = pattern.indexOf(":");
          const id = at < 0 ? "*" : pattern.slice(0, at);
          const glob = at < 0 ? pattern : pattern.slice(at + 1);
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
      state.skills[name] = { source: link.source, dir: link.target, addedAt: now, changedAt: now };
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
  const warnings: string[] = lock.note ? [lock.note] : [];
  try {
    const loaded =
      options.loaded ??
      (await loadManifest(manifestSpec(options.manifest), {
        offline,
        ...(scratch ? { cacheRoot: join(scratch, "manifests") } : {}),
      }));
    if (options.only && !loaded.sources.some((source) => source.id === options.only))
      throw new ManifestError(`no source "${options.only}" in the manifest`);
    const state = loadState(dryRun ? undefined : warnings);
    // Skills linked last time, by source: what a source that fails, or can't be read, keeps.
    const lastLinked = (id: string) =>
      Object.entries(state.skills)
        .filter(([, record]) => record.source === id && existsSync(record.dir))
        .map(([name, record]) => ({ name, dir: record.dir }));
    const results: SourceResult[] = [];
    for (const source of loaded.sources) {
      const ctx = {
        offline: offline || (options.only !== undefined && options.only !== source.id),
        offlineRequested: offline,
        dryRun,
        apply: options.apply === source.id,
        cacheDir: scratch ?? paths.cache(),
        storeDir: paths.store(source.id),
        now: startedAt,
      };
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
      const backupRoot = join(paths.backup(), startedAt.replace(/[:.]/g, "-"));
      for (const id of missing)
        try {
          warnings.push(...removeSource(id, state, backupRoot));
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
        const link = { name: skill.name, target: skill.dir, source: result.id };
        winners.set(skill.name, link);
        byKey.set(nameKey(skill.name), link);
      }
    }
    for (const link of carried)
      if (!byKey.has(nameKey(link.name))) {
        winners.set(link.name, link);
        byKey.set(nameKey(link.name), link);
      }

    const targets = await agentTargets(loaded.root.agents);
    const desired = [...winners.values()];
    // One folder that can't be written must not stop the others.
    const targetReports = targets.map((target): TargetReport => {
      try {
        return linkTargetDir(target.dir, desired, { copy: options.copy, dryRun });
      } catch (error) {
        return {
          dir: target.dir,
          created: [],
          replaced: [],
          removed: [],
          foreign: [],
          warnings: [],
          errors: [`${tildify(target.dir)}: ${errorText(error)}`],
        };
      }
    });

    const sourceWon = (result: SourceResult, skill: string) =>
      winners.get(skill)?.source === result.id;
    const report: Report = {
      version: 1,
      host: hostname(),
      skillfleet: version,
      manifest: loaded.root.file,
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
      shadowed,
      edited: results.flatMap((result) =>
        result.edited.map((entry) => ({ source: result.id, ...entry })),
      ),
      held: results.flatMap((result) =>
        result.held ? [{ source: result.id, ...result.held }] : [],
      ),
      pending: results.flatMap((result) =>
        result.pending.map((entry) => ({ source: result.id, ...entry })),
      ),
      targets: targetReports,
      hooks: [],
      warnings: [...warnings, ...loaded.warnings, ...results.flatMap((result) => result.warnings)],
      errors: [
        ...results.flatMap((result) => (result.error ? [`${result.id}: ${result.error}`] : [])),
        ...targetReports.flatMap((target) => target.errors),
      ],
    };
    if (!dryRun) {
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
    lock.release();
    if (scratch) rmSync(scratch, { recursive: true, force: true });
  }
}

/**
 * Forgets a source the manifest no longer declares. Vendored copies with local edits move to the
 * backup folder first; unedited ones are deleted with the store. Returns what to tell the user.
 */
function removeSource(id: string, state: State, backupRoot: string): string[] {
  const said: string[] = [];
  const store = paths.store(id);
  for (const [name, copy] of Object.entries(state.sources[id]?.skills ?? {})) {
    // A name that is not one plain folder name was never written by this version.
    if (segmentProblem(name)) continue;
    const live = storePaths(store, name).live;
    if (!existsSync(live)) continue;
    const files = changedFiles(copy.hashes, hashDir(live));
    if (files.length === 0) continue;
    const to = join(backupRoot, id, name);
    moveDir(live, to);
    said.push(
      `${id} is no longer in the manifest; ${name} had local edits (${files.join(", ")}), so it was moved to ${tildify(to)}`,
    );
  }
  rmSync(store, { recursive: true, force: true });
  delete state.sources[id];
  return said;
}
