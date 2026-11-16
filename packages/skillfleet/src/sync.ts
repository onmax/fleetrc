import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import { agentTargets } from "./agents.ts";
import { exec } from "./exec.ts";
import { writeJson } from "./fs.ts";
import { matchesGlob } from "./glob.ts";
import { type DesiredLink, linkTargetDir } from "./linker.ts";
import { type LoadedManifest, loadManifest, ManifestError, readConfig } from "./manifest.ts";
import { paths } from "./paths.ts";
import type { HookRun, Report } from "./report.ts";
import { type SourceResult, syncSource } from "./sources.ts";
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

function acquireLock(): () => void {
  const file = paths.lock();
  if (existsSync(file)) {
    const pid = Number(readFileSync(file, "utf8"));
    let alive = false;
    try {
      if (pid > 0) process.kill(pid, 0);
      alive = pid > 0;
    } catch {}
    if (alive && pid !== process.pid)
      throw new Error(`another skillfleet sync is running (pid ${pid})`);
  }
  writeJson(file, process.pid);
  return () => rmSync(file, { force: true });
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
      timeoutMs: 10 * 60_000,
    });
    const output = `${run.stdout}${run.stderr}`;
    runs.push({
      name: hook.name,
      matched,
      code: run.code,
      output: output.length > 8000 ? output.slice(-8000) : output,
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
  const release = dryRun ? () => {} : acquireLock();
  try {
    const loaded =
      options.loaded ??
      (await loadManifest(manifestSpec(options.manifest), {
        offline,
        ...(scratch ? { cacheRoot: join(scratch, "manifests") } : {}),
      }));
    if (options.only && !loaded.sources.some((source) => source.id === options.only))
      throw new ManifestError(`no source "${options.only}" in the manifest`);
    const state = loadState();
    const results: SourceResult[] = [];
    for (const source of loaded.sources) {
      const ctx = {
        offline: offline || (options.only !== undefined && options.only !== source.id),
        dryRun,
        apply: options.apply === source.id,
        cacheDir: scratch ?? paths.cache(),
        storeDir: paths.store(source.id),
        now: startedAt,
      };
      results.push(await syncSource(source, sourceState(state, source), ctx));
    }
    for (const id of Object.keys(state.sources))
      if (!loaded.sources.some((source) => source.id === id) && !dryRun) {
        rmSync(paths.store(id), { recursive: true, force: true });
        delete state.sources[id];
      }

    // First source with a name wins; later ones are shadowed.
    const winners = new Map<string, DesiredLink>();
    const shadowed: Report["shadowed"] = [];
    for (const result of results) {
      for (const skill of result.skills) {
        const winner = winners.get(skill.name);
        if (winner) {
          if (winner.source !== result.id)
            shadowed.push({ skill: skill.name, winner: winner.source, loser: result.id });
          continue;
        }
        winners.set(skill.name, { name: skill.name, target: skill.dir, source: result.id });
      }
    }

    const targets = await agentTargets(loaded.root.agents);
    const desired = [...winners.values()];
    const targetReports = targets.map((target) =>
      linkTargetDir(target.dir, desired, { copy: options.copy, dryRun }),
    );

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
      warnings: [...loaded.warnings, ...results.flatMap((result) => result.warnings)],
      errors: results.flatMap((result) => (result.error ? [`${result.id}: ${result.error}`] : [])),
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
    release();
    if (scratch) rmSync(scratch, { recursive: true, force: true });
  }
}
