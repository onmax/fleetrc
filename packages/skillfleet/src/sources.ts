import { createHash } from "node:crypto";
import {
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmdirSync,
  rmSync,
  statSync,
} from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, posix, relative, sep } from "node:path";
import { installSkills, isDiagnostic, resolveSource, type SkillSource } from "skills";
import { git, GitError, gitOut } from "./exec.ts";
import {
  changedFiles,
  copyResolved,
  type Hashes,
  countCopies,
  dict,
  hashDir,
  inside,
  isRecord,
  listFiles,
  recoverReplaced,
  renameFolder,
  replaceDir,
  replaceUnchanged,
  sameTree,
  skillBudget,
  SkillTooLargeError,
} from "./fs.ts";
import { collisions, fetchClone, gitUrl, isCommitRef, type Refusal, refusals } from "./gitcache.ts";
import { globBase, matchesGlob } from "./glob.ts";
import type { CloneSource, InPlaceSource, Source, VendoredSource } from "./manifest.ts";
import { assertSegment, GIT_FOLDER, nameKey, segmentProblem } from "./names.ts";
import { fetchNpm, parseNpmSpec, withCappedFetch } from "./npm.ts";
import { tildify } from "./paths.ts";
import type { SourceState } from "./state.ts";

export interface SkillEntry {
  name: string;
  /** The folder agents link to. */
  dir: string;
  /** Folder inside the source, `/`-separated. */
  path?: string;
  /** A working clone's folder, which links in the skill may lead into when it is copied. */
  root?: string;
}

export type SourceStatus =
  | "installed"
  | "updated"
  | "unchanged"
  | "held"
  | "review"
  | "error"
  | "offline";

export interface SourceResult {
  id: string;
  kind: Source["kind"];
  status: SourceStatus;
  skills: SkillEntry[];
  from?: string;
  to?: string;
  /**
   * Changed files, for hooks: relative to the repository of a git source, to the package of an npm
   * source and to the folder of a local one; `<skill>/<file>` for a well-known index.
   */
  changed: string[];
  held?: { reason: string; files: string[] };
  /** Skills with an upstream change that was not applied. */
  pending: { skill: string; reason: "review" | "edited"; files: string[] }[];
  /** Vendored skills with local edits. */
  edited: { skill: string; files: string[] }[];
  added: string[];
  updated: string[];
  removed: string[];
  error?: string;
  warnings: string[];
}

export interface SourceContext {
  offline: boolean;
  /** `--offline` was passed: a source never fetched is an error, not a note. */
  offlineRequested?: boolean;
  dryRun: boolean;
  /** Apply review-mode updates for this source. */
  apply: boolean;
  cacheDir: string;
  storeDir: string;
  now: string;
}

const SKILLS_OPTIONS = { telemetry: false } as const;

const result = (source: Source, status: SourceStatus): SourceResult => ({
  id: source.id,
  kind: source.kind,
  status,
  skills: [],
  changed: [],
  pending: [],
  edited: [],
  added: [],
  updated: [],
  removed: [],
  warnings: [],
});

const message = (error: unknown) => (error instanceof Error ? error.message : String(error));

/** The result of a source whose sync threw. */
export const failedResult = (source: Source, error: string): SourceResult => ({
  ...result(source, "error"),
  error,
});

/** A source with nothing on this machine: an error when `--offline` was asked for, else a note. */
function neverFetched(out: SourceResult, ctx: SourceContext, what: string) {
  if (ctx.offlineRequested) {
    out.status = "error";
    out.error = `never fetched (${what}), and --offline is set; run sync without it`;
  } else out.warnings.push(`${out.id}: never fetched (${what})`);
}

interface Found {
  name: string;
  path?: string;
}

/**
 * Drops skills whose name cannot be a folder on every system, and the second of two names that
 * macOS and Windows would store in one folder, warning for each.
 */
function plainNames(source: Source, found: readonly Found[], warnings: string[]): Found[] {
  const keys = new Map<string, string>();
  return found.filter((skill) => {
    const problem = segmentProblem(skill.name);
    if (problem) {
      warnings.push(`${source.id}: skipped the skill "${skill.name}": its name ${problem}`);
      return false;
    }
    const other = keys.get(nameKey(skill.name));
    if (other !== undefined) {
      warnings.push(
        `${source.id}: skipped the skill "${skill.name}": macOS and Windows store it in the same folder as "${other}"`,
      );
      return false;
    }
    keys.set(nameKey(skill.name), skill.name);
    return true;
  });
}

/** Applies a source's `skills` glob, `include` and `exclude` to what discovery found. */
export function select(source: Source, found: readonly Found[], warnings: string[]): Found[] {
  const glob = source.kind === "index" ? undefined : source.skills;
  let chosen = found.filter(
    (skill) => !glob || (skill.path !== undefined && matchesGlob(skill.path, glob)),
  );
  // A name in the manifest finds its skill in any case or Unicode form, as a CLI argument does.
  const names = (list: readonly string[]) => new Set(list.map(nameKey));
  if (source.include) {
    const have = names(chosen.map((skill) => skill.name));
    for (const name of source.include)
      if (!have.has(nameKey(name)))
        warnings.push(`${source.id}: include names "${name}", which the source does not have`);
    const included = names(source.include);
    chosen = chosen.filter((skill) => included.has(nameKey(skill.name)));
  }
  if (source.exclude) {
    const excluded = names(source.exclude);
    chosen = chosen.filter((skill) => !excluded.has(nameKey(skill.name)));
  }
  return chosen;
}

/**
 * The folder a `skills` glob starts from, which must stay inside the source. A fetched source
 * cannot leave it through a link either; a folder on this machine may link elsewhere.
 */
function globRoot(root: string, glob: string | undefined, followLinks: boolean): string {
  const base = glob ? globBase(glob) : "";
  const dir = base ? join(root, base) : root;
  const escapes =
    !inside(root, dir) ||
    (!followLinks && existsSync(dir) && !inside(realpathSync(root), realpathSync(dir)));
  if (escapes) throw new Error(`the skills glob "${glob}" leaves the source`);
  return dir;
}

/**
 * Throws when a file or folder that `skills` reads to find skills in `dir` leads out of `root`
 * through a link: the files that configure discovery (skills.sh.json, plugin manifests, the
 * skills lock) and the folders they name. `skills` checks those folders by their names only, and
 * would read and install what a link there leads to.
 */
function checkDiscoveryPaths(root: string, dir: string) {
  const realRoot = realpathSync(root);
  const check = (path: string) => {
    if (!lstatSync(path, { throwIfNoEntry: false })) return;
    let real: string;
    try {
      real = realpathSync(path);
    } catch {
      return; // A link to nothing: nothing to read through it.
    }
    if (!inside(realRoot, real))
      throw new Error(
        `${relative(root, path).split(sep).join("/") || "."} links out of the source, so it is not read`,
      );
  };
  const readConfig = (file: string): unknown => {
    const path = join(dir, file);
    check(path);
    try {
      return JSON.parse(readFileSync(path, "utf8"));
    } catch {
      return undefined;
    }
  };
  const strings = (value: unknown) =>
    Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
  check(dir);
  readConfig("skills-lock.json");
  const config = readConfig("skills.sh.json");
  if (isRecord(config)) for (const path of strings(config.paths)) check(join(dir, path));
  // A plugin's folder, its skills folder, and each skill folder it lists, as `skills` reads them.
  const plugin = (base: string, skills: unknown) => {
    check(base);
    check(join(base, "skills"));
    for (const path of strings(skills)) {
      check(join(base, path));
      check(dirname(join(base, path)));
    }
  };
  const marketplace = readConfig(".claude-plugin/marketplace.json");
  if (isRecord(marketplace)) {
    const pluginRoot =
      isRecord(marketplace.metadata) && typeof marketplace.metadata.pluginRoot === "string"
        ? marketplace.metadata.pluginRoot
        : "";
    for (const entry of Array.isArray(marketplace.plugins) ? marketplace.plugins : [])
      if (isRecord(entry))
        plugin(
          join(dir, pluginRoot, typeof entry.source === "string" ? entry.source : ""),
          entry.skills,
        );
  }
  const manifest = readConfig(".claude-plugin/plugin.json");
  if (isRecord(manifest)) plugin(dir, manifest.skills);
}

/**
 * Skills that `handle`, discovered in `dir`, found through a link out of `root`: a skill folder
 * that is one, or sits in a folder `skills` searches by name that is one. Each is
 * named in a warning; the caller leaves them out.
 */
function escapingSkills(
  source: Source,
  handle: SkillSource,
  dir: string,
  root: string,
  warnings: string[],
): Set<string> {
  const realRoot = realpathSync(root);
  const escaping = new Set<string>();
  for (const skill of handle.skills) {
    if (skill.path === undefined) continue;
    const folder = join(dir, skill.path);
    // A SKILL.md that is a link is `linkedSkillMds`'s to judge.
    let leaves: boolean;
    try {
      leaves = !inside(realRoot, realpathSync(folder));
    } catch {
      leaves = true;
    }
    if (!leaves) continue;
    escaping.add(skill.name);
    const rel = relative(root, folder).split(sep).join("/");
    warnings.push(
      source.kind === "clone"
        ? linksOutOfClone(source, rel)
        : `${source.id}: ${rel} links out of the source, so its skill "${skill.name}" is not read`,
    );
  }
  return escaping;
}

