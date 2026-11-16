import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { exec, git } from "./exec.ts";
import { copyDir, hashDir, isRecord, lstat, moveDir } from "./fs.ts";
import { fetchClone, gitUrl } from "./gitcache.ts";
import { globBase } from "./glob.ts";
import {
  defaultSourceId,
  editManifest,
  type InPlaceSource,
  isVendored,
  loadManifest,
  type LoadedManifest,
  type Source,
} from "./manifest.ts";
import { paths, tildify } from "./paths.ts";
import { storePaths } from "./sources.ts";
import { loadState, saveState, type State } from "./state.ts";
import { manifestSpec } from "./sync.ts";

export class UserError extends Error {}

interface Located {
  loaded: LoadedManifest;
  state: State;
  name: string;
  source: Source;
}

async function locate(name: string): Promise<Located> {
  const loaded = await loadManifest(manifestSpec(), { offline: true });
  const state = loadState();
  // A linked skill, or one a review-mode source is holding back.
  const owner =
    state.skills[name]?.source ??
    Object.entries(state.sources).find(([, source]) => source.pending[name])?.[0];
  const source = loaded.sources.find((candidate) => candidate.id === owner);
  if (!source) throw new UserError(`no skill "${name}" is linked; run \`skillfleet list\``);
  return { loaded, state, name, source };
}

/** The source that `fork` and `adopt` move skills into: the first in-place source marked `adopt`, else the first clone. */
export function personalSource(sources: readonly Source[]): InPlaceSource | undefined {
  const inPlace = sources.filter(
    (source): source is InPlaceSource => source.kind === "clone" || source.kind === "local",
  );
  return (
    inPlace.find((source) => source.adopt) ?? inPlace.find((source) => source.kind === "clone")
  );
}

/** Folder where a personal source keeps skills: the base of its `skills` glob. */
export function personalSkillsDir(source: InPlaceSource): string {
  const root = source.kind === "clone" ? source.path : source.local;
  const base = source.skills ? globBase(source.skills) : "skills";
  return base ? join(root, base) : root;
}

async function diffDirs(a: string, b: string): Promise<string> {
  const result = await exec("git", ["diff", "--no-index", "--no-color", "--", a, b]);
  if (result.code !== 0 && result.code !== 1) throw new UserError(result.stderr.trim());
  return result.stdout;
}

async function forkUpstream(fork: { from: string; path: string }, ref?: string) {
  const clone = await fetchClone(gitUrl(fork.from), ref, join(paths.cache(), "forks"));
  return { dir: join(clone.dir, fork.path), commit: clone.commit };
}

/** `skillfleet diff <skill>`: local edits against upstream, or a pending update against what is installed. */
export async function diffSkill(name: string): Promise<string> {
  const { loaded, state, source } = await locate(name);
  const fork = loaded.root.forks[name];
  if (fork) {
    const upstream = await forkUpstream(fork);
    const local = state.skills[name]!.dir;
    return diffDirs(upstream.dir, local);
  }
  if (!isVendored(source))
    throw new UserError(
      `${name} comes from ${source.id}, a folder you edit in place; use git there`,
    );
  const store = storePaths(paths.store(source.id), name);
  const empty = mkdtempSync(join(tmpdir(), "skillfleet-empty-"));
  const or = (dir: string) => (existsSync(dir) ? dir : empty);
  try {
    if (state.sources[source.id]?.pending[name])
      return await diffDirs(or(store.live), or(store.upstream));
    return await diffDirs(or(store.base), or(store.live));
  } finally {
    rmSync(empty, { recursive: true, force: true });
  }
}

interface MergeResult {
  merged: string[];
  conflicts: string[];
}

