import {
  chmodSync,
  closeSync,
  existsSync,
  fchmodSync,
  fstatSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  renameSync,
  rmSync,
  rmdirSync,
  statSync,
  type Dirent,
  type Stats,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, posix, relative, sep } from "node:path";
import { UserError } from "./errors.ts";
import { git, GitError } from "./exec.ts";
import {
  changedFiles,
  changedModes,
  copyDir,
  copyExecuteBits,
  hashDir,
  inside,
  isErrno,
  isMergeScratch,
  isRecord,
  lstat,
  mergeRecoveryPointer,
  mergeWorkspaceReceipt,
  moveDir,
  readMergeRecoveryPointer,
  registerMergeWorkspace,
  sha256,
} from "./fs.ts";
import { itemName, itemPath, parseItemId } from "./files.ts";
import { fetchClone, gitUrl, isCommitRef, repoKey } from "./gitcache.ts";
import { globBase } from "./glob.ts";
import {
  checkedOutPath,
  defaultSourceId,
  editManifest,
  type InPlaceSource,
  isVendored,
  type Fork,
  loadManifest,
  type LoadedManifest,
  remoteManifest,
  teamGitProblem,
  type Source,
} from "./manifest.ts";
import { findName } from "./names.ts";
import { paths, tildify } from "./paths.ts";
import { pendingGitBase, storePaths } from "./sources.ts";
import type { ItemKind } from "./kinds.ts";
import {
  loadState,
  saveState,
  type InstalledCopy,
  type PendingUpdate,
  type State,
} from "./state.ts";

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
  // The file the manifest was read from, which may be the old name's default (legacy.ts).
  const path = checkedOutPath(remote.path, loaded.root.file);
  const key = repoKey(remote.repo);
  for (const source of loaded.root.sources)
    if (source.kind === "clone" && repoKey(source.git) === key) {
      const file = join(source.path, path);
      if (existsSync(file)) return { file, push: true };
    }
  throw new UserError(
    `the manifest is a copy of the repository ${gitUrl(remote.repo)}, which the next sync fetches again, so fleetrc does not change it. ${change} in ${path} there and push it, or clone it as a source with a "path" to let fleetrc edit the clone.`,
  );
}

interface Located {
  loaded: LoadedManifest;
  state: State;
  /** The skill's name as fleetrc keeps it, which may differ from the typed one in case or Unicode form. */
  name: string;
  source: Source;
  /** The skill's entry under "forks", by the key the manifest gives it. */
  fork?: { key: string; fork: Fork };
  /** For a file (`<kind>/<path>`): its kind, and its folder's name in the store. */
  item?: { kind: ItemKind; key: string };
}

/**
 * An instruction file, subagent or command by its id, `<kind>/<path>`: prefer an active link,
 * then a pending update, then a retained installed copy.
 */
function locateItem(loaded: LoadedManifest, state: State, typed: string): Located | undefined {
  const parsed = parseItemId(typed);
  if (!parsed) return undefined;
  const key = itemName(parsed.path);
  const linked = new Set(
    Object.values(state.links ?? {})
      .filter((record) => record.item === typed)
      .map((record) => record.source),
  );
  const active = loaded.sources.filter((source) => linked.has(source.id));
  const withRecord = (record: "pending" | "items") =>
    loaded.sources.filter(
      (source) =>
        (source.kind === "git" || source.kind === "npm") &&
        Object.hasOwn(state.sources[source.id]?.files?.[parsed.kind]?.[record] ?? {}, key),
    );
  const pending = active.length > 0 ? active : withRecord("pending");
  const candidates = pending.length > 0 ? pending : withRecord("items");
  if (candidates.length > 1)
    throw new UserError(
      `${typed} is ambiguous: it comes from ${candidates.map((source) => source.id).join(", ")}`,
    );
  const [source] = candidates;
  if (!source)
    throw new UserError(`no file "${typed}" is linked, pending or retained; run \`fleetrc list\``);
  return { loaded, state, name: typed, source, item: { kind: parsed.kind, key } };
}

/** Where a vendored skill or file is kept: its folders in the store and its records. */
function kept(state: State, source: Source, located: Pick<Located, "name" | "item">) {
  const sourceState = state.sources[source.id];
  const files = located.item ? sourceState?.files?.[located.item.kind] : undefined;
  const records: { skills: Record<string, InstalledCopy>; pending: Record<string, PendingUpdate> } =
    located.item
      ? { skills: files?.items ?? {}, pending: files?.pending ?? {} }
      : { skills: sourceState?.skills ?? {}, pending: sourceState?.pending ?? {} };
  const key = located.item?.key ?? located.name;
  const storeDir = located.item
    ? join(paths.store(source.id), located.item.kind)
    : paths.store(source.id);
  // A file's patch names it `<kind>/<path>`, its folder in the store holding only the file.
  const label = located.item
    ? posix.join(located.item.kind, posix.dirname(itemPath(located.item.key)))
    : located.name;
  return { records, key, store: storePaths(storeDir, key), label };
}