/**
 * Discovers skills in a folder through the `skills` package, limited to the `skills` glob's base
 * folder. Without `followLinks` (a folder skillfleet fetched, or a working clone), what configures
 * discovery must stay inside `bound`, the source; the caller then leaves out `escapingSkills`.
 */
async function discover(
  root: string,
  glob: string | undefined,
  skipped: string[] = [],
  followLinks = false,
  bound = root,
): Promise<SkillSource> {
  const dir = globRoot(root, glob, followLinks);
  if (!followLinks) checkDiscoveryPaths(bound, dir);
  return resolveSource(dir, {
    config: SKILLS_OPTIONS,
    onWarning: (warning) => {
      const data: unknown = warning.data;
      if (
        isDiagnostic(warning, "SKILLS_SKILL_SKIPPED") &&
        isRecord(data) &&
        typeof data.path === "string"
      )
        skipped.push(data.path);
    },
  });
}

/** Folders discovery does not look in: as in the `skills` package. */
const SKIP_DIRS = new Set([".git", "node_modules"]);

interface LinkedFolder extends Found {
  path: string;
  /** The folder the link resolves to. */
  real: string;
}

/**
 * Where a skill folder that discovery could not see (a link, a submodule) may sit: what the
 * `skills` glob matches, or, without one, a folder beside a skill discovery found.
 */
function skillPlace(source: Source, found: readonly Found[]): (path: string) => boolean {
  const glob = source.kind === "index" ? undefined : source.skills;
  if (glob) return (path) => matchesGlob(path, glob);
  const parents = new Set(
    found.flatMap((skill) =>
      skill.path === undefined || skill.path === "." ? [] : [posix.dirname(skill.path)],
    ),
  );
  return (path) => parents.has(posix.dirname(path));
}

/**
 * Skill folders that are links, which discovery does not follow. A link that resolves inside the
 * source is a skill; one that leaves it is not read (unless `outside`, for a folder of the user's
 * own) and is named in a warning. Links inside a skill are copied or dropped by `skills`.
 */
function linkedFolders(
  source: Source,
  root: string,
  found: readonly Found[],
  warnings: string[],
  outside = false,
): LinkedFolder[] {
  const glob = source.kind === "index" ? undefined : source.skills;
  const place = skillPlace(source, found);
  const realRoot = realpathSync(root);
  const linked: LinkedFolder[] = [];
  const look = (dir: string, depth: number) => {
    if (depth > 5 || existsSync(join(dir, "SKILL.md"))) return;
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (glob && !SKIP_DIRS.has(entry.name)) look(path, depth + 1);
        continue;
      }
      const rel = relative(root, path).split(sep).join("/");
      if (!entry.isSymbolicLink() || !place(rel)) continue;
      let real: string;
      try {
        real = realpathSync(path);
        if (!statSync(real).isDirectory()) continue;
      } catch {
        continue;
      }
      if (!outside && !inside(realRoot, real)) {
        warnings.push(
          source.kind === "clone"
            ? linksOutOfClone(source, rel)
            : `${source.id}: ${rel} links to a folder outside the source, so it is not read`,
        );
        continue;
      }
      // A link to a folder that holds it would make the skill contain itself.
      if (inside(real, realpathSync(dir))) continue;
      const file = join(real, "SKILL.md");
      if (existsSync(file))
        linked.push({ name: lenientName(file) ?? basename(path), path: rel, real });
    }
  };
  if (glob) look(globRoot(root, glob, outside), 0);
  else {
    const dirs = new Set(
      found.flatMap((skill) =>
        skill.path === undefined || skill.path === "." ? [] : [posix.dirname(skill.path)],
      ),
    );
    for (const dir of dirs) look(join(root, dir), 5);
  }
  return linked.filter((link) => !found.some((skill) => skill.name === link.name));
}

/** The warning for a path of a working clone that leads out of it, naming the opt-in. */
const linksOutOfClone = (source: CloneSource, rel: string) =>
  `${source.id}: ${rel} links outside ${tildify(source.path)}; add "followLinks": true to this source to use it`;

/** The submodules of a working clone. */
async function cloneSubmodules(dir: string): Promise<string[]> {
  const listed = await git(["ls-files", "--stage", "-z"], { cwd: dir, allowFail: true });
  if (listed.code !== 0) return [];
  return listed.stdout
    .split("\0")
    .filter((entry) => entry.startsWith("160000 "))
    .map((entry) => entry.slice(entry.indexOf("\t") + 1));
}

/**
 * A warning for each submodule where the `skills` glob looks and no skill is checked out: a
 * fetched source never has them, and a working clone has them after `git submodule update --init`.
 */
function unfetchedSubmodules(
  source: Source,
  root: string,
  found: readonly Found[],
  submodules: readonly string[],
  warnings: string[],
) {
  const place = skillPlace(source, found);
  for (const path of submodules) {
    if (!place(path) || existsSync(join(root, path, "SKILL.md"))) continue;
    warnings.push(
      source.kind === "clone"
        ? `${source.id}: ${path} is a git submodule that is not checked out, so its skills are not linked; run \`git submodule update --init\` in ${source.path}`
        : `${source.id}: ${path} is a git submodule, which skillfleet does not fetch, so its skills are not linked`,
    );
  }
}

/** The `name:` of a SKILL.md whose frontmatter is not valid YAML, read line by line. */
function lenientName(file: string): string | undefined {
  const frontmatter = readFileSync(file, "utf8").match(/^---\r?\n([\s\S]*?)\r?\n---/)?.[1];
  return frontmatter?.match(/^name:\s*["']?([^"'\r\n]+?)["']?\s*$/m)?.[1];
}

const withBase = (glob: string | undefined, path: string | undefined) => {
  const base = glob ? globBase(glob) : "";
  if (path === undefined) return undefined;
  if (!base) return path;
  return path === "." ? base : `${base}/${path}`;
};

async function discoverInPlace(
  source: InPlaceSource,
  root: string,
  warnings: string[],
): Promise<SkillEntry[]> {
  const skipped: string[] = [];
  // A working clone's links stay inside it unless the root manifest says to follow them.
  const follow = source.kind === "local" || source.followLinks;
  let handle: SkillSource | undefined;
  try {
    handle = await discover(root, source.skills, skipped, follow);
  } catch (error) {
    const why: string[] = [];
    if (
      !isDiagnostic(error, "SKILLS_NO_VALID_SKILLS") ||
      (skipped.length === 0 && linkedFolders(source, root, [], why, follow).length === 0)
    ) {
      // Links that lead out were all there was: name them and the rule, not just "no skills".
      if (why.length > 0) warnings.push(...why);
      else
        warnings.push(
          `${source.id}: ${message(error)}${source.kind === "clone" && /leaves the source|links out of the source/.test(message(error)) ? `; add "followLinks": true to this source to use it` : ""}`,
        );
      return [];
    }
  }
  try {
    const escaping =
      handle && !follow
        ? escapingSkills(source, handle, join(root, globBase(source.skills ?? "")), root, warnings)
        : new Set();
    const found: Found[] = (handle?.skills ?? [])
      .filter((skill) => !escaping.has(skill.name))
      .map((skill) => ({
        name: skill.name,
        path: withBase(source.skills, skill.path),
      }));
    // Agents read a SKILL.md that `skills` rejects (Claude Code parses frontmatter leniently),
    // so a folder in place is linked anyway rather than dropped.
    for (const file of skipped) {
      const dir = dirname(file);
      const path = relative(root, dir).split(sep).join("/");
      if (path.startsWith("..") || isAbsolute(path)) continue;
      const name = lenientName(file) ?? basename(dir);
      if (found.some((skill) => skill.name === name)) continue;
      found.push({ name, path: path || "." });
      warnings.push(
        `${source.id}: ${path}/SKILL.md frontmatter is not valid YAML; linked anyway, but tools that parse it strictly skip ${name}`,
      );
    }
    found.push(...linkedFolders(source, root, found, warnings, follow));
    if (source.kind === "clone")
      unfetchedSubmodules(source, root, found, await cloneSubmodules(root), warnings);
    return select(source, plainNames(source, found, warnings), warnings).map((skill) => ({
      name: skill.name,
      path: skill.path,
      dir: skill.path && skill.path !== "." ? join(root, skill.path) : root,
      // A folder of the user's own may link anywhere, as in `linkedFolders`.
      ...(follow ? {} : { root }),
    }));
  } finally {
    await handle?.dispose();
  }
}

// ---------------------------------------------------------------------------
// Working clones and local folders: linked in place.

function parsePorcelain(output: string): string[] {
  const files: string[] = [];
  const entries = output.split("\0");
  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i]!;
    if (entry.length < 4) continue;
    files.push(entry.slice(3));
    // Renames and copies are followed by their original path.
    if (entry[0] === "R" || entry[0] === "C") files.push(entries[++i] ?? "");
  }
  return files.filter(Boolean);
}