/** Three-way merge of one folder: `base` to `upstream` changes applied onto `live`, file by file. */
async function mergeTrees(live: string, base: string, upstream: string): Promise<MergeResult> {
  const files = new Set([
    ...Object.keys(hashDir(live)),
    ...Object.keys(hashDir(base)),
    ...Object.keys(hashDir(upstream)),
  ]);
  const read = (dir: string, file: string) =>
    existsSync(join(dir, file)) ? readFileSync(join(dir, file)) : undefined;
  const same = (a: Buffer | undefined, b: Buffer | undefined) =>
    a === undefined || b === undefined ? a === b : a.equals(b);
  const result: MergeResult = { merged: [], conflicts: [] };
  for (const file of [...files].sort()) {
    const b = read(base, file);
    const l = read(live, file);
    const u = read(upstream, file);
    const target = join(live, file);
    if (same(u, b) || same(l, u)) continue;
    if (same(l, b)) {
      if (u === undefined) rmSync(target, { force: true });
      else {
        mkdirSync(dirname(target), { recursive: true });
        writeFileSync(target, u);
      }
      result.merged.push(file);
      continue;
    }
    if (l === undefined || u === undefined || b === undefined) {
      // Added or deleted on one side and changed on the other: keep the local file, put upstream's beside it.
      if (u !== undefined) writeFileSync(`${target}.upstream`, u);
      result.conflicts.push(file);
      continue;
    }
    const scratch = mkdtempSync(join(tmpdir(), "skillfleet-merge-"));
    try {
      writeFileSync(join(scratch, "base"), b);
      writeFileSync(join(scratch, "upstream"), u);
      const merge = await git(
        [
          "merge-file",
          "-L",
          "local",
          "-L",
          "base",
          "-L",
          "upstream",
          target,
          join(scratch, "base"),
          join(scratch, "upstream"),
        ],
        {
          allowFail: true,
        },
      );
      if (merge.code === 0) result.merged.push(file);
      else if (merge.code !== null && merge.code > 0) result.conflicts.push(file);
      else throw new UserError(`git merge-file ${file}: ${merge.stderr.trim()}`);
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  }
  return result;
}

/** `skillfleet merge <skill>`: brings upstream changes into an edited copy or a fork. */
export async function mergeSkill(name: string): Promise<MergeResult & { into: string }> {
  const { loaded, state, source } = await locate(name);
  const fork = loaded.root.forks[name];
  if (fork) {
    const head = await forkUpstream(fork);
    const base = await forkUpstream(fork, fork.base);
    const live = state.skills[name]!.dir;
    const result = await mergeTrees(live, base.dir, head.dir);
    editManifest(loaded.root.file, (raw) => {
      const entry = isRecord(raw.forks) ? raw.forks[name] : undefined;
      if (isRecord(entry)) entry.base = head.commit;
    });
    return { ...result, into: live };
  }
  if (!isVendored(source))
    throw new UserError(
      `${name} comes from ${source.id}, a folder you edit in place; use git there`,
    );
  const store = storePaths(paths.store(source.id), name);
  const sourceState = state.sources[source.id]!;
  if (!existsSync(store.upstream))
    throw new UserError(`${name} has no upstream change to merge; \`skillfleet sync\` fetches one`);
  const result = await mergeTrees(store.live, store.base, store.upstream);
  copyDir(store.upstream, store.base);
  sourceState.skills[name] = { ...sourceState.skills[name], hashes: hashDir(store.upstream) };
  rmSync(store.upstream, { recursive: true, force: true });
  delete sourceState.pending[name];
  saveState(state);
  return { ...result, into: store.live };
}

/** `skillfleet fork <skill>`: moves a vendored skill into the personal repository and records where it came from. */
export async function forkSkill(name: string): Promise<{ to: string }> {
  const { loaded, state, source } = await locate(name);
  if (!isVendored(source)) throw new UserError(`${name} already lives in ${source.id}`);
  const personal = personalSource(loaded.sources);
  if (!personal)
    throw new UserError("no personal source: mark a git source with a path as `adopt: true`");
  const to = join(personalSkillsDir(personal), name);
  if (lstat(to)) throw new UserError(`${tildify(to)} already exists`);
  const store = storePaths(paths.store(source.id), name);
  const sourceState = state.sources[source.id]!;
  copyDir(store.live, to);
  const from =
    source.kind === "git"
      ? source.git
      : source.kind === "index"
        ? source.index
        : `npm:${source.npm}`;
  const base = source.kind === "npm" ? (sourceState.version ?? "") : (sourceState.commit ?? "");
  editManifest(loaded.root.file, (raw) => {
    raw.forks = {
      ...(isRecord(raw.forks) ? raw.forks : {}),
      [name]: { from, path: sourceState.skills[name]?.path ?? name, base },
    };
    if (source.origin === loaded.root.file && Array.isArray(raw.sources)) {
      const entry = raw.sources.find(
        (candidate: unknown) =>
          isRecord(candidate) && (candidate.id ?? defaultSourceId(candidate)) === source.id,
      );
      if (isRecord(entry)) {
        const exclude = Array.isArray(entry.exclude) ? entry.exclude : [];
        entry.exclude = [...new Set([...exclude, name])];
      }
    }
  });
  for (const dir of Object.values(store)) rmSync(dir, { recursive: true, force: true });
  delete sourceState.skills[name];
  delete sourceState.pending[name];
  saveState(state);
  return { to };
}

/** `skillfleet adopt <path>`: moves a hand-made skill folder into the personal repository. */
export async function adoptSkill(path: string): Promise<{ to: string; name: string }> {
  const loaded = await loadManifest(manifestSpec(), { offline: true });
  const stat = lstat(path);
  if (!stat?.isDirectory() || !existsSync(join(path, "SKILL.md")))
    throw new UserError(`${tildify(path)} is not a skill folder (a real folder with a SKILL.md)`);
  const personal = personalSource(loaded.sources);
  if (!personal)
    throw new UserError("no personal source: mark a git source with a path as `adopt: true`");
  const name = basename(path);
  const to = join(personalSkillsDir(personal), name);
  if (lstat(to)) throw new UserError(`${tildify(to)} already exists`);
  moveDir(path, to);
  return { to, name };
}
