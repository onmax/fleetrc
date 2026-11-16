import {
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, sep } from "node:path";
import { installSkills, isDiagnostic, resolveSource, type SkillSource } from "skills";
import { git, GitError, gitOut } from "./exec.ts";
import { changedFiles, copyDir, hashDir, isRecord, listFiles, sameTree } from "./fs.ts";
import { fetchClone, gitUrl, isCommitRef } from "./gitcache.ts";
import { globBase, matchesGlob } from "./glob.ts";
import type { CloneSource, InPlaceSource, Source, VendoredSource } from "./manifest.ts";
import { assertSegment, nameKey, segmentProblem } from "./names.ts";
import { fetchNpm } from "./npm.ts";
import type { SourceState } from "./state.ts";

export interface SkillEntry {
  name: string;
  /** The folder agents link to. */
  dir: string;
  /** Folder inside the source, `/`-separated. */
  path?: string;
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
  if (source.include) {
    const names = new Set(chosen.map((skill) => skill.name));
    for (const name of source.include)
      if (!names.has(name))
        warnings.push(`${source.id}: include names "${name}", which the source does not have`);
    chosen = chosen.filter((skill) => source.include!.includes(skill.name));
  }
  if (source.exclude) chosen = chosen.filter((skill) => !source.exclude!.includes(skill.name));
  return chosen;
}

const inside = (root: string, path: string) => {
  const rel = relative(root, path);
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
};

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

/** Discovers skills in a folder through the `skills` package, limited to the `skills` glob's base folder. */
async function discover(
  root: string,
  glob: string | undefined,
  skipped: string[] = [],
  followLinks = false,
): Promise<SkillSource> {
  return resolveSource(globRoot(root, glob, followLinks), {
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
  let handle: SkillSource | undefined;
  try {
    handle = await discover(root, source.skills, skipped, true);
  } catch (error) {
    if (!isDiagnostic(error, "SKILLS_NO_VALID_SKILLS") || skipped.length === 0) {
      warnings.push(`${source.id}: ${message(error)}`);
      return [];
    }
  }
  try {
    const found: Found[] = (handle?.skills ?? []).map((skill) => ({
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
    return select(source, plainNames(source, found, warnings), warnings).map((skill) => ({
      name: skill.name,
      path: skill.path,
      dir: skill.path && skill.path !== "." ? join(root, skill.path) : root,
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
      if (ctx.offline) out.status = "offline";
      else await updateClone(source, dir, before, ctx, out);
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
async function cloneAt(source: CloneSource, dir: string) {
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
  const dirty = new Set(
    parsePorcelain(
      (await git(["status", "--porcelain=v1", "-z", "--untracked-files=all"], { cwd: dir })).stdout,
    ),
  );
  const overlap = incoming.filter((file) => dirty.has(file));
  if (overlap.length > 0) {
    out.status = "held";
    out.held = {
      reason: "local edits touch files that differ at the pinned commit",
      files: overlap,
    };
    return;
  }
  const moved = await git(["checkout", "--quiet", "--detach", commit], {
    cwd: dir,
    allowFail: true,
  });
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
) {
  if (source.ref && isCommitRef(source.ref)) {
    const branch = await git(["symbolic-ref", "--quiet", "HEAD"], { cwd: dir, allowFail: true });
    if (branch.code !== 0) return updatePinned(source, source.ref, dir, before, ctx, out);
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
  const dirty = new Set(
    parsePorcelain(
      (await git(["status", "--porcelain=v1", "-z", "--untracked-files=all"], { cwd: dir })).stdout,
    ),
  );
  const overlap = incoming.filter((file) => dirty.has(file));
  if (overlap.length > 0) {
    out.status = "held";
    out.held = { reason: "local edits touch files that changed upstream", files: overlap };
    return;
  }
  const merged = await git(["merge", "--ff-only", "--quiet", "@{u}"], {
    cwd: dir,
    allowFail: true,
  });
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
  if (!state.fetchedAt) {
    out.status = "installed";
    out.changed = out.skills.flatMap((skill) =>
      listFiles(skill.dir).map((file) => `${filesAt(source, skill)}${file}`),
    );
  }
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
      const base = source.skills ? globBase(source.skills) : "";
      for (const { path, kept } of clone.collisions)
        if (!base || path === base || path.startsWith(`${base}/`) || base.startsWith(`${path}/`))
          warnings.push(
            `${source.id}: left out ${path}: macOS and Windows keep it in the same folder as ${kept}`,
          );
      return {
        handle: await discover(clone.dir, source.skills),
        version: clone.commit,
        glob: source.skills,
        root: clone.dir,
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
      };
    }
    case "index":
      return {
        handle: await resolveSource(source.index, { config: SKILLS_OPTIONS }),
        version: state.commit,
        glob: undefined,
        root: undefined,
      };
    default: {
      const exhaustive: never = source;
      return exhaustive;
    }
  }
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

export async function syncVendored(
  source: VendoredSource,
  state: SourceState,
  ctx: SourceContext,
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
  const staging = mkdtempSync(join(tmpdir(), "skillfleet-stage-"));
  try {
    const found = opened.handle.skills.map((skill) => ({
      name: skill.name,
      path: withBase(opened.glob, skill.path),
    }));
    const chosen = select(source, plainNames(source, found, out.warnings), out.warnings);
    if (source.kind === "index") {
      const listed = await indexNames(source.index);
      const got = new Set(found.map((skill) => skill.name));
      for (const name of listed ?? [])
        if (!got.has(name))
          out.warnings.push(`${source.id}: rejected "${name}": its archive is invalid or unsafe`);
    }
    const staged = new Map<string, string>();
    if (chosen.length > 0) {
      const installed = await installSkills(opened.handle, {
        cwd: staging,
        scope: "project",
        agents: ["universal"],
        mode: "copy",
        lockfile: false,
        telemetry: false,
        skills: chosen.map((skill) => skill.name),
      });
      for (const target of installed.installed) staged.set(target.skill, target.path);
      for (const failure of installed.failed)
        out.warnings.push(`${source.id}: ${failure.skill}: ${failure.message}`);
      if (opened.root) linkedSkillMds(source, opened.root, chosen, staged, out.warnings);
    }
    applyVendored(source, state, ctx, out, chosen, staged, firstRun);
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
    rmSync(staging, { recursive: true, force: true });
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
  firstRun: boolean,
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
      if (from) copyDir(from, paths.upstream);
      else rmSync(paths.upstream, { recursive: true, force: true });
    }
    const since = upstreamChanged ? ctx.now : (state.pending[name]?.since ?? ctx.now);
    if (write) state.pending[name] = { reason, since };
    pending.set(name, { skill: name, reason, files });
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
      const files = changedFiles(incoming, hashDir(paths.live));
      if (write) {
        copyDir(from, paths.base);
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
        copyDir(from, paths.live);
        copyDir(from, paths.base);
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
      continue;
    }
    const editedFiles = edited.get(skill.name);
    if (review || editedFiles) {
      hold(skill.name, from, editedFiles ? "edited" : "review", files);
      continue;
    }
    if (write) {
      copyDir(from, paths.live);
      copyDir(from, paths.base);
      rmSync(paths.upstream, { recursive: true, force: true });
      state.skills[skill.name] = { hashes: incoming, path: skill.path };
      delete state.pending[skill.name];
    }
    out.updated.push(skill.name);
    out.changed.push(...files.map((file) => `${filesAt(source, skill)}${file}`));
  }
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