export async function syncClone(
  source: CloneSource,
  state: SourceState,
  ctx: SourceContext,
): Promise<SourceResult> {
  const out = result(source, "unchanged");
  const dir = source.path;
  if (!existsSync(join(dir, ".git"))) {
    if (ctx.offline) {
      out.status = "offline";
      neverFetched(out, ctx, `${dir} is not cloned yet`);
      if (existsSync(dir)) out.skills = await discoverInPlace(source, dir, out.warnings);
      return out;
    }
    if (ctx.dryRun) {
      out.status = "installed";
      out.warnings.push(`${source.id}: ${dir} is not cloned yet; sync clones it`);
      if (existsSync(dir)) out.skills = await discoverInPlace(source, dir, out.warnings);
      return out;
    }
    try {
      if (existsSync(dir)) throw new Error(`${dir} exists and is not a git repository`);
      await cloneAt(source, dir);
      await nameClashes(source, dir, out.warnings, true);
      out.status = "installed";
      out.to = await gitOut(["rev-parse", "HEAD"], dir);
      out.changed = (await gitOut(["ls-files", "-z"], dir)).split("\0").filter(Boolean);
    } catch (error) {
      out.status = "error";
      out.error = message(error);
      return out;
    }
  } else {
    try {
      const before = await gitOut(["rev-parse", "HEAD"], dir);
      out.from = before;
      out.to = before;
      if (!state.commit)
        out.changed = (await gitOut(["ls-files", "-z"], dir)).split("\0").filter(Boolean);
      const clashes = await nameClashes(source, dir, out.warnings, !ctx.dryRun);
      if (ctx.offline) out.status = "offline";
      else await updateClone(source, dir, before, ctx, out, clashes);
    } catch (error) {
      // The clone is still on disk (git may be missing or broken): keep linking what it has.
      out.status = "error";
      out.error = message(error);
      out.changed = [];
      out.skills = await discoverInPlace(source, dir, out.warnings);
      return out;
    }
  }
  state.commit = out.to;
  state.fetchedAt = ctx.now;
  out.skills = await discoverInPlace(source, dir, out.warnings);
  return out;
}

/** Clones a working clone at its `ref`: a branch or tag, or else a commit, checked out detached. */
export async function cloneAt(source: Pick<CloneSource, "git" | "ref">, dir: string) {
  const url = gitUrl(source.git);
  const clone = (ref?: string) =>
    git(["clone", "--quiet", ...(ref ? ["--branch", ref] : []), "--", url, dir], {
      timeoutMs: 600_000,
      allowFail: true,
    });
  const ref = source.ref;
  let cloned = await clone(ref);
  if (cloned.code === 0 || !ref || !isCommitRef(ref)) {
    if (cloned.code !== 0)
      throw new GitError(["clone", ...(ref ? ["--branch", ref] : []), "--", url, dir], cloned);
    return;
  }
  cloned = await clone();
  if (cloned.code !== 0) throw new GitError(["clone", "--", url, dir], cloned);
  try {
    const commit = await findCommit(dir, ref);
    if (!commit) throw new Error(`${url} has no branch, tag or commit ${ref}`);
    await git(["checkout", "--quiet", "--detach", commit], { cwd: dir });
  } catch (error) {
    // Nobody worked in a clone made a moment ago, and left on the default branch it would follow it.
    rmSync(dir, { recursive: true, force: true });
    throw error;
  }
}

/** The commit a ref names in a clone, fetching it from origin when the clone does not have it. */
async function findCommit(dir: string, ref: string): Promise<string | undefined> {
  const resolve = async () => {
    const found = await git(["rev-parse", "--verify", "--quiet", `${ref}^{commit}`], {
      cwd: dir,
      allowFail: true,
    });
    return found.code === 0 ? found.stdout.trim() : undefined;
  };
  const known = await resolve();
  if (known) return known;
  // A commit on no branch is fetched by its full id; a shorter one can only be looked up locally.
  if (ref.length !== 40) return undefined;
  const fetched = await git(["fetch", "--quiet", "--", "origin", ref], {
    cwd: dir,
    allowFail: true,
    timeoutMs: 300_000,
  });
  return fetched.code === 0 ? resolve() : undefined;
}

/**
 * A working clone pinned to a commit stays on it: nothing is fast-forwarded. When the manifest
 * names another commit, the clone moves to it unless local edits touch files that differ.
 */
async function updatePinned(
  source: CloneSource,
  ref: string,
  dir: string,
  before: string,
  ctx: SourceContext,
  out: SourceResult,
  clashes: Clashes,
) {
  if (before.startsWith(ref.toLowerCase())) return;
  if (ctx.dryRun) {
    out.warnings.push(`${source.id}: ${dir} is at ${before.slice(0, 7)}; sync checks out ${ref}`);
    return;
  }
  let commit = await findCommit(dir, ref);
  if (!commit) {
    await git(["fetch", "--quiet", "--", "origin"], { cwd: dir, timeoutMs: 300_000 });
    commit = await findCommit(dir, ref);
  }
  if (!commit) {
    out.status = "error";
    out.error = `${gitUrl(source.git)} has no branch, tag or commit ${ref}`;
    return;
  }
  const incoming = (await gitOut(["diff", "--name-only", "-z", "HEAD", commit], dir))
    .split("\0")
    .filter(Boolean);
  if (source.update === "review" && !ctx.apply) {
    out.status = "review";
    out.pending = [{ skill: "*", reason: "review", files: incoming }];
    return;
  }
  const dirty = await localEdits(dir, clashes);
  const overlap = incoming.filter((file) => dirty.has(file));
  if (overlap.length > 0) {
    out.status = "held";
    out.held = {
      reason: "local edits touch files that differ at the pinned commit",
      files: overlap,
    };
    return;
  }
  let moved = await git(["checkout", "--quiet", "--detach", commit], { cwd: dir, allowFail: true });
  if (moved.code !== 0 && incoming.some((file) => clashes.has(file)))
    moved = await moveAroundClashes(dir, commit, incoming, clashes);
  if (moved.code !== 0) {
    out.status = "held";
    out.held = { reason: moved.stderr.trim() || "git checkout failed", files: [] };
    return;
  }
  out.status = "updated";
  out.to = commit;
  out.changed = [...new Set([...out.changed, ...incoming])];
}

async function updateClone(
  source: CloneSource,
  dir: string,
  before: string,
  ctx: SourceContext,
  out: SourceResult,
  clashes: Clashes,
) {
  if (source.ref && isCommitRef(source.ref)) {
    const branch = await git(["symbolic-ref", "--quiet", "HEAD"], { cwd: dir, allowFail: true });
    if (branch.code !== 0) return updatePinned(source, source.ref, dir, before, ctx, out, clashes);
  }
  const upstream = await git(["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"], {
    cwd: dir,
    allowFail: true,
  });
  if (upstream.code !== 0) {
    out.warnings.push(`${source.id}: the checked-out branch has no upstream, so it is not updated`);
    return;
  }
  const tracking = upstream.stdout.trim();
  if (ctx.dryRun) {
    const [remote, ...branch] = tracking.split("/");
    const remoteHead = await git(["ls-remote", "--", remote!, `refs/heads/${branch.join("/")}`], {
      cwd: dir,
      allowFail: true,
      timeoutMs: 30_000,
    });
    const head = remoteHead.stdout.split(/\s/)[0];
    if (remoteHead.code !== 0)
      out.warnings.push(`${source.id}: cannot reach ${remote}: ${remoteHead.stderr.trim()}`);
    else if (head && head !== (await gitOut(["rev-parse", "@{u}"], dir)))
      out.warnings.push(`${source.id}: ${tracking} has new commits; sync fetches them`);
    return;
  }
  const fetched = await git(["fetch", "--quiet"], {
    cwd: dir,
    allowFail: true,
    timeoutMs: 300_000,
  });
  if (fetched.code !== 0) {
    out.status = "error";
    out.error = `git fetch failed: ${fetched.stderr.trim()}`;
    return;
  }
  const [ahead, behind] = (
    await gitOut(["rev-list", "--left-right", "--count", "HEAD...@{u}"], dir)
  )
    .split(/\s+/)
    .map(Number);
  if (ahead) {
    const lost = await rewrittenAway(dir, tracking);
    if (lost > 0) {
      out.status = "held";
      out.held = {
        reason: `${tracking} was force-pushed and no longer has ${lost} commit${lost === 1 ? "" : "s"} checked out here; it stays at ${before.slice(0, 7)} until you reset or push it`,
        files: [],
      };
      return;
    }
  }
  if (!behind) return;
  const incoming = (await gitOut(["diff", "--name-only", "-z", "HEAD", "@{u}"], dir))
    .split("\0")
    .filter(Boolean);
  if (ahead) {
    out.status = "held";
    out.held = {
      reason: `${ahead} local commit${ahead === 1 ? "" : "s"} not on ${tracking}`,
      files: [],
    };
    return;
  }
  if (source.update === "review" && !ctx.apply) {
    out.status = "review";
    out.pending = [{ skill: "*", reason: "review", files: incoming }];
    return;
  }
  const dirty = await localEdits(dir, clashes);
  const overlap = incoming.filter((file) => dirty.has(file));
  if (overlap.length > 0) {
    out.status = "held";
    out.held = { reason: "local edits touch files that changed upstream", files: overlap };
    return;
  }
  let merged = await git(["merge", "--ff-only", "--quiet", "@{u}"], { cwd: dir, allowFail: true });
  // git refuses to overwrite a file it sees as changed, and it sees a name clash that way.
  if (merged.code !== 0 && incoming.some((file) => clashes.has(file)))
    merged = await moveAroundClashes(
      dir,
      await gitOut(["rev-parse", "@{u}"], dir),
      incoming,
      clashes,
    );
  if (merged.code !== 0) {
    out.status = "held";
    out.held = { reason: merged.stderr.trim() || "git merge --ff-only failed", files: [] };
    return;
  }
  out.status = "updated";
  out.to = await gitOut(["rev-parse", "HEAD"], dir);
  out.changed = [
    ...new Set([
      ...out.changed,
      ...(await gitOut(["diff", "--name-only", "-z", before, out.to], dir))
        .split("\0")
        .filter(Boolean),
    ]),
  ];
}

