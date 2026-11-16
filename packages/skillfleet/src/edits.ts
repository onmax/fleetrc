import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { UserError } from "./errors.ts";
import { git, GitError } from "./exec.ts";
import { copyDir, hashDir, isRecord, lstat, moveDir } from "./fs.ts";
import { fetchClone, gitUrl, repoKey } from "./gitcache.ts";
import { globBase } from "./glob.ts";
import {
  defaultSourceId,
  editManifest,
  type InPlaceSource,
  isVendored,
  type Fork,
  loadManifest,
  type LoadedManifest,
  remoteManifest,
  type Source,
} from "./manifest.ts";
import { paths, tildify } from "./paths.ts";
import { storePaths } from "./sources.ts";
import { loadState, saveState, type State } from "./state.ts";

/** The file a command changes: the root manifest, or a working clone of the repository it is in. */
export interface ManifestTarget {
  file: string;
  /** The file is in a working clone: the change reaches this machine once it is pushed. */
  push: boolean;
}

/**
 * The file `add`, `remove`, `fleet add`, `fork` and `merge` change. A manifest kept in a git
 * repository is read from a cached copy that the next fetch resets, so it is changed only in a
 * working clone of that repository (a source with a `path`); the change then reaches this machine
 * once it is pushed. Without such a clone the command stops and says what to change upstream.
 */
export function manifestToEdit(
  loaded: LoadedManifest,
  spec: string,
  change: string,
): ManifestTarget {
  const remote = remoteManifest(spec);
  if (!remote) return { file: loaded.root.file, push: false };
  const key = repoKey(remote.repo);
  for (const source of loaded.root.sources)
    if (source.kind === "clone" && repoKey(source.git) === key) {
      const file = join(source.path, remote.path);
      if (existsSync(file)) return { file, push: true };
    }
  throw new UserError(
    `the manifest is a copy of the repository ${gitUrl(remote.repo)}, which the next sync fetches again, so skillfleet does not change it. ${change} in ${remote.path} there and push it, or clone it as a source with a "path" to let skillfleet edit the clone.`,
  );
}

interface Located {
  loaded: LoadedManifest;
  state: State;
  name: string;
  source: Source;
}