async function locate(spec: string, typed: string): Promise<Located> {
  const loaded = await loadManifest(spec, { offline: true });
  const state = loadState();
  const item = locateItem(loaded, state, typed);
  if (item) return item;
  // A linked skill, or one a review-mode source is holding back.
  const name =
    findName(
      [
        ...Object.keys(state.skills),
        ...Object.values(state.sources).flatMap((source) => Object.keys(source.pending)),
      ],
      typed,
    ) ?? typed;
  const owner =
    state.skills[name]?.source ??
    Object.entries(state.sources).find(([, source]) => source.pending[name])?.[0];
  const source = loaded.sources.find((candidate) => candidate.id === owner);
  if (!source) throw new UserError(`no skill "${typed}" is linked; run \`fleetrc list\``);
  const key = findName(Object.keys(loaded.root.forks), name);
  const fork = key === undefined ? undefined : { key, fork: loaded.root.forks[key]! };
  return { loaded, state, name, source, fork };
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

/**
 * Throws unless `path`, where it exists, resolves inside the folder `root`: a link in a repository
 * may lead anywhere on this machine, and fleetrc reads and writes only inside it. Where `path`
 * does not exist yet, its nearest existing folder is checked, which is where it would be made.
 */
export function confine(root: string, path: string, what = "it") {
  if (!existsSync(root)) return;
  let existing = path;
  while (!lstat(existing) && dirname(existing) !== existing) existing = dirname(existing);
  let real: string | undefined;
  try {
    real = realpathSync(existing);
  } catch (error) {
    if (!isErrno(error, "ENOENT", "ELOOP")) throw error;
  }
  if (real === undefined || !inside(realpathSync(root), real))
    throw new UserError(
      `${tildify(path)} leads out of ${tildify(root)} through a link, so fleetrc does not ${what}`,
    );
}

/**
 * Where `fork` and `adopt` put the skill `name`: in the personal source's skills folder, which must
 * not lead out of a working clone, since its links come from whoever pushes to the repository.
 */
export function personalDestination(source: InPlaceSource, name: string, what: string): string {
  const to = join(personalSkillsDir(source), name);
  if (source.kind === "clone") confine(source.path, to, what);
  return to;
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
  const scratch = mkdtempSync(join(tmpdir(), "fleetrc-diff-"));
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

function forkGitSource(loaded: LoadedManifest, fork: Fork) {
  return loaded.sources.find(
    (candidate) => candidate.kind === "git" && repoKey(candidate.git) === repoKey(fork.from),
  );
}

function nonGitFork(loaded: LoadedManifest, fork: Fork): boolean {
  if (fork.from.startsWith("npm:")) return true;
  if (fork.upstream !== undefined) return fork.upstream === "index";
  return (
    loaded.sources.some((source) => source.kind === "index" && source.index === fork.from) &&
    !(isCommitRef(fork.base ?? "") && forkGitSource(loaded, fork))
  );
}

/** Index and npm forks have no Git history to compare with. */
function gitFork(loaded: LoadedManifest, name: string, fork: Fork) {
  if (nonGitFork(loaded, fork))
    throw new UserError(
      `${name} was forked from ${fork.from}, which is not a git repository, so fleetrc has no upstream version to compare with; compare by hand, or fork it again from a git source`,
    );
}

/** The fork's folder in its upstream repository, which must not lead out of the repository. */
async function forkUpstream(fork: { from: string; path: string }, ref?: string, team = false) {
  const clone = await fetchClone(gitUrl(fork.from), ref, join(paths.cache(), "forks"), {
    check: team ? teamGitProblem : undefined,
  });
  const dir = join(clone.dir, fork.path);
  confine(clone.dir, dir, `read it as the fork's upstream`);
  return { dir, commit: clone.commit };
}

/** Resolves a fork's base, with recovery guidance for the old importer's placeholder. */
async function forkBase(fork: Fork, key: string, team = false): Promise<string | undefined> {
  if (fork.base === undefined) return undefined;
  try {
    return (await forkUpstream(fork, fork.base, team)).dir;
  } catch (error) {
    if (
      fork.base === "unknown" &&
      error instanceof GitError &&
      error.result.stderr.split(/\r?\n/).includes("fatal: couldn't find remote ref unknown")
    )
      throw new UserError(
        `the upstream has no ref named "unknown"; if an older fleetrc imported this fork without a known base, remove "base" from "forks".${JSON.stringify(key)} in your manifest and run \`fleetrc merge ${key}\` again`,
      );
    throw error;
  }
}

function forkRepositoryLabel(from: string): string {
  if (/^[a-z][\w+.-]*:\/\//i.test(from)) {
    try {
      const url = new URL(from);
      url.username = "";
      url.password = "";
      url.search = "";
      url.hash = "";
      return url.href;
    } catch {
      return "upstream repository";
    }
  }
  if (from.includes("::") || from.includes("://")) return "upstream repository";
  return from.replace(/^[^@/:\\]+@(?=[^/:\\]+:)/, "");
}

/** A fork that changed upstream, as a sync reports it. */
export interface ForkUpdate {
  /** Where the fork came from: its source's id, or a credential-free repository label. */
  source: string;
  skill: string;
  files: string[];
}

/** Where a fork's upstream folder is now: the commit, and the folder at that commit. */
interface ForkHead {
  source: string;
  commit: string;
  team: boolean;
  dir: () => Promise<string>;
}

const FORK_TREE_VERSION = "v2:";

/**
 * Compares each fork's `base` with the skill's folder at the commit upstream has now, and records
 * what it found in `state.forks`. Returns the forks whose upstream moved since the last sync that
 * looked, so a sync says so once; `status` says it until the fork is merged. A fork of a git
 * source in the manifest reads the commit that source synced to, and keeps what was found before
 * when that source did not update this run. A full online sync also checks standalone Git forks
 * with known Git provenance. Legacy forks with ambiguous origins are not fetched automatically.
 */
export async function checkForks(
  loaded: LoadedManifest,
  results: readonly { id: string; status: string; to?: string }[],
  state: State,
  cacheDir: string,
  fetchStandalone: boolean,
): Promise<{ updates: ForkUpdate[]; warnings: string[] }> {
  const updates: ForkUpdate[] = [];
  const warnings: string[] = [];
  const forks = (state.forks ??= {});
  const couldNotTell = (name: string, reason: string) =>
    warnings.push(`could not tell whether ${name} changed upstream since you forked it: ${reason}`);
  for (const name of Object.keys(forks)) if (!(name in loaded.root.forks)) delete forks[name];
  for (const [name, fork] of Object.entries(loaded.root.forks)) {
    if (nonGitFork(loaded, fork)) continue;
    let head: ForkHead;
    const source = forkGitSource(loaded, fork);
    if (source?.kind === "git") {
      const result = results.find((candidate) => candidate.id === source.id);
      if (!result?.to || result.status === "error") continue;
      head = {
        source: source.id,
        commit: result.to,
        team: source.via !== undefined,
        async dir() {
          const now = await fetchClone(gitUrl(source.git), source.ref, join(cacheDir, "git"), {
            offline: true,
          });
          const dir = join(now.dir, fork.path);
          confine(now.dir, dir, "read it as the fork's upstream");
          return dir;
        },
      };
    } else {
      if (
        !fetchStandalone ||
        (fork.upstream !== "git" &&
          gitUrl(fork.from) === fork.from &&
          !isCommitRef(fork.base ?? ""))
      )
        continue;
      try {
        const upstream = await forkUpstream(fork);
        head = {
          source: forkRepositoryLabel(fork.from),
          commit: upstream.commit,
          team: false,
          dir: async () => upstream.dir,
        };
      } catch {
        couldNotTell(name, "could not fetch or read the upstream skill");
        continue;
      }
    }
    const known = forks[name];
    if (
      known &&
      known.base === fork.base &&
      known.upstream === head.commit &&
      known.tree.startsWith(FORK_TREE_VERSION)
    )
      continue;
    let files: string[] = [];
    let tree = FORK_TREE_VERSION;
    let legacyTree: string | undefined;
    // Without a base, nothing is known to be in common, so every upstream file counts as changed.
    if (fork.base === undefined || !head.commit.startsWith(fork.base.toLowerCase()))
      try {
        const base = await forkBase(fork, name, head.team);
        const dir = await head.dir();
        const upstream = hashDir(dir);
        const modes = executables(dir);
        const modeChanges = changedModes(base ? executables(base) : [], modes);
        const contentChanges = changedFiles(base ? hashDir(base) : {}, upstream);
        files = [...new Set([...contentChanges, ...modeChanges])].sort();
        tree += sha256(JSON.stringify([upstream, modes]));
        if (base === undefined || modeChanges.length === 0)
          legacyTree = sha256(JSON.stringify(upstream));
      } catch {
        couldNotTell(name, "could not compare the upstream skill with the recorded base");
        continue;
      }
    forks[name] = {
      ...(fork.base === undefined ? {} : { base: fork.base }),
      upstream: head.commit,
      tree,
      files,
    };
    // Said once for each new upstream version of the skill, not on every sync.
    if (
      files.length > 0 &&
      (!known || known.base !== fork.base || (known.tree !== tree && known.tree !== legacyTree))
    )
      updates.push({ source: head.source, skill: name, files });
  }
  return { updates, warnings };
}

/** What `status` says of forks that need a first merge or have upstream changes. */
export function forkLines(state: State, loaded?: LoadedManifest): string[] {
  const forks = loaded?.root.forks;
  const mergeable = (name: string) =>
    loaded === undefined || (forks?.[name] !== undefined && !nonGitFork(loaded, forks[name]));
  const missing = Object.entries(forks ?? state.forks ?? {})
    .filter(([name, fork]) => fork.base === undefined && mergeable(name))
    .map(
      ([name]) =>
        `${name}: no recorded merge base; \`fleetrc diff ${name}\` / \`fleetrc merge ${name}\``,
    );
  const changed = Object.entries(state.forks ?? {})
    .filter(
      ([name, fork]) =>
        fork.base !== undefined &&
        fork.files.length > 0 &&
        mergeable(name) &&
        (forks === undefined || forks[name]?.base === fork.base),
    )
    .map(
      ([name]) =>
        `${name}: upstream changed since you forked it; \`fleetrc diff ${name}\` / \`fleetrc merge ${name}\``,
    );
  return [...missing, ...changed];
}

/**
 * The files of a merge's conflicts that are not resolved yet: they still hold git's markers, or
 * upstream's side still sits beside them as `<file>.upstream`.
 */
export function unresolvedFiles(conflict: {
  dir: string;
  files: readonly string[];
  markers?: Record<string, string>;
}): string[] {
  return conflict.files.filter((file) => {
    const path = join(conflict.dir, file);
    // A conflict git's markers can't show is open while the file merge put beside it is there.
    const marker = conflict.markers?.[file];
    if (marker !== undefined) return lstat(join(conflict.dir, marker)) !== undefined;
    if (lstat(`${path}.upstream`)) return true;
    try {
      if (!lstat(path)?.isFile()) return false;
      const text = readFileSync(path, "utf8");
      return /^<<<<<<< local\r?$/m.test(text) && /^>>>>>>> upstream\r?$/m.test(text);
    } catch {
      return false;
    }
  });
}

/** What `status` and a sync say of each skill a merge left conflicts in. */
export function conflictLines(state: State): string[] {
  return Object.entries(state.conflicts ?? {}).flatMap(([name, conflict]) => {
    const files = unresolvedFiles(conflict);
    return files.length === 0
      ? []
      : [
          `${name}: unresolved merge conflicts in ${files.join(", ")} (${tildify(conflict.dir)}); resolve them, then run \`fleetrc merge ${name}\``,
        ];
  });
}

/** A vendored skill's or file's pending update against the copy in use, or else its local edits. */
function diffVendored(
  state: State,
  source: Source,
  located: Pick<Located, "name" | "item">,
): Promise<string> {
  const { records, key, store, label } = kept(state, source, located);
  if (Object.hasOwn(records.pending, key))
    return diffDirs(
      label,
      { dir: store.live, label: "local" },
      { dir: store.upstream, label: "upstream" },
    );
  return diffDirs(
    label,
    { dir: store.base, label: "upstream" },
    { dir: store.live, label: "local" },
  );
}

/** `fleetrc diff <skill>`: local edits against upstream, or a pending update against what is installed. */
export async function diffSkill(spec: string, typed: string): Promise<string> {
  const { loaded, state, source, name, fork, item } = await locate(spec, typed);
  if (fork) {
    gitFork(loaded, name, fork.fork);
    const upstream = await forkUpstream(fork.fork);
    const local = state.skills[name]!.dir;
    return diffDirs(name, { dir: upstream.dir, label: "upstream" }, { dir: local, label: "local" });
  }
  if (!isVendored(source))
    throw new UserError(
      `${name} comes from ${source.id}, a folder you edit in place; use git there`,
    );
  return diffVendored(state, source, { name, item });
}

/**
 * `fleetrc diff`: every update a source is holding, as the last sync left them. A vendored
 * source holds skills one by one; a working clone in review mode holds the commits it has not
 * merged from its upstream branch.
 */
export async function diffPending(spec: string): Promise<string> {
  const loaded = await loadManifest(spec, { offline: true });
  const state = loadState();
  const parts: string[] = [];
  for (const source of loaded.sources) {
    if (isVendored(source)) {
      for (const name of Object.keys(state.sources[source.id]?.pending ?? {}).sort())
        parts.push(await diffVendored(state, source, { name }));
      for (const [kind, files] of Object.entries(state.sources[source.id]?.files ?? {}))
        for (const key of Object.keys(files.pending).sort())
          parts.push(
            await diffVendored(state, source, {
              name: `${kind}/${itemPath(key)}`,
              item: { kind: kind as ItemKind, key },
            }),
          );
    } else if (source.kind === "clone" && source.update === "review" && existsSync(source.path)) {
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
  /** For each conflict git's markers can't show, the file merge wrote beside it, relative to the copy. */
  markers?: Record<string, string>;
  /** The conflicts an earlier merge left were resolved, and this merge recorded that. */
  resolved?: boolean;
}

/** A file in one tree of a merge: its bytes, or the target of a link, which merge never follows. */
type Content = Buffer | { link: string };

const sameContent = (a: Content | undefined, b: Content | undefined) => {
  if (a === undefined || b === undefined) return a === b;
  if (Buffer.isBuffer(a) || Buffer.isBuffer(b))
    return Buffer.isBuffer(a) && Buffer.isBuffer(b) && a.equals(b);
  return a.link === b.link;
};

/** The first of `file`'s folders under `dir` that is a link, `/`-separated, or undefined. */
function linkedFolder(dir: string, file: string): string | undefined {
  const parts = file.split("/").slice(0, -1);
  for (let i = 1; i <= parts.length; i++) {
    const folder = parts.slice(0, i).join("/");
    if (lstat(join(dir, folder))?.isSymbolicLink()) return folder;
  }
  return undefined;
}

/** Whether git takes `data` for binary: a NUL byte in its first 8000 bytes. */
const binary = (data: Buffer) => data.subarray(0, 8000).includes(0);

/** `file` in the tree `dir`, read without following a link; one inside a linked folder reads as that link. */
function readContent(dir: string, file: string): Content | undefined {
  const folder = linkedFolder(dir, file);
  if (folder !== undefined) return { link: readlinkSync(join(dir, folder)) };
  const path = join(dir, file);
  const stat = lstat(path);
  if (stat?.isSymbolicLink()) return { link: readlinkSync(path) };
  return stat?.isFile() ? readFileSync(path) : undefined;
}

function writeMergeFile(path: string, content: Buffer, bits: number, flag: "w" | "wx") {
  if (bits === 0) {
    writeFileSync(path, content, { flag });
    return;
  }
  const fd = openSync(path, flag);
  try {
    writeFileSync(fd, content);
    fchmodSync(fd, (fstatSync(fd).mode & 0o666) | bits);
  } finally {
    closeSync(fd);
  }
}

/**
 * Writes upstream's side of a conflict beside the local file, at `<file>.upstream`, or
 * `<file>.upstream.<n>` when that is taken: created, never overwritten, and never through a link.
 */
function writeSidecar(target: string, content: Buffer, suffix = ".upstream", bits = 0): string {
  for (let n = 0; ; n++) {
    const path = n === 0 ? `${target}${suffix}` : `${target}${suffix}.${n}`;
    try {
      writeMergeFile(path, content, bits, "wx");
      return path;
    } catch (error) {
      if (!isErrno(error, "EEXIST")) throw error;
    }
  }
}

const mergeExecuteBits = (entry: Stats | undefined) =>
  process.platform !== "win32" && entry?.isFile() ? entry.mode & 0o111 : 0;

function mergeSnapshot(dir: string | undefined) {
  const entries = new Map<string, Dirent>();
  const hashes: ReturnType<typeof hashDir> = dir === undefined ? {} : hashDir(dir, entries);
  const modes = new Map<string, number>();
  if (dir !== undefined && process.platform !== "win32") {
    for (const [path, entry] of entries) {
      if (!entry.isFile()) continue;
      const bits = mergeExecuteBits(lstat(join(dir, path)));
      if (bits !== 0) modes.set(path, bits);
    }
  }
  return { entries, hashes, modes };
}

const mergeScratchPrefix = (live: string) => `.fleetrc-merge-${sha256(basename(live))}-`;
const savedMergeUnit = (scratch: string) => join(scratch, "previous", "unit");
const mergeIncoming = (scratch: string) => join(scratch, "incoming");
const mergeIdentity = (entry: Stats) => `${entry.dev}:${entry.ino}:${entry.birthtimeMs}`;

const mergeInventory = ({ entries, hashes, modes }: ReturnType<typeof mergeSnapshot>) =>
  [...entries.keys()].sort().map((path) => {
    const entry = [path, entries.get(path)!.isDirectory(), hashes[path]] as const;
    const bits = modes.get(path);
    return bits === undefined ? entry : ([...entry, bits] as const);
  });
const mergeFingerprint = (snapshot: ReturnType<typeof mergeSnapshot>) =>
  sha256(JSON.stringify(mergeInventory(snapshot)));

/** Preserve an ambiguous directory, or remove it only if the filesystem confirms it is empty. */
function preserveUnconfirmedDirectory(target: string) {
  const backupRoot = paths.backup();
  mkdirSync(backupRoot, { recursive: true });
  const backup = mkdtempSync(join(backupRoot, "merge-unconfirmed-"));
  const preserved = join(backup, basename(target));
  try {
    renameSync(target, preserved);
  } catch (error) {
    rmdirSync(backup);
    if (isErrno(error, "EXDEV")) {
      try {
        rmdirSync(target);
        return;
      } catch (removeError) {
        throw new Error(`cannot preserve ${target} across filesystems; left it in place`, {
          cause: removeError,
        });
      }
    }
    throw new Error(`cannot move ${target} safely to ${preserved}; left it in place`, {
      cause: error,
    });
  }
  process.stderr.write(`merge: preserving unconfirmed directory ${target} at ${preserved}\n`);
}

/** Fill an empty or partially installed unit, accepting only entries made by this transaction. */
function publishMergeUnit(scratch: string, unit: string, target: string) {
  const dirs = join(scratch, "dirs");
  mkdirSync(dirs, { recursive: true });
  const put = (from: string, to: string) => {
    const entry = lstat(from)!;
    let dest = lstat(to);
    const occupied = () => new Error(`${to} is occupied by another entry`);
    if (!entry.isDirectory()) {
      if (dest === undefined) linkSync(from, to);
      else if (mergeIdentity(dest) !== mergeIdentity(entry)) throw occupied();
      return;
    }
    const record = join(dirs, sha256(relative(unit, from)));
    const intent = `${record}.creating`;
    if (dest?.isDirectory() && !existsSync(record) && existsSync(intent)) {
      if (readdirSync(to).length > 0) throw occupied();
      preserveUnconfirmedDirectory(to);
      dest = undefined;
    }
    if (dest === undefined) {
      if (existsSync(record)) throw occupied();
      writeFileSync(intent, "");
      try {
        mkdirSync(to, { mode: 0o700 });
      } catch (error) {
        rmSync(intent);
        throw error;
      }
      const temporary = `${record}.tmp`;
      writeFileSync(temporary, mergeIdentity(lstat(to)!));
      renameSync(temporary, record);
    } else if (
      !dest.isDirectory() ||
      !existsSync(record) ||
      readFileSync(record, "utf8") !== mergeIdentity(dest)
    ) {
      throw occupied();
    }
    const children = new Set(readdirSync(from));
    if (readdirSync(to).some((name) => !children.has(name))) throw occupied();
    for (const name of children) put(join(from, name), join(to, name));
    chmodSync(to, entry.mode & 0o7777);
  };
  put(unit, target);
}

function cleanMergeScratch(scratch: string) {
  function makeRemovable(dir: string) {
    const entry = lstat(dir);
    if (!entry?.isDirectory()) return;
    if ((entry.mode & 0o700) !== 0o700) chmodSync(dir, entry.mode | 0o700);
    for (const name of readdirSync(dir)) makeRemovable(join(dir, name));
  }
  makeRemovable(scratch);
  rmSync(scratch, { recursive: true, force: true });
}

function retireMergeScratch(scratch: string, original?: ReturnType<typeof mergeSnapshot>) {
  const done = join(scratch, "retired");
  const saved = savedMergeUnit(scratch);
  const previous = dirname(saved);
  if (original !== undefined) {
    writeFileSync(`${done}.tmp`, JSON.stringify(mergeInventory(original)));
    renameSync(`${done}.tmp`, done);
  }
  if (lstat(previous) !== undefined) {
    const recorded = readFileSync(done, "utf8");
    const expected = new Map<string, string>(
      recorded
        ? (JSON.parse(recorded) as ReturnType<typeof mergeInventory>).map((entry) => [
            entry[0],
            JSON.stringify(entry),
          ])
        : [],
    );
    const changed = () =>
      new UserError(
        `merge: cannot retire a changed saved original; previous copy kept at ${saved}. Reconcile the copies, then move the recovery folder ${scratch} aside and retry.`,
      );
    const remaining = mergeInventory(mergeSnapshot(previous));
    if (remaining.some((entry) => expected.get(entry[0]) !== JSON.stringify(entry)))
      throw changed();
    for (const [path, directory] of remaining) {
      if (!directory) continue;
      const folder = join(previous, path);
      const entry = lstat(folder);
      if (!entry?.isDirectory()) throw changed();
      if ((entry.mode & 0o700) !== 0o700) chmodSync(folder, entry.mode | 0o700);
    }
    for (const [path, directory, hash, bits = 0] of remaining.reverse()) {
      const target = join(previous, path);
      if (directory) rmdirSync(target);
      else {
        const entry = lstat(target);
        const current = entry?.isSymbolicLink()
          ? sha256(`link:${readlinkSync(target)}`)
          : entry?.isFile()
            ? sha256(readFileSync(target))
            : undefined;
        if (
          entry === undefined ||
          current !== hash ||
          entry.isDirectory() ||
          mergeExecuteBits(entry) !== bits
        )
          throw changed();
        unlinkSync(target);
      }
    }
    rmdirSync(previous);
  }
  for (const name of readdirSync(scratch)) {
    if (name !== "retired" && name !== "previous") cleanMergeScratch(join(scratch, name));
  }
  rmSync(done);
  rmdirSync(scratch);
}

/** An approved publication is resumed; an unapproved move is restored, never overwritten. */
function finishMergeUnit(scratch: string, target: string) {
  const saved = savedMergeUnit(scratch);
  const publishing = join(scratch, "publish");
  let original: ReturnType<typeof mergeSnapshot>;
  try {
    if (existsSync(publishing)) {
      const incoming = mergeIncoming(scratch);
      const next = join(incoming, "next");
      const expected = JSON.parse(readFileSync(publishing, "utf8")) as {
        incoming?: string;
        previous?: string;
      };
      const checkPrevious = () => {
        const snapshot = mergeSnapshot(dirname(saved));
        if (mergeFingerprint(snapshot) !== expected.previous)
          throw new Error("the saved original no longer matches the publication approval");
        return snapshot;
      };
      const check = () => {
        if (mergeFingerprint(mergeSnapshot(incoming)) !== expected.incoming)
          throw new Error("the published files changed");
      };
      checkPrevious();
      check();
      if (lstat(next) !== undefined) publishMergeUnit(scratch, next, target);
      else if (lstat(target) !== undefined)
        throw new Error(`${target} is occupied by another entry`);
      check();
      original = checkPrevious();
    } else {
      if (lstat(saved) !== undefined) publishMergeUnit(scratch, saved, target);
      original = mergeSnapshot(dirname(saved));
    }
  } catch (error) {
    throw new UserError(
      `merge: could not finish replacing ${target} (${(error as Error).message}); ${lstat(saved) ? `previous copy kept at ${saved}. Reconcile the copies, then move the recovery folder ${scratch} aside and retry.` : `move the recovery folder ${scratch} aside and retry.`}`,
    );
  }
  retireMergeScratch(scratch, original);
}

function lstatMergeScratch(scratch: string) {
  try {
    return lstat(scratch);
  } catch (error) {
    if (isErrno(error, "ENOTDIR")) return undefined;
    throw error;
  }
}

/** Recover before hashing; fallback workspaces beside the target are excluded from skill copies. */
function recoverMergeUnit(live: string, dryRun: boolean) {
  const pointer = mergeRecoveryPointer(live);
  const scratch = readMergeRecoveryPointer(pointer);
  if (scratch === undefined) return;
  const scratchParent = dirname(scratch);
  const besideLive = scratchParent === dirname(live);
  if (!isMergeScratch(basename(scratch)) || (!besideLive && !inside(live, scratchParent))) {
    throw new UserError(`merge: invalid recovery pointer at ${pointer}`);
  }
  const entry = lstatMergeScratch(scratch);
  if (entry && !besideLive && realpathSync(scratchParent) !== scratchParent) {
    throw new UserError(`merge: invalid recovery pointer at ${pointer}`);
  }
  if (entry?.isDirectory()) {
    const saved = savedMergeUnit(scratch);
    if (existsSync(join(scratch, "retired"))) {
      if (!dryRun) retireMergeScratch(scratch);
    } else if (lstat(saved) || existsSync(join(scratch, "publish"))) {
      const root = readFileSync(join(scratch, "target"), "utf8");
      const target = join(live, root);
      if (
        dryRun ||
        target === live ||
        relative(live, target).split(sep).join("/") !== root ||
        !inside(live, target) ||
        (scratchParent !== dirname(live) && scratchParent !== dirname(target)) ||
        linkedFolder(live, root) !== undefined
      ) {
        throw new UserError(
          `merge: interrupted replacement of ${target}; recovery folder ${scratch}${dryRun ? "; rerun without --dry-run to recover" : ""}`,
        );
      }
      finishMergeUnit(scratch, target);
    } else if (!dryRun) retireMergeScratch(scratch, mergeSnapshot(dirname(saved)));
  }
  if (!dryRun) {
    rmSync(mergeWorkspaceReceipt(scratch), { force: true });
    rmSync(pointer, { force: true });
  }
}

function makeMergeScratch(live: string, targetParent: string) {
  const parent = dirname(live);
  const prefix = mergeScratchPrefix(live);
  if (statSync(parent).dev === statSync(targetParent).dev) {
    try {
      return mkdtempSync(join(parent, prefix));
    } catch (error) {
      if (!isErrno(error, "EACCES") && !isErrno(error, "EPERM") && !isErrno(error, "EROFS"))
        throw error;
    }
  }
  return mkdtempSync(join(targetParent, prefix));
}

/** Stage the replacement, then check the old unit after moving it aside and before discarding it. */
function replaceMergeUnit(
  live: string,
  root: string,
  stage: (next: string) => void,
  unchanged: (old: ReturnType<typeof mergeSnapshot>) => boolean,
): boolean {
  const target = join(live, root);
  mkdirSync(dirname(target), { recursive: true });
  const pointer = mergeRecoveryPointer(live);
  mkdirSync(dirname(pointer), { recursive: true });
  const scratch = makeMergeScratch(live, dirname(target));
  const previous = join(scratch, "previous");
  const saved = savedMergeUnit(scratch);
  const incoming = mergeIncoming(scratch);
  const next = join(incoming, "next");
  try {
    registerMergeWorkspace(scratch, pointer);
    writeFileSync(`${pointer}.tmp`, scratch);
    renameSync(`${pointer}.tmp`, pointer);
    writeFileSync(join(scratch, "target"), root);
    mkdirSync(incoming);
    stage(next);
    mkdirSync(previous);
    if (lstat(target) !== undefined) {
      try {
        renameSync(target, saved);
      } catch (error) {
        if (isErrno(error, "ENOENT")) return false;
        throw error;
      }
    }
    const original = mergeSnapshot(previous);
    if (!unchanged(original) || lstat(target) !== undefined) return false;
    writeFileSync(
      join(scratch, "ready"),
      JSON.stringify({
        incoming: mergeFingerprint(mergeSnapshot(incoming)),
        previous: mergeFingerprint(original),
      }),
    );
    renameSync(join(scratch, "ready"), join(scratch, "publish"));
    return true;
  } finally {
    finishMergeUnit(scratch, target);
    rmSync(mergeWorkspaceReceipt(scratch), { force: true });
    rmSync(pointer, { force: true });
  }
}

/**
 * Three-way merge of one folder: `base` to `upstream` changes applied onto `live`, file by file,
 * except that a path that is a file on one side and a folder on another merges as one unit with
 * what is under it.
 * Links are compared by their targets and never followed, read through or written: a file that is
 * a link, or sits in a linked folder, on any side, and changed upstream, is a conflict. Without
 * a base, merge shared text files against empty content, but report empty versus nonempty as a
 * conflict rather than treating the empty side as unchanged. A dry run writes nothing.
 */
async function mergeTrees(
  live: string,
  base: string | undefined,
  upstream: string,
  dryRun: boolean,
): Promise<MergeResult> {
  const realLive = existsSync(live) ? realpathSync(live) : live;
  recoverMergeUnit(realLive, dryRun);
  const [local, previous, next] = [
    mergeSnapshot(live),
    mergeSnapshot(base),
    mergeSnapshot(upstream),
  ];
  const [hl, hb, hu] = [local.hashes, previous.hashes, next.hashes];
  const files = new Set([...Object.keys(hl), ...Object.keys(hb), ...Object.keys(hu)]);
  const collisions = new Set(
    [...files].filter((file) =>
      [local, previous, next].some(({ entries }) => entries.get(file)?.isDirectory()),
    ),
  );
  const groups = new Map<string, string[]>();
  if (collisions.size > 0) {
    const paths = new Set([
      ...local.entries.keys(),
      ...previous.entries.keys(),
      ...next.entries.keys(),
    ]);
    for (const path of paths) {
      let root: string | undefined;
      for (let ancestor = path; ancestor !== "."; ancestor = posix.dirname(ancestor)) {
        if (collisions.has(ancestor)) root = ancestor;
      }
      if (root === undefined) continue;
      const group = groups.get(root);
      if (group === undefined) groups.set(root, [path]);
      else group.push(path);
      if (path !== root) files.delete(path);
    }
  }
  const modeOnly = new Set(
    base === undefined
      ? []
      : changedModes([...previous.modes.keys()], [...next.modes.keys()]).filter((file) => {
          if (!files.has(file) || groups.has(file)) return false;
          const incoming = readContent(upstream, file);
          return Buffer.isBuffer(incoming) && sameContent(incoming, readContent(base, file));
        }),
  );
  const mergeMode = (file: string, validateOnly: boolean) => {
    if (!copyExecuteBits(upstream, live, file, validateOnly))
      throw new UserError(
        `cannot merge the executable bit for ${file}: restore the local path to a regular file and retry`,
      );
  };
  for (const file of modeOnly) mergeMode(file, true);
  if (!dryRun) for (const file of modeOnly) mergeMode(file, false);
  const result: MergeResult = { merged: [], conflicts: [] };
  const markers: Record<string, string> = {};
  /**
   * A conflict git's markers can't show: upstream's side goes beside the local file, as
   * `<file>.upstream` (a link's as a note of its target), or a note that upstream deleted it. A file
   * in a linked folder gets its note beside that folder, since merge never writes through a link.
   */
  const conflict = (file: string, upstream: Content | "folder" | undefined, bits = 0) => {
    result.conflicts.push(file);
    if (dryRun) return;
    const folder = linkedFolder(live, file);
    const at = join(live, folder ?? file);
    mkdirSync(dirname(at), { recursive: true });
    const written =
      folder !== undefined
        ? writeSidecar(
            at,
            Buffer.from(
              `upstream changed ${file}, which is inside ${folder}, a link here; fleetrc does not write through links. Bring in upstream's change by hand, then delete this file and run \`fleetrc merge\` again.\n`,
            ),
            ".upstream-conflict",
          )
        : upstream === undefined
          ? writeSidecar(
              at,
              Buffer.from(
                `upstream deleted ${file}, which you changed. Keep your copy or delete it, then delete this file and run \`fleetrc merge\` again.\n`,
              ),
              ".upstream-deleted",
            )
          : upstream === "folder"
            ? writeSidecar(
                at,
                Buffer.from(
                  `upstream turned ${file} into a folder, and you changed it. Bring in upstream's ${file}/ by hand, then delete this file and run \`fleetrc merge\` again.\n`,
                ),
                ".upstream-conflict",
              )
            : writeSidecar(
                at,
                Buffer.isBuffer(upstream)
                  ? upstream
                  : Buffer.from(`upstream has a link here, to ${upstream.link}\n`),
                ".upstream",
                bits,
              );
    markers[file] = relative(live, written).split(sep).join("/");
  };
  /**
   * Replaces the unit at `root` with upstream's when the local copy has no edits in it and upstream's
   * holds only plain files, and is a conflict on `root` otherwise.
   */
  const mergeUnit = (root: string, paths: string[]) => {
    const sameFile = (left: typeof local, right: typeof local, path: string) =>
      left.hashes[path] === right.hashes[path] && left.modes.get(path) === right.modes.get(path);
    const sameUnit = (left: typeof local, right: typeof local) =>
      paths.every((path) => sameFile(left, right, path));
    if (sameUnit(next, previous) || sameUnit(local, next)) return;
    const incoming = paths.filter((path) => hu[path] !== undefined);
    const contents = incoming.map((file) => readContent(upstream, file));
    const upstreamConflict = () =>
      conflict(
        root,
        next.entries.get(root)?.isDirectory() ? "folder" : readContent(upstream, root),
        next.modes.get(root),
      );
    const localEntries = paths.filter((path) => local.entries.has(path));
    if (
      !sameUnit(local, previous) ||
      localEntries.some((path) => {
        const entry = local.entries.get(path)!;
        return !entry.isFile() && !entry.isDirectory();
      }) ||
      linkedFolder(live, root) !== undefined ||
      !contents.every((content) => Buffer.isBuffer(content))
    ) {
      upstreamConflict();
      return;
    }
    if (!dryRun) {
      const replaced = replaceMergeUnit(
        realLive,
        root,
        (staged) => {
          if (next.entries.get(root)?.isDirectory()) mkdirSync(staged);
          incoming.forEach((file, index) => {
            const path = join(staged, file.slice(root.length));
            mkdirSync(dirname(path), { recursive: true });
            writeMergeFile(path, contents[index] as Buffer, next.modes.get(file) ?? 0, "w");
          });
        },
        (old) =>
          old.entries.size === localEntries.length &&
          localEntries.every((path) => {
            const saved = `unit${path.slice(root.length)}`;
            const entry = old.entries.get(saved);
            return (
              (local.entries.get(path)?.isDirectory() ? entry?.isDirectory() : entry?.isFile()) &&
              old.hashes[saved] === hl[path] &&
              old.modes.get(saved) === local.modes.get(path)
            );
          }),
      );
      if (!replaced) {
        upstreamConflict();
        return;
      }
    }
    const changed = paths.filter((file) => !sameFile(previous, next, file));
    result.merged.push(...changed.sort());
  };
  for (const file of [...files].sort()) {
    if (modeOnly.has(file)) {
      result.merged.push(file);
      continue;
    }
    const group = groups.get(file);
    if (group !== undefined) {
      mergeUnit(file, group);
      continue;
    }
    const b = base === undefined ? undefined : readContent(base, file);
    const u = readContent(upstream, file);
    if (sameContent(u, b)) continue;
    const l = readContent(live, file);
    const target = join(live, file);
    if (sameContent(l, u)) continue;
    const plain = (content: Content | undefined) =>
      content === undefined || Buffer.isBuffer(content);
    if (!plain(b) || !plain(l) || !plain(u)) {
      conflict(file, u);
      continue;
    }
    const [lb, baseBytes, ub] = [l, b, u] as (Buffer | undefined)[];
    if (sameContent(lb, baseBytes)) {
      if (!dryRun && ub === undefined) rmSync(target, { force: true });
      else if (!dryRun) {
        mkdirSync(dirname(target), { recursive: true });
        writeFileSync(target, ub!);
      }
      result.merged.push(file);
      continue;
    }
    if (lb === undefined || ub === undefined || (base !== undefined && baseBytes === undefined)) {
      // Added or deleted on one side and changed on the other: keep the local file, put upstream's
      // beside it, or a note that upstream deleted it.
      conflict(file, ub);
      continue;
    }
    const bb = baseBytes ?? Buffer.alloc(0);
    if ((base === undefined && (lb.length === 0 || ub.length === 0)) || [lb, bb, ub].some(binary)) {
      conflict(file, ub);
      continue;
    }
    const scratch = mkdtempSync(join(tmpdir(), "fleetrc-merge-"));
    try {
      writeFileSync(join(scratch, "base"), bb);
      writeFileSync(join(scratch, "upstream"), ub);
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
      else if (merge.code !== null && merge.code > 0 && merge.code < 128) {
        // Each conflict is a hunk with git's markers in the file.
        if (dryRun || unresolvedFiles({ dir: live, files: [file] }).length > 0)
          result.conflicts.push(file);
        else conflict(file, ub);
      } else if (merge.code !== null && merge.code >= 128) conflict(file, ub);
      else throw new UserError(`git merge-file ${file}: ${merge.stderr.trim()}`);
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  }
  if (Object.keys(markers).length > 0) result.markers = markers;
  return result;
}

/** `fleetrc merge <skill>`: brings upstream changes into an edited copy or a fork. */
export async function mergeSkill(
  spec: string,
  typed: string,
  { dryRun = false } = {},
): Promise<MergeResult & { into: string; manifest?: ManifestTarget }> {
  const { loaded, state, source, name, fork, item } = await locate(spec, typed);
  // An earlier merge's conflicts: resolved by hand now, or still in the way.
  const earlier = state.conflicts?.[name];
  let resolved = false;
  if (earlier) {
    const open = unresolvedFiles(earlier);
    if (open.length > 0)
      throw new UserError(
        `${name} still has merge conflicts in ${open.join(", ")} (${tildify(earlier.dir)}); resolve the markers (and remove the .upstream files), then run \`fleetrc merge ${name}\` again`,
      );
    resolved = true;
    if (!dryRun) {
      delete state.conflicts![name];
      saveState(state);
    }
  }
  /** Records the conflicts a merge left in `into`, which status, doctor and sync report. */
  const record = (result: MergeResult, into: string): MergeResult & { into: string } => {
    if (!dryRun && result.conflicts.length > 0) {
      (state.conflicts ??= {})[name] = {
        dir: into,
        files: result.conflicts,
        ...(result.markers ? { markers: result.markers } : {}),
      };
      saveState(state);
    }
    return { ...result, ...(resolved ? { resolved } : {}), into };
  };
  if (fork) {
    gitFork(loaded, name, fork.fork);
    const head = await forkUpstream(fork.fork);
    const live = state.skills[name]!.dir;
    if (source.kind === "clone") confine(source.path, live, "merge into it");
    // Where the new base is recorded, checked before the merge touches a file.
    const manifest = manifestToEdit(
      loaded,
      spec,
      `Set "base" of "forks"."${fork.key}" to "${head.commit}"`,
    );
    const base = await forkBase(fork.fork, fork.key);
    const result = await mergeTrees(live, base, head.dir, dryRun);
    editManifest(
      manifest.file,
      (raw) => {
        const entry = isRecord(raw.forks) ? raw.forks[fork.key] : undefined;
        if (isRecord(entry)) entry.base = head.commit;
      },
      { dryRun },
    );
    return { ...record(result, live), manifest };
  }
  if (!isVendored(source))
    throw new UserError(
      `${name} comes from ${source.id}, a folder you edit in place; use git there`,
    );
  const { records, key, store } = kept(state, source, { name, item });
  if (!existsSync(store.upstream)) {
    if (resolved) return { merged: [], conflicts: [], resolved, into: store.live };
    throw new UserError(`${name} has no upstream change to merge; \`fleetrc sync\` fetches one`);
  }
  const hashes = hashDir(store.upstream);
  const pending = pendingGitBase(records.pending[key], hashes);
  const result = await mergeTrees(store.live, store.base, store.upstream, dryRun);
  if (dryRun) return { ...result, ...(resolved ? { resolved } : {}), into: store.live };
  copyDir(store.upstream, store.base);
  records.skills[key] = {
    ...records.skills[key],
    hashes,
    ...(source.kind === "git" ? { path: pending?.path, commit: pending?.commit ?? null } : {}),
  };
  rmSync(store.upstream, { recursive: true, force: true });
  delete records.pending[key];
  saveState(state);
  return record(result, store.live);
}

/** What `fork` did, or would do in a dry run. */
export interface Forked {
  name: string;
  /** The copy fleetrc kept, which moves into the personal source. */
  from: string;
  to: string;
  fork: Fork;
  manifest: ManifestTarget;
}

/** `fleetrc fork <skill>`: moves a vendored skill into the personal repository and records where it came from. */
export async function forkSkill(
  spec: string,
  typed: string,
  { dryRun = false } = {},
): Promise<Forked> {
  const { loaded, state, source, name } = await locate(spec, typed);
  if (!isVendored(source)) throw new UserError(`${name} already lives in ${source.id}`);
  if (source.kind !== "git")
    throw new UserError(
      `fork follows a skill's upstream through its git history, and ${source.id} is ${source.kind === "npm" ? "an npm package" : "an index site"}, which has none. To edit ${name} where it is, edit it in place: sync keeps your edits and holds upstream changes for \`fleetrc merge ${name}\``,
    );
  const personal = personalSource(loaded.sources);
  if (!personal)
    throw new UserError("no personal source: mark a git source with a path as `adopt: true`");
  const to = personalDestination(personal, name, "fork into it");
  if (lstat(to)) throw new UserError(`${tildify(to)} already exists`);
  const store = storePaths(paths.store(source.id), name);
  if (!existsSync(store.live))
    throw new UserError(`${name} has no copy on this machine yet; run \`fleetrc sync\``);
  const recovery = readMergeRecoveryPointer(mergeRecoveryPointer(realpathSync(store.live)));
  if (recovery !== undefined && lstatMergeScratch(recovery) !== undefined)
    throw new UserError(
      `${name} has an interrupted merge at ${recovery}; run \`fleetrc merge ${name}\` before forking`,
    );
  const sourceState = state.sources[source.id]!;
  const installed = sourceState.skills[name];
  if (existsSync(store.upstream)) {
    const pending = pendingGitBase(sourceState.pending[name], hashDir(store.upstream));
    if (!pending)
      throw new UserError(
        `cannot verify the pending git update of ${name}; run \`fleetrc sync\` online before forking`,
      );
    if (pending.path !== installed?.path)
      throw new UserError(
        `${name} moved upstream to ${pending.path}; run \`fleetrc merge ${name}\` before forking`,
      );
  }
  const base = installed?.commit === undefined ? sourceState.commit : installed.commit;
  if (!base || installed?.path === undefined)
    throw new UserError(
      `cannot verify the git base of ${name}; run \`fleetrc sync\` online before forking`,
    );
  const fork: Fork = {
    from: source.git,
    path: installed.path,
    base,
    upstream: "git",
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
  // A remote manifest still names this store until its working-copy edit is pushed.
  // Keep the live snapshot and its state available to existing agent links meanwhile.
  if (manifest.push) return result;
  for (const dir of Object.values(store)) rmSync(dir, { recursive: true, force: true });
  delete sourceState.skills[name];
  delete sourceState.pending[name];
  saveState(state);
  return result;
}

/** `fleetrc adopt <path>`: moves a hand-made skill folder into the personal repository. */
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
  const to = personalDestination(personal, name, "adopt into it");
  if (lstat(to)) throw new UserError(`${tildify(to)} already exists`);
  if (!dryRun) moveDir(path, to);
  return { to, name };
}