/** A `/`-separated path as macOS and Windows compare it. */
const pathKey = (path: string) => path.split("/").map(nameKey).join("/");

/** Files with uncommitted changes in a working clone, untracked ones too, but not `clashes`. */
async function localEdits(dir: string, clashes: Clashes): Promise<Set<string>> {
  const status = await git(["status", "--porcelain=v1", "-z", "--untracked-files=all"], {
    cwd: dir,
  });
  return new Set(parsePorcelain(status.stdout).filter((file) => !clashes.has(file)));
}

/** Tracked files that share one file on macOS and Windows, each mapped to the one kept there. */
type Clashes = ReadonlyMap<string, string>;

/**
 * Warns for the paths of a working clone that Windows can't write (`windowsNames`), as for a git
 * source. Returns the files whose paths differ only in case or Unicode form (skills/Foo/SKILL.md
 * and skills/foo/SKILL.md), when what is on disk is one of their committed versions. macOS and
 * Windows check such paths out into one file, so git sees all but one of them as changed; that is
 * not a local edit, and must not hold the rest of the clone back. Warns once for each clash. With
 * `write`, the shared file is made to hold the path first in byte order, the one the git cache and
 * every other system link.
 */
async function nameClashes(
  source: CloneSource,
  dir: string,
  warnings: string[],
  write: boolean,
): Promise<Clashes> {
  const entries = (await gitOut(["ls-files", "--stage", "-z"], dir))
    .split("\0")
    .filter(Boolean)
    .map((line) => {
      const [meta, path] = line.split("\t") as [string, string];
      return { blob: meta.split(" ")[1]!, path };
    });
  windowsNames(source, refusals(entries.map((entry) => entry.path)), warnings);
  const found = collisions(entries.map((entry) => entry.path));
  for (const { path, kept } of found)
    warnings.push(
      `${source.id}: ${kept} and ${path} differ only in case or Unicode form, so macOS and Windows check them out as one folder; skillfleet uses ${kept} there, and git's view of the other is not a local edit. Rename one of them upstream`,
    );
  const clashes = new Map<string, string>();
  if (found.length === 0) return clashes;
  const groups = new Map<string, typeof entries>();
  for (const entry of entries) {
    const key = pathKey(entry.path);
    groups.set(key, [...(groups.get(key) ?? []), entry]);
  }
  for (const group of groups.values()) {
    if (group.length < 2) continue;
    group.sort((a, b) => Buffer.compare(Buffer.from(a.path), Buffer.from(b.path)));
    const blobs = new Set(group.map((entry) => entry.blob));
    let explained = true;
    let keptOnDisk = true;
    for (const entry of group) {
      const file = join(dir, entry.path);
      const onDisk = lstatSync(file, { throwIfNoEntry: false })?.isFile()
        ? await gitOut(["hash-object", "--", entry.path], dir)
        : undefined;
      if (onDisk === undefined || !blobs.has(onDisk)) explained = false;
      if (entry === group[0] && onDisk !== entry.blob) keptOnDisk = false;
    }
    if (!explained) continue;
    for (const entry of group) clashes.set(entry.path, group[0]!.path);
    if (write && !keptOnDisk)
      await git(["checkout-index", "--force", "-z", "--stdin"], {
        cwd: dir,
        input: `${group[0]!.path}\0`,
      });
  }
  return clashes;
}

/**
 * Moves a working clone to `commit` and writes the `incoming` files, when some of them clash by
 * name: git's own merge and checkout refuse, since they see the clash as a local edit. The caller
 * checked that no other local edit touches an incoming file. The kept path of each clash is
 * written last, so on macOS and Windows the file they share holds it.
 */
async function moveAroundClashes(
  dir: string,
  commit: string,
  incoming: readonly string[],
  clashes: Clashes,
) {
  const reset = await git(["reset", "--quiet", "--mixed", commit], { cwd: dir, allowFail: true });
  if (reset.code !== 0) return reset;
  const tracked = new Set((await gitOut(["ls-files", "-z"], dir)).split("\0").filter(Boolean));
  const trackedKeys = new Set([...tracked].map(pathKey));
  for (const file of incoming)
    // A removed path that shares its file with a tracked one on this disk stays.
    if (!trackedKeys.has(pathKey(file))) {
      rmSync(join(dir, file), { force: true });
      // Like git, leave no folder a removal emptied.
      for (let parent = dirname(file); parent !== "."; parent = dirname(parent))
        try {
          rmdirSync(join(dir, parent));
        } catch {
          break;
        }
    }
  const kept = new Set(incoming.flatMap((file) => clashes.get(file) ?? []));
  const write = [
    ...incoming.filter((file) => tracked.has(file) && !kept.has(file)),
    ...[...kept].filter((file) => tracked.has(file)),
  ];
  return git(["checkout-index", "--force", "-z", "--stdin"], {
    cwd: dir,
    allowFail: true,
    input: write.map((file) => `${file}\0`).join(""),
  });
}

/** Local commits that `tracking` once had and lost: upstream rewrote its history under them. */
async function rewrittenAway(dir: string, tracking: string): Promise<number> {
  const reflog = await git(["reflog", "show", "--format=%H", "-n", "50", tracking, "--"], {
    cwd: dir,
    allowFail: true,
  });
  const previous = reflog.stdout.split("\n").filter(Boolean);
  if (reflog.code !== 0 || previous.length === 0) return 0;
  const local = new Set((await gitOut(["rev-list", "HEAD", "--not", "@{u}"], dir)).split("\n"));
  const dropped = (await gitOut(["rev-list", ...previous, "--not", "@{u}"], dir)).split("\n");
  return dropped.filter((commit) => commit && local.has(commit)).length;
}

export async function syncLocal(
  source: Extract<Source, { kind: "local" }>,
  state: SourceState,
  ctx: SourceContext,
) {
  const out = result(source, "unchanged");
  if (!existsSync(source.local)) {
    out.status = "error";
    out.error = `${source.local} does not exist`;
    return out;
  }
  out.skills = await discoverInPlace(source, source.local, out.warnings);
  // A folder has no commits to compare, so each skill's files are hashed, as the store's are, and
  // the changes go to hooks as paths inside the folder.
  const now = new Map(out.skills.map((skill) => [skill.name, hashDir(skill.dir)]));
  const at = (name: string, path: string | undefined) => filesAt(source, { name, path });
  for (const [name, record] of Object.entries(state.skills))
    if (!now.has(name))
      out.changed.push(
        ...Object.keys(record.hashes).map((file) => `${at(name, record.path)}${file}`),
      );
  for (const skill of out.skills) {
    const files = changedFiles(state.skills[skill.name]?.hashes ?? {}, now.get(skill.name)!);
    out.changed.push(...files.map((file) => `${at(skill.name, skill.path)}${file}`));
  }
  if (!state.fetchedAt) out.status = "installed";
  else if (out.changed.length > 0) out.status = "updated";
  state.skills = dict(
    out.skills.map((skill) => [
      skill.name,
      { hashes: now.get(skill.name)!, ...(skill.path === undefined ? {} : { path: skill.path }) },
    ]),
  );
  state.fetchedAt = ctx.now;
  return out;
}

// ---------------------------------------------------------------------------
// Vendored sources: copied into the store, guarded against overwriting local edits.

/** A skill's three folders in its source's store. Throws for a name that is not one plain folder name. */
export function storePaths(storeDir: string, name: string) {
  assertSegment(name);
  return {
    live: join(storeDir, "live", name),
    base: join(storeDir, "base", name),
    upstream: join(storeDir, "upstream", name),
  };
}

/** Whether a path of a source's repository is where its `skills` glob looks, or on the way there. */
function lookedAt(source: Source): (path: string) => boolean {
  const base = source.kind !== "index" && source.skills ? globBase(source.skills) : "";
  return (path) =>
    !base || path === base || path.startsWith(`${base}/`) || base.startsWith(`${path}/`);
}