async function locate(spec: string, name: string): Promise<Located> {
  const loaded = await loadManifest(spec, { offline: true });
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

/** One side of a diff: a folder (missing reads as empty) and the name its files get in the patch. */
interface Side {
  dir: string;
  label: "local" | "upstream";
}

/**
 * The patch from one copy of skill `name` to another. Both are copied into a scratch folder first,
 * so the headers read `local/<name>/SKILL.md` rather than store paths.
 */
async function diffDirs(name: string, from: Side, to: Side): Promise<string> {
  const scratch = mkdtempSync(join(tmpdir(), "skillfleet-diff-"));
  try {
    for (const side of [from, to]) {
      const copy = join(scratch, side.label, name);
      if (existsSync(side.dir)) copyDir(side.dir, copy);
      else mkdirSync(copy, { recursive: true });
    }
    const args = [
      "-c",
      "core.quotepath=off",
      "diff",
      "--no-index",
      "--no-color",
      "--no-prefix",
      "--",
      `${from.label}/${name}`,
      `${to.label}/${name}`,
    ];
    const result = await git(args, { cwd: scratch, allowFail: true });
    if (result.code !== 0 && result.code !== 1) throw new GitError(args, result);
    return result.stdout;
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

async function forkUpstream(fork: { from: string; path: string }, ref?: string) {
  const clone = await fetchClone(gitUrl(fork.from), ref, join(paths.cache(), "forks"));
  return { dir: join(clone.dir, fork.path), commit: clone.commit };
}

/** A vendored skill's pending update against the copy in use, or else its local edits. */
function diffVendored(state: State, source: Source, name: string): Promise<string> {
  const store = storePaths(paths.store(source.id), name);
  if (state.sources[source.id]?.pending[name])
    return diffDirs(
      name,
      { dir: store.live, label: "local" },
      { dir: store.upstream, label: "upstream" },
    );
  return diffDirs(
    name,
    { dir: store.base, label: "upstream" },
    { dir: store.live, label: "local" },
  );
}

/** `skillfleet diff <skill>`: local edits against upstream, or a pending update against what is installed. */
export async function diffSkill(spec: string, name: string): Promise<string> {
  const { loaded, state, source } = await locate(spec, name);
  const fork = loaded.root.forks[name];
  if (fork) {
    const upstream = await forkUpstream(fork);
    const local = state.skills[name]!.dir;
    return diffDirs(name, { dir: upstream.dir, label: "upstream" }, { dir: local, label: "local" });
  }
  if (!isVendored(source))
    throw new UserError(
      `${name} comes from ${source.id}, a folder you edit in place; use git there`,
    );
  return diffVendored(state, source, name);
}

/**
 * `skillfleet diff`: every update a source is holding, as the last sync left them. A vendored
 * source holds skills one by one; a working clone in review mode holds the commits it has not
 * merged from its upstream branch.
 */
export async function diffPending(spec: string): Promise<string> {
  const loaded = await loadManifest(spec, { offline: true });
  const state = loadState();
  const parts: string[] = [];
  for (const source of loaded.sources) {
    if (isVendored(source))
      for (const name of Object.keys(state.sources[source.id]?.pending ?? {}).sort())
        parts.push(await diffVendored(state, source, name));
    else if (source.kind === "clone" && source.update === "review" && existsSync(source.path)) {
      const run = await git(["-c", "core.quotepath=off", "diff", "--no-color", "HEAD", "@{u}"], {
        cwd: source.path,
        allowFail: true,
      });
      if (run.code === 0) parts.push(run.stdout);
    }
  }
  return parts.join("");
}

interface MergeResult {
  merged: string[];
  conflicts: string[];
}

/**
 * Three-way merge of one folder: `base` to `upstream` changes applied onto `live`, file by file.
 * A dry run works out the same result and writes nothing.
 */
async function mergeTrees(
  live: string,
  base: string,
  upstream: string,
  dryRun: boolean,
): Promise<MergeResult> {
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
      if (!dryRun && u === undefined) rmSync(target, { force: true });
      else if (!dryRun) {
        mkdirSync(dirname(target), { recursive: true });
        writeFileSync(target, u!);
      }
      result.merged.push(file);
      continue;
    }
    if (l === undefined || u === undefined || b === undefined) {
      // Added or deleted on one side and changed on the other: keep the local file, put upstream's beside it.
      if (u !== undefined && !dryRun) writeFileSync(`${target}.upstream`, u);
      result.conflicts.push(file);
      continue;
    }
    const scratch = mkdtempSync(join(tmpdir(), "skillfleet-merge-"));
    try {
      writeFileSync(join(scratch, "base"), b);
      writeFileSync(join(scratch, "upstream"), u);
      // -p prints the merge instead of writing it into the local file.
      const merge = await git(
        [
          "merge-file",
          ...(dryRun ? ["-p"] : []),
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
export async function mergeSkill(
  spec: string,
  name: string,
  { dryRun = false } = {},
): Promise<MergeResult & { into: string; manifest?: ManifestTarget }> {
  const { loaded, state, source } = await locate(spec, name);
  const fork = loaded.root.forks[name];
  if (fork) {
    const head = await forkUpstream(fork);
    const base = await forkUpstream(fork, fork.base);
    const live = state.skills[name]!.dir;
    // Where the new base is recorded, checked before the merge touches a file.
    const manifest = manifestToEdit(
      loaded,
      spec,
      `Set "base" of "forks"."${name}" to "${head.commit}"`,
    );
    const result = await mergeTrees(live, base.dir, head.dir, dryRun);
    editManifest(
      manifest.file,
      (raw) => {
        const entry = isRecord(raw.forks) ? raw.forks[name] : undefined;
        if (isRecord(entry)) entry.base = head.commit;
      },
      { dryRun },
    );
    return { ...result, into: live, manifest };
  }
  if (!isVendored(source))
    throw new UserError(
      `${name} comes from ${source.id}, a folder you edit in place; use git there`,
    );
  const store = storePaths(paths.store(source.id), name);
  const sourceState = state.sources[source.id]!;
  if (!existsSync(store.upstream))
    throw new UserError(`${name} has no upstream change to merge; \`skillfleet sync\` fetches one`);
  const result = await mergeTrees(store.live, store.base, store.upstream, dryRun);
  if (dryRun) return { ...result, into: store.live };
  copyDir(store.upstream, store.base);
  sourceState.skills[name] = { ...sourceState.skills[name], hashes: hashDir(store.upstream) };
  rmSync(store.upstream, { recursive: true, force: true });
  delete sourceState.pending[name];
  saveState(state);
  return { ...result, into: store.live };
}

/** What `fork` did, or would do in a dry run. */
export interface Forked {
  name: string;
  /** The copy skillfleet kept, which moves into the personal source. */
  from: string;
  to: string;
  fork: Fork;
  manifest: ManifestTarget;
}

/** `skillfleet fork <skill>`: moves a vendored skill into the personal repository and records where it came from. */
export async function forkSkill(
  spec: string,
  name: string,
  { dryRun = false } = {},
): Promise<Forked> {
  const { loaded, state, source } = await locate(spec, name);
  if (!isVendored(source)) throw new UserError(`${name} already lives in ${source.id}`);
  const personal = personalSource(loaded.sources);
  if (!personal)
    throw new UserError("no personal source: mark a git source with a path as `adopt: true`");
  const to = join(personalSkillsDir(personal), name);
  if (lstat(to)) throw new UserError(`${tildify(to)} already exists`);
  const store = storePaths(paths.store(source.id), name);
  if (!existsSync(store.live))
    throw new UserError(`${name} has no copy on this machine yet; run \`skillfleet sync\``);
  const sourceState = state.sources[source.id]!;
  const fork: Fork = {
    from:
      source.kind === "git"
        ? source.git
        : source.kind === "index"
          ? source.index
          : `npm:${source.npm}`,
    path: sourceState.skills[name]?.path ?? name,
    base: source.kind === "npm" ? (sourceState.version ?? "") : (sourceState.commit ?? ""),
  };
  const excluded = source.origin === loaded.root.file;
  const manifest = manifestToEdit(
    loaded,
    spec,
    `Add ${JSON.stringify({ [name]: fork })} to "forks"${excluded ? ` and "${name}" to "exclude" of the source "${source.id}"` : ""}`,
  );
  const change = (raw: Record<string, unknown>) => {
    raw.forks = { ...(isRecord(raw.forks) ? raw.forks : {}), [name]: fork };
    if (excluded && Array.isArray(raw.sources)) {
      const entry = raw.sources.find(
        (candidate: unknown) =>
          isRecord(candidate) && (candidate.id ?? defaultSourceId(candidate)) === source.id,
      );
      if (isRecord(entry)) {
        const exclude = Array.isArray(entry.exclude) ? entry.exclude : [];
        entry.exclude = [...new Set([...exclude, name])];
      }
    }
  };
  // Check the manifest takes the change before anything moves.
  editManifest(manifest.file, change, { dryRun: true });
  const result = { name, from: store.live, to, fork, manifest };
  if (dryRun) return result;
  copyDir(store.live, to);
  editManifest(manifest.file, change);
  for (const dir of Object.values(store)) rmSync(dir, { recursive: true, force: true });
  delete sourceState.skills[name];
  delete sourceState.pending[name];
  saveState(state);
  return result;
}

/** `skillfleet adopt <path>`: moves a hand-made skill folder into the personal repository. */
export async function adoptSkill(
  spec: string,
  path: string,
  { dryRun = false } = {},
): Promise<{ to: string; name: string }> {
  const loaded = await loadManifest(spec, { offline: true });
  const stat = lstat(path);
  if (!stat?.isDirectory() || !existsSync(join(path, "SKILL.md")))
    throw new UserError(`${tildify(path)} is not a skill folder (a real folder with a SKILL.md)`);
  const personal = personalSource(loaded.sources);
  if (!personal)
    throw new UserError("no personal source: mark a git source with a path as `adopt: true`");
  const name = basename(path);
  const to = join(personalSkillsDir(personal), name);
  if (lstat(to)) throw new UserError(`${tildify(to)} already exists`);
  if (!dryRun) moveDir(path, to);
  return { to, name };
}