/**
 * A warning for each path of a git source or working clone that Windows can't write: Windows
 * leaves it out, as git does there, and Linux and macOS keep it, as git does there, so the
 * fleet's Windows machines lack it.
 */
function windowsNames(source: Source, refused: readonly Refusal[], warnings: string[]) {
  const looked = lookedAt(source);
  for (const { path, problem } of refused)
    if (looked(path))
      warnings.push(
        problem === GIT_FOLDER
          ? `${source.id}: left out ${path} on every system: its name ${problem}; rename it upstream`
          : process.platform === "win32"
            ? `${source.id}: left out ${path}: its name ${problem}; rename it upstream`
            : `${source.id}: Windows machines lack ${path}: its name ${problem}; rename it upstream so every machine has it`,
      );
}

/** Fetches a vendored source and returns the skills `skills` would install from it. */
async function openVendored(
  source: VendoredSource,
  state: SourceState,
  ctx: SourceContext,
  warnings: string[],
) {
  switch (source.kind) {
    case "git": {
      const clone = await fetchClone(gitUrl(source.git), source.ref, join(ctx.cacheDir, "git"));
      const looked = lookedAt(source);
      for (const { path, kept } of clone.collisions)
        if (looked(path))
          warnings.push(
            `${source.id}: left out ${path}: macOS and Windows keep it in the same folder as ${kept}`,
          );
      windowsNames(source, clone.refused, warnings);
      return {
        handle: await discover(clone.dir, source.skills).catch((error: unknown): SkillSource => {
          // Only the linked-folder pass can rescue this specific empty discovery result.
          if (
            !source.skills ||
            !isDiagnostic(error, "SKILLS_NO_VALID_SKILLS") ||
            linkedFolders(source, clone.dir, [], []).length === 0
          )
            throw error;
          return {
            source: { input: clone.dir, type: "local", url: clone.dir },
            skills: [],
            dispose: async () => {},
          };
        }),
        version: clone.commit,
        glob: source.skills,
        root: clone.dir,
        submodules: clone.submodules,
        earlier: async (path: string, live: string) =>
          clone.repo !== undefined &&
          (
            await Promise.all(
              [...new Set([state.commit, clone.previous])]
                .filter(
                  (commit): commit is string => commit !== undefined && commit !== clone.commit,
                )
                .map((commit) => copyOfCommit(clone.repo!, commit, path, live)),
            )
          ).some(Boolean),
      };
    }
    case "npm": {
      const pkg = await fetchNpm(source.npm, source.registry, join(ctx.cacheDir, "npm"), {
        sendToken: source.sendToken,
      });
      return {
        handle: await discover(pkg.dir, source.skills),
        version: pkg.version,
        glob: source.skills,
        root: pkg.dir,
        submodules: [],
        earlier: async (path: string, live: string) =>
          earlierPackages(join(ctx.cacheDir, "npm"), source.npm, pkg.dir).some((dir) =>
            sameCopy(join(dir, path), live),
          ),
      };
    }
    case "index":
      return {
        handle: await resolveSource(source.index, { config: SKILLS_OPTIONS }),
        version: state.commit,
        glob: undefined,
        root: undefined,
        submodules: [],
        // `skills` keeps no archive it downloaded, so there is no earlier copy to compare with.
        earlier: async () => false,
      };
    default: {
      const exhaustive: never = source;
      return exhaustive;
    }
  }
}

/** The most one source's skills hold together; see `SKILL_LIMITS` for one skill. */
const SOURCE_LIMITS = { files: 50_000, bytes: 1024 * 1024 * 1024 };

function sourceBudget() {
  return { files: 0, bytes: 0 };
}

/**
 * The folder `skills` should copy the skill `name` from: `dir` itself, or, when `dir` holds links
 * to folders (which `skills` follows, so links that fan out to one another copy one folder
 * thousands of times), a copy beside `staging` that holds each folder once (see `copyResolved`).
 * Undefined, with a warning, for a skill past `SKILL_LIMITS` or the source's `SOURCE_LIMITS`.
 */
function copyableSkill(
  source: Source,
  name: string,
  dir: string,
  staging: string,
  budget: ReturnType<typeof sourceBudget>,
  warnings: string[],
): string | undefined {
  const skip = (why: string) => {
    warnings.push(`${source.id}: skipped the skill "${name}": ${why}`);
    return undefined;
  };
  const count = (at: string, files: number, bytes: number) => {
    budget.files += files;
    budget.bytes += bytes;
    if (budget.files > SOURCE_LIMITS.files)
      return skip(`${source.id}'s skills hold more than ${SOURCE_LIMITS.files} files together`);
    if (budget.bytes > SOURCE_LIMITS.bytes)
      return skip(
        `${source.id}'s skills hold more than ${SOURCE_LIMITS.bytes / 1024 ** 3} GB together`,
      );
    return at;
  };
  const one = skillBudget();
  let files = 0;
  let bytes = 0;
  let folderLinks = false;
  const walk = (current: string, rel: string) => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const path = join(current, entry.name);
      const childRel = rel ? `${rel}/${entry.name}` : entry.name;
      one.depth(childRel);
      if (entry.isDirectory()) walk(path, childRel);
      else if (entry.isSymbolicLink()) {
        try {
          if (statSync(path).isDirectory()) folderLinks = true;
        } catch {}
      } else if (entry.isFile()) {
        const size = lstatSync(path).size;
        one.file(size);
        files++;
        bytes += size;
      }
    }
  };
  try {
    walk(dir, "");
    if (!folderLinks) return count(dir, files, bytes);
    const copy = join(staging, "fanned-from", name);
    const again = copyResolved(dir, copy, dir)
      .filter((link) => link.reason === "again")
      .map((link) => link.path);
    if (again.length > 0)
      warnings.push(
        `${source.id}: ${name}: left out ${again.length} link${again.length === 1 ? "" : "s"} to a folder the skill holds already (${again.slice(0, 3).join(", ")}${again.length > 3 ? ", …" : ""}); each folder is copied once`,
      );
    return count(copy, listFiles(copy).length, bytesOf(copy));
  } catch (error) {
    if (error instanceof SkillTooLargeError) return skip(error.message);
    throw error;
  }
}

/** Bytes in the files under `dir`, links not followed. */
function bytesOf(dir: string): number {
  let total = 0;
  for (const file of listFiles(dir)) {
    const stat = lstatSync(join(dir, file));
    if (stat.isFile()) total += stat.size;
  }
  return total;
}

/** The file `skills` leaves out of a copy, and the folders it skips. */
const NOT_COPIED_FILES = new Set(["metadata.json"]);
const NOT_COPIED_DIRS = new Set([".git", "__pycache__", "__pypackages__"]);

/** Whether `skills` leaves the file at the `/`-separated `rel` out of the copy it installs. */
const notCopied = (rel: string) => {
  const parts = rel.split("/");
  return parts.some((part, i) =>
    i < parts.length - 1 ? NOT_COPIED_DIRS.has(part) : NOT_COPIED_FILES.has(part),
  );
};

/** git's blob id of `data`; a copy written out with CRLF line endings is also tried with LF. */
const blobIds = (data: Buffer) => {
  const id = (bytes: Buffer) =>
    createHash("sha1").update(`blob ${bytes.length}\0`).update(bytes).digest("hex");
  const ids = [id(data)];
  if (data.includes("\r\n"))
    ids.push(id(Buffer.from(data.toString("latin1").replace(/\r\n/g, "\n"), "latin1")));
  return ids;
};

/**
 * Whether the folder `live` holds exactly the files of `path` at `commit` in the repository
 * `repo`, as `skills` copies them: a copy installed then and never edited.
 */
async function copyOfCommit(repo: string, commit: string, path: string, live: string) {
  const listed = await git(
    ["ls-tree", "-r", "-z", "--full-tree", commit, ...(path === "." ? [] : ["--", path])],
    { cwd: repo, allowFail: true },
  );
  if (listed.code !== 0) return false;
  const want = new Map<string, string>();
  for (const line of listed.stdout.split("\0").filter(Boolean)) {
    const tab = line.indexOf("\t");
    const [mode, type, id] = line.slice(0, tab).split(" ");
    const file = line.slice(tab + 1);
    const rel = path === "." ? file : file.slice(path.length + 1);
    if (type !== "blob" || notCopied(rel)) continue;
    // A link is copied as what it resolves to, which the tree does not say.
    if (mode === "120000") return false;
    want.set(rel, id!);
  }
  const have = listFiles(live);
  if (have.length !== want.size) return false;
  return have.every((rel) => {
    const id = want.get(rel);
    const file = join(live, rel);
    return id !== undefined && lstatSync(file).isFile() && blobIds(readFileSync(file)).includes(id);
  });
}

/** Whether `dir` (a skill folder in an unpacked package) is what `skills` copied into `live`. */
function sameCopy(dir: string, live: string) {
  if (!existsSync(dir)) return false;
  const files = Object.entries(hashDir(dir)).filter(([rel]) => !notCopied(rel));
  return sameTree(Object.fromEntries(files), hashDir(live));
}

/** Other versions of the npm package `spec` that the cache still holds, unpacked. */
function earlierPackages(cache: string, spec: string, current: string): string[] {
  const prefix = `${parseNpmSpec(spec).name.replace("/", "+")}@`;
  let names: string[];
  try {
    names = readdirSync(cache);
  } catch {
    return [];
  }
  return names
    .filter((name) => name.startsWith(prefix) && !name.endsWith(".tmp"))
    .map((name) => join(cache, name))
    .filter((dir) => dir !== current);
}

/** The names in a well-known index, read directly so skills it rejected can be reported. */
async function indexNames(url: string): Promise<string[] | undefined> {
  const base = url.replace(/\/$/, "");
  for (const path of [".well-known/agent-skills/index.json", ".well-known/skills/index.json"]) {
    try {
      const response = await fetch(`${base}/${path}`, { signal: AbortSignal.timeout(15_000) });
      if (!response.ok) continue;
      const index: unknown = await response.json();
      if (
        typeof index !== "object" ||
        index === null ||
        !("skills" in index) ||
        !Array.isArray(index.skills)
      )
        continue;
      return index.skills.flatMap((entry: unknown) =>
        typeof entry === "object" &&
        entry !== null &&
        "name" in entry &&
        typeof entry.name === "string"
          ? [entry.name]
          : [],
      );
    } catch {
      continue;
    }
  }
  return undefined;
}

/** The skills already in the store, used offline and when a fetch fails. */
function keptSkills(state: SourceState, storeDir: string): SkillEntry[] {
  return Object.entries(state.skills)
    .filter(([name]) => existsSync(storePaths(storeDir, name).live))
    .map(([name, copy]) => ({ name, dir: storePaths(storeDir, name).live, path: copy.path }));
}

/** Where a sync stages what it fetched: in the store, so a staged folder is renamed into place. */
const STAGE = /^\.stage-(\d+)$/;

/**
 * Cleans up after a sync that was killed: its staging folder goes, and a folder it was replacing
 * is finished or put back (see `replaceDir`). It runs under the sync lock, so no other sync is
 * using any of them, whoever has the pid in their names now.
 */
function recoverStore(storeDir: string) {
  if (!existsSync(storeDir)) return;
  for (const name of readdirSync(storeDir))
    if (STAGE.test(name)) rmSync(join(storeDir, name), { recursive: true, force: true });
  for (const part of ["live", "base", "upstream"]) recoverReplaced(join(storeDir, part));
}

/**
 * Install records for skills in the store that state.json does not have (it was lost, or a sync
 * was killed before it wrote one): the base the store keeps is what was installed. Returns their
 * names.
 */
function rebuildRecords(state: SourceState, storeDir: string): string[] {
  const live = join(storeDir, "live");
  if (!existsSync(live)) return [];
  const rebuilt: string[] = [];
  for (const name of readdirSync(live)) {
    if (state.skills[name] || segmentProblem(name)) continue;
    const base = storePaths(storeDir, name).base;
    if (!existsSync(base)) continue;
    state.skills[name] = { hashes: hashDir(base) };
    rebuilt.push(name);
  }
  return rebuilt.sort();
}

/**
 * Whether a fetch brought nothing to apply: the same commit or version as last time, the same
 * skills, every one still in the store, and nothing waiting. Then nothing is staged or copied.
 */
function nothingNew(
  source: VendoredSource,
  state: SourceState,
  ctx: SourceContext,
  version: string | undefined,
  chosen: readonly Found[],
): boolean {
  // A well-known index has no version to compare.
  if (source.kind === "index" || version === undefined) return false;
  if (version !== (source.kind === "npm" ? state.version : state.commit)) return false;
  if (Object.keys(state.pending).length > 0) return false;
  if (chosen.length !== Object.keys(state.skills).length) return false;
  return chosen.every(
    (skill) =>
      state.skills[skill.name]?.path === skill.path &&
      existsSync(storePaths(ctx.storeDir, skill.name).live),
  );
}

export async function syncVendored(
  source: VendoredSource,
  state: SourceState,
  ctx: SourceContext,
): Promise<SourceResult> {
  if (source.kind !== "index") return fetchVendored(source, state, ctx);
  // `skills` downloads and unpacks an index's archives itself, with no limit on either.
  const refused: string[] = [];
  const mismatched = new Map<string, string>();
  const out = await withCappedFetch(
    () => withDigestCheck(() => fetchVendored(source, state, ctx, mismatched), mismatched),
    refused,
  );
  out.warnings.push(...refused.map((why) => `${source.id}: refused ${why}`));
  return out;
}

/** An index file of a well-known source, at either path `skills` reads. */
const INDEX_FILE = /\/\.well-known\/(?:agent-skills|skills)\/index\.json$/;

/**
 * Runs `work` with every archive an index lists checked against the digest the index gives,
 * before `skills` sees it. `skills` gives up on the whole index at the first mismatch; here a
 * mismatched archive reads as a failed download instead, which drops only its skill, and its name
 * goes into `mismatched` with the digest received.
 */
async function withDigestCheck<T>(work: () => Promise<T>, mismatched: Map<string, string>) {
  const original = globalThis.fetch;
  const expected = new Map<string, { name: string; digest: string }>();
  globalThis.fetch = async (input, init) => {
    const response = await original(input, init);
    const url = input instanceof Request ? input.url : String(input);
    const path = (() => {
      try {
        return new URL(url).pathname;
      } catch {
        return "";
      }
    })();
    const listed = expected.get(url);
    if (!response.ok || (!listed && !INDEX_FILE.test(path))) return response;
    const body = new Uint8Array(await response.arrayBuffer());
    if (listed) {
      const digest = `sha256:${createHash("sha256").update(body).digest("hex")}`;
      if (digest !== listed.digest) {
        mismatched.set(listed.name, digest);
        return new Response(null, { status: 502, statusText: "digest mismatch" });
      }
    } else
      try {
        const index: unknown = JSON.parse(new TextDecoder().decode(body));
        const skills = isRecord(index) && Array.isArray(index.skills) ? index.skills : [];
        for (const entry of skills)
          if (
            isRecord(entry) &&
            typeof entry.name === "string" &&
            typeof entry.url === "string" &&
            typeof entry.digest === "string"
          )
            expected.set(new URL(entry.url, url).toString(), {
              name: entry.name,
              digest: entry.digest,
            });
      } catch {}
    const copy = new Response(body, {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    });
    Object.defineProperty(copy, "url", { value: response.url });
    return copy;
  };
  try {
    return await work();
  } finally {
    globalThis.fetch = original;
  }
}

async function fetchVendored(
  source: VendoredSource,
  state: SourceState,
  ctx: SourceContext,
  /** Index skills whose archive did not match its digest, with the digest received. */
  mismatched: ReadonlyMap<string, string> = new Map(),
): Promise<SourceResult> {
  const out = result(source, "unchanged");
  out.from = state.commit ?? state.version;
  // A name recorded before names were checked cannot be touched safely, so it is forgotten.
  for (const name of new Set([...Object.keys(state.skills), ...Object.keys(state.pending)]))
    if (segmentProblem(name)) {
      delete state.skills[name];
      delete state.pending[name];
      out.warnings.push(
        `${source.id}: forgot the skill "${name}": its name ${segmentProblem(name)}`,
      );
    }
  if (!ctx.dryRun) recoverStore(ctx.storeDir);
  const rebuilt = rebuildRecords(state, ctx.storeDir);
  if (rebuilt.length > 0)
    out.warnings.push(
      `${source.id}: state.json had no install record of ${rebuilt.join(", ")}, so skillfleet rebuilt it from the copy it kept in the store`,
    );
  const firstRun = Object.keys(state.skills).length === 0;
  // Local edits are checked on every run, online or not.
  for (const [name, copy] of Object.entries(state.skills)) {
    const live = storePaths(ctx.storeDir, name).live;
    if (!existsSync(live)) continue;
    const files = changedFiles(copy.hashes, hashDir(live));
    if (files.length > 0) out.edited.push({ skill: name, files });
  }
  for (const [skill, pending] of Object.entries(state.pending)) {
    const upstream = storePaths(ctx.storeDir, skill).upstream;
    const base = state.skills[skill]?.hashes ?? {};
    out.pending.push({
      skill,
      reason: pending.reason,
      files: existsSync(upstream) ? changedFiles(base, hashDir(upstream)) : [],
    });
  }
  if (ctx.offline) {
    out.status = "offline";
    out.skills = keptSkills(state, ctx.storeDir);
    if (!state.fetchedAt && out.skills.length === 0) neverFetched(out, ctx, "nothing is cached");
    return out;
  }
  let opened: Awaited<ReturnType<typeof openVendored>>;
  try {
    opened = await openVendored(source, state, ctx, out.warnings);
  } catch (error) {
    out.status = "error";
    out.error = message(error);
    out.skills = keptSkills(state, ctx.storeDir);
    if (out.skills.length > 0)
      out.warnings.push(
        `${source.id}: kept the last good copy (${state.fetchedAt ?? "unknown date"})`,
      );
    return out;
  }
  let staging: string | undefined;
  try {
    const escaping = opened.root
      ? escapingSkills(
          source,
          opened.handle,
          join(opened.root, globBase(opened.glob ?? "")),
          opened.root,
          out.warnings,
        )
      : new Set<string>();
    const found: Found[] = opened.handle.skills
      .filter((skill) => !escaping.has(skill.name))
      .map((skill) => ({
        name: skill.name,
        path: withBase(opened.glob, skill.path),
      }));
    const linked = opened.root ? linkedFolders(source, opened.root, found, out.warnings) : [];
    found.push(...linked);
    if (opened.root)
      unfetchedSubmodules(source, opened.root, found, opened.submodules, out.warnings);
    const chosen = select(source, plainNames(source, found, out.warnings), out.warnings);
    if (source.kind === "index") {
      const listed = await indexNames(source.index);
      const got = new Set(found.map((skill) => skill.name));
      for (const name of listed ?? [])
        if (!got.has(name) && !mismatched.has(name))
          out.warnings.push(`${source.id}: rejected "${name}": its archive is invalid or unsafe`);
    }
    // A mismatched archive (a deploy in flight serving an old one) holds back only its skill.
    const heldBack = new Set<string>();
    for (const [name, digest] of mismatched) {
      const kept =
        state.skills[name] !== undefined &&
        existsSync(storePaths(ctx.storeDir, name).live) &&
        select(source, [{ name }], []).length > 0;
      if (kept) heldBack.add(name);
      out.warnings.push(
        `${source.id}: the archive of "${name}" does not match the digest the index gives (received ${digest}), so ${kept ? "it keeps its last good copy" : "it is not installed"}; the index's other skills update as usual`,
      );
    }
    if (nothingNew(source, state, ctx, opened.version, chosen)) {
      out.skills = chosen.map((skill) => ({
        name: skill.name,
        dir: storePaths(ctx.storeDir, skill.name).live,
        path: skill.path,
      }));
      state.fetchedAt = ctx.now;
      out.to = opened.version;
      return out;
    }
    // In the store, on its file system, so what is staged is renamed into place, not copied.
    if (ctx.dryRun) staging = mkdtempSync(join(tmpdir(), "skillfleet-stage-"));
    else {
      staging = join(ctx.storeDir, `.stage-${process.pid}`);
      rmSync(staging, { recursive: true, force: true });
      mkdirSync(staging, { recursive: true });
    }
    const staged = new Map<string, string>();
    const install = async (handle: SkillSource, names: string[], cwd: string) => {
      const installed = await installSkills(handle, {
        cwd,
        scope: "project",
        agents: ["universal"],
        mode: "copy",
        lockfile: false,
        telemetry: false,
        skills: names,
      });
      for (const failure of installed.failed)
        out.warnings.push(`${source.id}: ${failure.skill}: ${failure.message}`);
      return installed.installed;
    };
    // Each skill's folder is measured before `skills` copies it, which follows folder links.
    const budget = sourceBudget();
    const fanned: { skill: Found; dir: string }[] = [];
    const fromHandle = chosen.filter((skill) => {
      if (linked.includes(skill as LinkedFolder)) return false;
      if (!opened.root || skill.path === undefined) return true;
      const dir = copyableSkill(
        source,
        skill.name,
        join(opened.root, skill.path),
        staging!,
        budget,
        out.warnings,
      );
      if (dir === join(opened.root, skill.path)) return true;
      if (dir) fanned.push({ skill, dir });
      return false;
    });
    if (fromHandle.length > 0)
      for (const target of await install(
        opened.handle,
        fromHandle.map((skill) => skill.name),
        staging,
      ))
        staged.set(target.skill, target.path);
    for (const [i, { skill, dir }] of fanned.entries()) {
      const handle = await discover(dir, undefined, [], true);
      try {
        for (const target of await install(handle, [skill.name], join(staging, `fanned-${i}`)))
          staged.set(skill.name, target.path);
      } finally {
        await handle.dispose();
      }
    }
    for (const [i, link] of linked.entries()) {
      if (!chosen.includes(link)) continue;
      const dir = copyableSkill(source, link.name, link.real, staging, budget, out.warnings);
      if (!dir) continue;
      // Each from its own folder, which `skills` reads as a source of one skill.
      const handle =
        dir === link.real
          ? await discover(link.real, undefined, [], false, opened.root)
          : await discover(dir, undefined, [], true);
      try {
        const name = handle.skills[0]?.name;
        const escaped = escapingSkills(source, handle, link.real, opened.root!, out.warnings);
        if (handle.skills.length !== 1 || name !== link.name || escaped.size > 0) {
          out.warnings.push(
            `${source.id}: skipped the skill "${link.name}" that ${link.path} links to: its SKILL.md names ${name ?? "no skill"}`,
          );
          continue;
        }
        for (const target of await install(handle, [name], join(staging, `link-${i}`)))
          staged.set(link.name, target.path);
      } finally {
        await handle.dispose();
      }
    }
    countCopies([...staged.values()].reduce((sum, dir) => sum + listFiles(dir).length, 0));
    if (opened.root) linkedSkillMds(source, opened.root, chosen, staged, out.warnings);
    carryRenames(state, ctx, out, chosen, staged);
    // A copy with no install record and no base (state.json and store/base lost) that differs
    // from upstream is an earlier upstream version when it matches one, and no edit.
    const earlier = new Map<string, Hashes>();
    for (const skill of chosen) {
      const from = staged.get(skill.name);
      const live = storePaths(ctx.storeDir, skill.name).live;
      if (!from || state.skills[skill.name] || skill.path === undefined || !existsSync(live))
        continue;
      const seen = hashDir(live);
      if (sameTree(hashDir(from), seen)) continue;
      if (await opened.earlier(skill.path, live)) earlier.set(skill.name, seen);
    }
    applyVendored(source, state, ctx, out, chosen, staged, {
      rebuilt,
      firstRun,
      earlier,
      heldBack,
    });
    state.fetchedAt = ctx.now;
    if (source.kind === "npm") state.version = opened.version;
    else state.commit = opened.version;
    out.to = opened.version;
  } catch (error) {
    out.status = "error";
    out.error = message(error);
    out.skills = keptSkills(state, ctx.storeDir);
  } finally {
    await opened.handle.dispose();
    if (staging) rmSync(staging, { recursive: true, force: true });
  }
  return out;
}

/**
 * Stores a SKILL.md that is a link as the file it points to, since Codex and Cursor skip a skill
 * whose SKILL.md is a link. `skills` copies a link that stays in the skill's folder as its file and
 * drops one that leaves it, leaving a skill without SKILL.md. A link to a file elsewhere in the
 * source is copied here; a skill whose SKILL.md leaves the source is dropped, with a warning.
 */
function linkedSkillMds(
  source: VendoredSource,
  root: string,
  chosen: readonly Found[],
  staged: Map<string, string>,
  warnings: string[],
) {
  const realRoot = realpathSync(root);
  for (const skill of chosen) {
    const dir = staged.get(skill.name);
    if (!dir || skill.path === undefined) continue;
    const file = join(root, skill.path, "SKILL.md");
    if (!lstatSync(file, { throwIfNoEntry: false })?.isSymbolicLink()) continue;
    let real: string | undefined;
    try {
      real = realpathSync(file);
    } catch {}
    if (real && inside(realRoot, real) && statSync(real).isFile()) {
      rmSync(join(dir, "SKILL.md"), { force: true });
      copyFileSync(real, join(dir, "SKILL.md"));
    } else {
      staged.delete(skill.name);
      warnings.push(
        `${source.id}: skipped the skill "${skill.name}": its SKILL.md links to ${real ? "a file outside the source" : "nothing"}`,
      );
    }
  }
}

/**
 * A skill whose name changed upstream only in case or Unicode form (alpha to Alpha) is the same
 * skill: its install record, a pending update, local edits and its store folders move to the new
 * name. macOS and Windows keep both names in one folder, so it is renamed through a third name.
 */
function carryRenames(
  state: SourceState,
  ctx: SourceContext,
  out: SourceResult,
  chosen: readonly Found[],
  staged: ReadonlyMap<string, string>,
) {
  const upstream = chosen.filter((skill) => staged.has(skill.name));
  const now = new Set(upstream.map((skill) => skill.name));
  for (const skill of upstream) {
    if (state.skills[skill.name]) continue;
    const old = Object.keys(state.skills).find(
      (name) => !now.has(name) && nameKey(name) === nameKey(skill.name),
    );
    if (old === undefined) continue;
    if (!ctx.dryRun) {
      const from = storePaths(ctx.storeDir, old);
      const to = storePaths(ctx.storeDir, skill.name);
      for (const kind of ["live", "base", "upstream"] as const)
        if (!renameFolder(from[kind], to[kind]) && existsSync(from[kind])) {
          // A folder under the new name with no record of its own is left over: the record wins.
          rmSync(to[kind], { recursive: true, force: true });
          renameFolder(from[kind], to[kind]);
        }
    }
    state.skills[skill.name] = { ...state.skills[old]!, path: skill.path };
    delete state.skills[old];
    if (state.pending[old]) {
      state.pending[skill.name] = state.pending[old];
      delete state.pending[old];
    }
    for (const entry of [...out.edited, ...out.pending])
      if (entry.skill === old) entry.skill = skill.name;
  }
}

/** The folder of a skill's files in what `changed` lists. */
const filesAt = (source: Source, skill: Found) =>
  source.kind === "index" || skill.path === undefined
    ? `${skill.name}/`
    : skill.path === "."
      ? ""
      : `${skill.path}/`;

function applyVendored(
  source: VendoredSource,
  state: SourceState,
  ctx: SourceContext,
  out: SourceResult,
  chosen: Found[],
  staged: Map<string, string>,
  {
    rebuilt,
    firstRun,
    earlier,
    heldBack = new Set(),
  }: {
    /** Skills whose install record was rebuilt from the store this run. */
    rebuilt: readonly string[];
    firstRun: boolean;
    /**
     * Skills without an install record whose copy is an earlier upstream version, unedited, and
     * the copy's hashes then.
     */
    earlier: ReadonlyMap<string, Hashes>;
    /** Skills upstream still has but whose download was refused: their copy stays as it is. */
    heldBack?: ReadonlySet<string>;
  },
) {
  const write = !ctx.dryRun;
  const edited = new Map(out.edited.map((entry) => [entry.skill, entry.files]));
  const pending = new Map<string, SourceResult["pending"][number]>();
  const review = source.update === "review" && !ctx.apply;
  const hold = (
    name: string,
    from: string | undefined,
    reason: "review" | "edited",
    files: string[],
  ) => {
    const paths = storePaths(ctx.storeDir, name);
    const incoming = from ? hashDir(from) : {};
    const upstreamChanged =
      !existsSync(paths.upstream) || !sameTree(hashDir(paths.upstream), incoming);
    if (write && upstreamChanged) {
      if (from) replaceDir(from, paths.upstream);
      else rmSync(paths.upstream, { recursive: true, force: true });
    }
    const since = upstreamChanged ? ctx.now : (state.pending[name]?.since ?? ctx.now);
    if (write) state.pending[name] = { reason, since };
    pending.set(name, { skill: name, reason, files });
  };
  // The base first: a kill between the two leaves a copy that matches its record or the update.
  const install = (from: string, paths: ReturnType<typeof storePaths>) => {
    replaceDir(from, paths.base);
    replaceDir(from, paths.live, { move: true });
  };
  for (const skill of chosen) {
    const from = staged.get(skill.name);
    if (!from) continue;
    const paths = storePaths(ctx.storeDir, skill.name);
    const incoming = hashDir(from);
    const record = state.skills[skill.name];
    if (!record && existsSync(paths.live)) {
      // A copy without an install record (state.json was lost): upstream becomes its base, and a
      // copy that differs from it counts as edited, so it is never overwritten.
      const seen = earlier.get(skill.name);
      // An earlier upstream copy is updated like any other, unless an edit came since.
      const files =
        seen && (!write || replaceUnchanged(from, paths.live, seen).length === 0)
          ? []
          : changedFiles(incoming, hashDir(paths.live));
      if (write) {
        replaceDir(from, paths.base);
        state.skills[skill.name] = { hashes: incoming, path: skill.path };
      }
      out.skills.push({ name: skill.name, dir: paths.live, path: skill.path });
      // New to the records (a killed sync may have copied it), so hooks hear about it again.
      out.added.push(skill.name);
      out.changed.push(...Object.keys(incoming).map((file) => `${filesAt(source, skill)}${file}`));
      if (files.length > 0) {
        out.edited.push({ skill: skill.name, files });
        out.warnings.push(
          `${source.id}: ${skill.name} has no install record and differs from upstream, so it is kept as a local edit; see \`skillfleet diff ${skill.name}\``,
        );
      }
      continue;
    }
    if ((!record || !existsSync(paths.live)) && review && !firstRun) {
      hold(skill.name, from, "review", Object.keys(incoming));
      continue;
    }
    out.skills.push({ name: skill.name, dir: paths.live, path: skill.path });
    if (!record || !existsSync(paths.live)) {
      if (write) {
        install(from, paths);
        state.skills[skill.name] = { hashes: incoming, path: skill.path };
      }
      out.added.push(skill.name);
      out.changed.push(...Object.keys(incoming).map((file) => `${filesAt(source, skill)}${file}`));
      continue;
    }
    const files = changedFiles(record.hashes, incoming);
    if (files.length === 0) {
      if (write) rmSync(paths.upstream, { recursive: true, force: true });
      delete state.pending[skill.name];
      if (write) record.path = skill.path;
      if (rebuilt.includes(skill.name)) {
        // New to the records (a killed sync may have copied it), so hooks hear about it again.
        out.added.push(skill.name);
        out.changed.push(
          ...Object.keys(incoming).map((file) => `${filesAt(source, skill)}${file}`),
        );
      }
      continue;
    }
    if (edited.has(skill.name) && sameTree(hashDir(paths.live), incoming)) {
      // The copy is already this update: a sync killed after it replaced the copy and before it
      // saved state.json. It is no edit; the record and the base catch up.
      if (write) {
        replaceDir(from, paths.base);
        rmSync(paths.upstream, { recursive: true, force: true });
        state.skills[skill.name] = { hashes: incoming, path: skill.path };
        delete state.pending[skill.name];
      }
      edited.delete(skill.name);
      out.edited = out.edited.filter((entry) => entry.skill !== skill.name);
      out.updated.push(skill.name);
      out.changed.push(...files.map((file) => `${filesAt(source, skill)}${file}`));
      continue;
    }
    const editedFiles = edited.get(skill.name);
    if (review || editedFiles) {
      hold(skill.name, from, editedFiles ? "edited" : "review", files);
      continue;
    }
    if (write) {
      // Edits were looked for before the fetch; one saved since then is caught here.
      const late = replaceUnchanged(from, paths.live, record.hashes);
      if (late.length > 0) {
        edited.set(skill.name, late);
        out.edited.push({ skill: skill.name, files: late });
        hold(skill.name, from, "edited", files);
        continue;
      }
      replaceDir(from, paths.base);
      rmSync(paths.upstream, { recursive: true, force: true });
      state.skills[skill.name] = { hashes: incoming, path: skill.path };
      delete state.pending[skill.name];
    }
    out.updated.push(skill.name);
    out.changed.push(...files.map((file) => `${filesAt(source, skill)}${file}`));
  }
  // A skill held back keeps the update it was already waiting on.
  for (const entry of out.pending)
    if (heldBack.has(entry.skill) && !pending.has(entry.skill)) pending.set(entry.skill, entry);
  out.pending = [...pending.values()].sort((a, b) => (a.skill < b.skill ? -1 : 1));
  if (write)
    for (const name of Object.keys(state.pending))
      if (!pending.has(name)) {
        delete state.pending[name];
        rmSync(storePaths(ctx.storeDir, name).upstream, { recursive: true, force: true });
      }
  const kept = new Set(chosen.filter((skill) => staged.has(skill.name)).map((skill) => skill.name));
  for (const name of Object.keys(state.skills)) {
    if (kept.has(name)) continue;
    const paths = storePaths(ctx.storeDir, name);
    if (heldBack.has(name)) {
      out.skills.push({ name, dir: paths.live, path: state.skills[name]?.path });
      continue;
    }
    if (edited.has(name) || review) {
      if (edited.has(name))
        out.warnings.push(
          `${source.id}: ${name} is gone upstream but has local edits, so it stays`,
        );
      else hold(name, undefined, "review", Object.keys(state.skills[name]?.hashes ?? {}));
      out.skills.push({ name, dir: paths.live, path: state.skills[name]?.path });
      continue;
    }
    if (write) {
      for (const dir of Object.values(paths)) rmSync(dir, { recursive: true, force: true });
      delete state.skills[name];
      delete state.pending[name];
    }
    out.removed.push(name);
  }
  if (firstRun && out.added.length > 0) out.status = "installed";
  else if (out.updated.length > 0 || out.added.length > 0 || out.removed.length > 0)
    out.status = "updated";
  else if (out.pending.some((entry) => entry.reason === "review")) out.status = "review";
}

/** Every file a hook pattern for this source could match, named as in `changed`. */
export async function sourceFiles(source: Source, result: SourceResult): Promise<string[]> {
  if (source.kind === "clone") {
    const listed = await git(["ls-files", "-z"], { cwd: source.path, allowFail: true });
    return listed.code === 0 ? listed.stdout.split("\0").filter(Boolean) : [];
  }
  return result.skills.flatMap((skill) =>
    listFiles(skill.dir).map((file) => `${filesAt(source, skill)}${file}`),
  );
}

export async function syncSource(
  source: Source,
  state: SourceState,
  ctx: SourceContext,
): Promise<SourceResult> {
  if (!ctx.dryRun) mkdirSync(ctx.storeDir, { recursive: true });
  switch (source.kind) {
    case "clone":
      return syncClone(source, state, ctx);
    case "local":
      return syncLocal(source, state, ctx);
    case "git":
    case "index":
    case "npm":
      return syncVendored(source, state, ctx);
    default: {
      const exhaustive: never = source;
      return exhaustive;
    }
  }
}
