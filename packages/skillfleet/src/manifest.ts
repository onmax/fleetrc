import { existsSync, statSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { getSupportedAgents } from "skills";
import { fetchClone, gitUrl, splitRepoPath } from "./gitcache.ts";
import { isRecord, readJson, readJsonFile, writeJson } from "./fs.ts";
import { nameKey, sourceIdProblem } from "./names.ts";
import { registryUrl, urlOrigin } from "./npm.ts";
import { expandPath, paths } from "./paths.ts";
import { cronProblem, timeZoneProblem } from "./timer.ts";

export type UpdateMode = "auto" | "review";

interface SourceCommon {
  id: string;
  /** Glob of skill folders inside the source, e.g. `skills/*`. */
  skills?: string;
  include?: string[];
  exclude?: string[];
  update: UpdateMode;
  /** The manifest that declared the source. */
  origin: string;
}

/** A git repository you work in: updated with fetch + fast-forward, linked in place. */
export interface CloneSource extends SourceCommon {
  kind: "clone";
  git: string;
  ref?: string;
  path: string;
  adopt: boolean;
}

/** A git repository skillfleet keeps a copy of. */
export interface GitSource extends SourceCommon {
  kind: "git";
  git: string;
  ref?: string;
}

/** A site serving `/.well-known/agent-skills/index.json`. */
export interface IndexSource extends SourceCommon {
  kind: "index";
  index: string;
}

export interface NpmSource extends SourceCommon {
  kind: "npm";
  npm: string;
  registry?: string;
  /** Send NPM_TOKEN to this registry: false when only an extended manifest names it. */
  sendToken: boolean;
}

/** A folder on this machine, linked in place. */
export interface LocalSource extends SourceCommon {
  kind: "local";
  local: string;
  adopt: boolean;
}

export type Source = CloneSource | GitSource | IndexSource | NpmSource | LocalSource;
export type VendoredSource = GitSource | IndexSource | NpmSource;
export type InPlaceSource = CloneSource | LocalSource;

/** Kinds copied into the store, rather than linked where they are. */
export const isVendoredKind = (kind: Source["kind"]): kind is VendoredSource["kind"] =>
  kind === "git" || kind === "index" || kind === "npm";

export const isVendored = (source: Source): source is VendoredSource => isVendoredKind(source.kind);

export interface Hook {
  name: string;
  run: string;
  /** `<source>:<glob>` patterns; the hook runs when a matching file changed. */
  on: string[];
}

export interface Fork {
  from: string;
  path: string;
  base: string;
}

export interface Manifest {
  file: string;
  extends: string[];
  agents: "all" | string[];
  sources: Source[];
  forks: Record<string, Fork>;
  hooks: Hook[];
  fleet: string[];
  hub?: string;
  report?: { run: string };
  timer: { cron: string; timeZone?: string };
}

export class ManifestError extends Error {}

const SOURCE_KEYS = new Set([
  "id",
  "git",
  "ref",
  "path",
  "index",
  "npm",
  "registry",
  "local",
  "skills",
  "include",
  "exclude",
  "update",
  "adopt",
]);
const ROOT_KEYS = new Set([
  "$schema",
  "extends",
  "agents",
  "sources",
  "forks",
  "hooks",
  "fleet",
  "hub",
  "report",
  "timer",
]);

function fail(file: string, at: string, message: string): never {
  throw new ManifestError(`${file}: ${at} ${message}`);
}

function stringList(file: string, at: string, value: unknown): string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || !value.every((item) => typeof item === "string"))
    fail(file, at, "must be an array of strings");
  return value;
}

function optionalString(file: string, at: string, value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || value === "") fail(file, at, "must be a non-empty string");
  return value;
}

/** A `skills` glob stays inside its source: relative, with no `..` folder. */
function skillsGlob(file: string, at: string, value: unknown): string | undefined {
  const glob = optionalString(file, at, value);
  if (glob === undefined) return undefined;
  if (/^[/\\]|^[A-Za-z]:/.test(glob)) fail(file, at, `"${glob}" must be relative to the source`);
  if (glob.split(/[/\\]/).includes("..")) fail(file, at, `"${glob}" must not leave the source`);
  return glob;
}

/** git reads a URL, path or ref that starts with `-` as an option. */
function notOption(file: string, at: string, value: string | undefined): string | undefined {
  if (value?.startsWith("-")) fail(file, at, `"${value}" must not start with "-"`);
  return value;
}

/** The id a source gets when the manifest does not name one. */
export function defaultSourceId(raw: Record<string, unknown>): string {
  const spec = [raw.git, raw.index, raw.npm, raw.local].find((value) => typeof value === "string");
  if (typeof spec !== "string") return "source";
  if (raw.index !== undefined) {
    try {
      return new URL(spec).hostname.split(".")[0] ?? "index";
    } catch {
      return "index";
    }
  }
  if (raw.npm !== undefined) return spec.replace(/^@/, "").replace(/@.*$/, "").replace(/\//g, "-");
  return basename(spec.replace(/\.git$/, "").replace(/[\\/]+$/, "")) || "source";
}

function parseSource(file: string, at: string, raw: unknown, base: string): Source {
  if (!isRecord(raw)) fail(file, at, "must be an object");
  for (const key of Object.keys(raw))
    if (!SOURCE_KEYS.has(key)) fail(file, `${at}.${key}`, "is not a source field");
  const kinds = (["git", "index", "npm", "local"] as const).filter((key) => raw[key] !== undefined);
  if (kinds.length !== 1) fail(file, at, "needs exactly one of git, index, npm or local");
  const id = optionalString(file, `${at}.id`, raw.id) ?? defaultSourceId(raw);
  if (!/^[a-z0-9][a-z0-9._-]*$/i.test(id))
    fail(file, `${at}.id`, `"${id}" may only use letters, digits, ".", "_" and "-"`);
  const idProblem = sourceIdProblem(id);
  if (idProblem) fail(file, `${at}.id`, `"${id}" ${idProblem}`);
  const update = raw.update ?? "auto";
  if (update !== "auto" && update !== "review")
    fail(file, `${at}.update`, 'must be "auto" or "review"');
  if (raw.adopt !== undefined && typeof raw.adopt !== "boolean")
    fail(file, `${at}.adopt`, "must be a boolean");
  const common: SourceCommon = {
    id,
    update,
    origin: file,
    skills: skillsGlob(file, `${at}.skills`, raw.skills),
    include: stringList(file, `${at}.include`, raw.include),
    exclude: stringList(file, `${at}.exclude`, raw.exclude),
  };
  const ref = notOption(file, `${at}.ref`, optionalString(file, `${at}.ref`, raw.ref));
  const kind = kinds[0]!;
  const spec = optionalString(file, `${at}.${kind}`, raw[kind])!;
  const onlyFor = (key: string, kinds: string) => {
    if (raw[key] !== undefined) fail(file, `${at}.${key}`, `only applies to ${kinds} sources`);
  };
  switch (kind) {
    case "git": {
      onlyFor("registry", "npm");
      notOption(file, `${at}.git`, spec);
      const path = optionalString(file, `${at}.path`, raw.path);
      if (path)
        return {
          ...common,
          kind: "clone",
          git: spec,
          ref,
          path: expandPath(path, base),
          adopt: raw.adopt === true,
        };
      onlyFor("adopt", "git sources with a path, and local");
      return { ...common, kind: "git", git: spec, ref };
    }
    case "index":
      for (const key of ["ref", "path", "registry", "adopt"])
        onlyFor(key, key === "registry" ? "npm" : "git");
      // An index lists skills by name; there are no folders to glob.
      onlyFor("skills", "git, npm and local");
      try {
        new URL(spec);
      } catch {
        fail(file, `${at}.index`, "must be a URL");
      }
      return { ...common, kind: "index", index: spec };
    case "npm":
      for (const key of ["ref", "path", "adopt"]) onlyFor(key, "git");
      return {
        ...common,
        kind: "npm",
        npm: spec,
        registry: optionalString(file, `${at}.registry`, raw.registry),
        sendToken: true,
      };
    case "local":
      for (const key of ["ref", "path", "registry"])
        onlyFor(key, key === "registry" ? "npm" : "git");
      return { ...common, kind: "local", local: expandPath(spec, base), adopt: raw.adopt === true };
    default: {
      const exhaustive: never = kind;
      return exhaustive;
    }
  }
}

/** Ids of the agents the `skills` package knows, which `agents` may name. */
export const agentIds = () => getSupportedAgents().map((agent) => agent.id);

/** The one of `known` closest to a mistyped `word`, or undefined when none is close. */
export function closest(word: string, known: readonly string[]): string | undefined {
  const distance = (a: string, b: string) => {
    let row = Array.from({ length: b.length + 1 }, (_, i) => i);
    for (let i = 1; i <= a.length; i++) {
      const next = [i];
      for (let j = 1; j <= b.length; j++)
        next[j] = Math.min(
          row[j]! + 1,
          next[j - 1]! + 1,
          row[j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1),
        );
      row = next;
    }
    return row[b.length]!;
  };
  const best = known
    .map((candidate) => ({ candidate, score: distance(word.toLowerCase(), candidate) }))
    .sort((a, b) => a.score - b.score)[0];
  return best && best.score <= Math.max(2, Math.floor(word.length / 3))
    ? best.candidate
    : undefined;
}

/** Validates a manifest file's JSON. `base` resolves relative paths. */
export function parseManifest(file: string, raw: unknown, base = dirname(file)): Manifest {
  if (!isRecord(raw)) fail(file, "the manifest", "must be a JSON object");
  for (const key of Object.keys(raw))
    if (!ROOT_KEYS.has(key)) fail(file, key, "is not a manifest field");
  const agents = raw.agents ?? "all";
  if (agents !== "all") {
    const ids =
      stringList(file, "agents", agents) ?? fail(file, "agents", 'must be "all" or a list');
    const known = agentIds();
    const unknown = ids.filter((id) => !known.includes(id));
    if (unknown.length > 0) {
      const near = closest(unknown[0]!, known);
      fail(
        file,
        "agents",
        `names ${unknown.map((id) => `"${id}"`).join(", ")}, which ${unknown.length === 1 ? "is not an agent id" : "are not agent ids"}${near ? ` (did you mean "${near}"?)` : ""}; \`skillfleet agents\` lists the ids`,
      );
    }
  }
  if (!Array.isArray(raw.sources ?? [])) fail(file, "sources", "must be an array");
  const sources = ((raw.sources ?? []) as unknown[]).map((source, i) =>
    parseSource(file, `sources[${i}]`, source, base),
  );
  const ids = new Map<string, string>();
  for (const source of sources) {
    const seen = ids.get(nameKey(source.id));
    if (seen === source.id) fail(file, "sources", `declare "${source.id}" twice; give one an id`);
    if (seen !== undefined)
      fail(
        file,
        "sources",
        `declare "${seen}" and "${source.id}", which differ only by case or a trailing dot; macOS and Windows keep them in the same folder`,
      );
    ids.set(nameKey(source.id), source.id);
  }
  const forks: Record<string, Fork> = {};
  if (raw.forks !== undefined) {
    if (!isRecord(raw.forks)) fail(file, "forks", "must be an object");
    for (const [name, fork] of Object.entries(raw.forks)) {
      if (!isRecord(fork)) fail(file, `forks.${name}`, "must be an object");
      forks[name] = {
        from:
          optionalString(file, `forks.${name}.from`, fork.from) ??
          fail(file, `forks.${name}.from`, "is required"),
        path:
          optionalString(file, `forks.${name}.path`, fork.path) ??
          fail(file, `forks.${name}.path`, "is required"),
        base:
          optionalString(file, `forks.${name}.base`, fork.base) ??
          fail(file, `forks.${name}.base`, "is required"),
      };
    }
  }
  if (!Array.isArray(raw.hooks ?? [])) fail(file, "hooks", "must be an array");
  const hooks = ((raw.hooks ?? []) as unknown[]).map((hook, i): Hook => {
    if (!isRecord(hook)) fail(file, `hooks[${i}]`, "must be an object");
    const run =
      optionalString(file, `hooks[${i}].run`, hook.run) ??
      fail(file, `hooks[${i}].run`, "is required");
    return {
      name: optionalString(file, `hooks[${i}].name`, hook.name) ?? run,
      run,
      on: stringList(file, `hooks[${i}].on`, hook.on) ?? ["*:**"],
    };
  });
  let report: Manifest["report"];
  if (raw.report !== undefined) {
    if (!isRecord(raw.report)) fail(file, "report", "must be an object");
    report = {
      run:
        optionalString(file, "report.run", raw.report.run) ??
        fail(file, "report.run", "is required"),
    };
  }
  const timer = { cron: "*/30 * * * *", timeZone: undefined as string | undefined };
  if (raw.timer !== undefined) {
    if (!isRecord(raw.timer)) fail(file, "timer", "must be an object");
    timer.cron = optionalString(file, "timer.cron", raw.timer.cron) ?? timer.cron;
    const cron = cronProblem(timer.cron);
    if (cron) fail(file, "timer.cron", cron);
    timer.timeZone = optionalString(file, "timer.timeZone", raw.timer.timeZone);
    const zone = timer.timeZone === undefined ? undefined : timeZoneProblem(timer.timeZone);
    if (zone) fail(file, "timer.timeZone", zone);
  }
  return {
    file,
    extends: stringList(file, "extends", raw.extends) ?? [],
    agents: agents === "all" ? "all" : (agents as string[]),
    sources,
    forks,
    hooks,
    fleet: stringList(file, "fleet", raw.fleet) ?? [],
    hub: optionalString(file, "hub", raw.hub),
    report,
    timer,
  };
}

/** This machine's settings, in config.json. The manifest is shared; these are not. */
export interface Config {
  /** A manifest path, or `<git repo>//<file>` such as `github:org/agents//skills.json`. */
  manifest: string;
  /** Copy skill folders instead of linking them, on every sync (`--copy`, `--no-copy`). */
  copy?: boolean;
  /** False after `init --no-timer` or `timer remove`: `doctor` then skips the timer. */
  timer?: boolean;
}

export function readConfig(): Config | undefined {
  const raw = readJson(paths.config());
  if (raw === undefined) return undefined;
  if (!isRecord(raw) || typeof raw.manifest !== "string")
    throw new ManifestError(`${paths.config()}: needs a "manifest" string`);
  for (const key of ["copy", "timer"] as const)
    if (raw[key] !== undefined && typeof raw[key] !== "boolean")
      throw new ManifestError(`${paths.config()}: "${key}" must be true or false`);
  return {
    manifest: raw.manifest,
    ...(raw.copy === undefined ? {} : { copy: raw.copy as boolean }),
    ...(raw.timer === undefined ? {} : { timer: raw.timer as boolean }),
  };
}

/** Changes config.json, keeping the settings `change` does not name. */
export function writeConfig(change: Partial<Config> & { manifest: string }) {
  let config: Config | undefined;
  try {
    config = readConfig();
  } catch {}
  writeJson(paths.config(), { ...config, ...change });
}

/** Changes settings of an existing config.json; without one, there is nothing to remember them in. */
export function updateConfig(change: Partial<Omit<Config, "manifest">>) {
  const config = readConfig();
  if (config) writeJson(paths.config(), { ...config, ...change });
}

export interface LoadedManifest {
  root: Manifest;
  /** Root sources first, then each extended manifest's, in order. */
  sources: Source[];
  warnings: string[];
  /** Extended manifests that could not be fetched or read: the sources they declare are unknown. */
  failed?: string[];
}

/** The manifest file a repository holds when a spec names only the repository, as in `init owner/repo`. */
export const DEFAULT_MANIFEST = "skills.json";

/** `owner/repo`, `github:owner/repo`, `gitlab:group/repo`, or a git URL ending in `.git`. */
const isRepository = (spec: string) =>
  /^(github|gitlab):[^/]/.test(spec) ||
  (/^[\w-][\w.-]*\/[\w.-]+$/.test(spec) && !spec.endsWith(".json")) ||
  /^(https?|ssh|git|file):\/\/.+\.git\/?$/.test(spec) ||
  /^[\w.-]+@[\w.-]+:.+\.git$/.test(spec);

/** A bare repository, such as a team's `team.git` on a shared drive: a folder of git's own files. */
const isBareRepository = (dir: string) =>
  statSync(dir, { throwIfNoEntry: false })?.isDirectory() === true &&
  statSync(join(dir, "HEAD"), { throwIfNoEntry: false })?.isFile() === true &&
  existsSync(join(dir, "objects")) &&
  existsSync(join(dir, "refs"));

export interface WebPage {
  /** The repository's https URL, which git clones. */
  repo: string;
  kind?: "blob" | "tree";
  ref?: string;
  /** The file (`blob`) or folder (`tree`) inside the repository, when the link names one. */
  path?: string;
}

/**
 * A repository page on GitHub or GitLab, as a browser shows it: the repository, or a `blob` link
 * to a file or a `tree` link to a folder on a branch. A line anchor (`#L3`) or a query
 * (`?plain=1`, `?tab=readme-ov-file`) copied with the link is ignored, and the path and branch are
 * decoded.
 */
export function webPage(spec: string): WebPage | undefined {
  const page =
    spec.match(
      /^(https?:\/\/(?:www\.)?github\.com\/[^/?#]+\/[^/?#]+?)(?:\.git)?(?:\/(blob|tree)\/([^/?#]+)(?:\/([^?#]*?))?)?\/?(?:[?#].*)?$/,
    ) ??
    spec.match(
      /^(https?:\/\/gitlab\.com\/(?:[^/?#]+\/)+?[^/?#]+?)(?:\.git)?(?:\/-\/(blob|tree)\/([^/?#]+)(?:\/([^?#]*?))?)?\/?(?:[?#].*)?$/,
    );
  if (!page) return undefined;
  // The address bar shows `my skills`, but a copied link holds `my%20skills`.
  const [, repo, kind, ref, path] = page.map((part) => part && decoded(part));
  return {
    repo: repo!.replace(/^http:/, "https:").replace("://www.", "://"),
    ...(kind ? { kind: kind as "blob" | "tree", ref } : {}),
    ...(path ? { path } : {}),
  };
}

function decoded(part: string): string {
  try {
    return decodeURIComponent(part);
  } catch {
    return part;
  }
}

/** A `blob` link names a manifest file, a `tree` link a folder holding `skills.json`. */
function webManifest(spec: string): RemoteManifest | undefined {
  const page = webPage(spec);
  if (!page) return undefined;
  const { repo, kind, ref, path } = page;
  const file =
    kind === "blob" && path ? path : path ? `${path}/${DEFAULT_MANIFEST}` : DEFAULT_MANIFEST;
  return { repo, path: file, ref };
}

export interface RemoteManifest {
  repo: string;
  path: string;
  /** Branch or tag, from a GitHub or GitLab link; the default branch when absent. */
  ref?: string;
}

/**
 * The repository and file of a manifest kept in git, or undefined for a file on this machine.
 * `<repo>//<file>` names both; a repository alone means its `skills.json`, and so does a GitHub or
 * GitLab page link. A path that exists on this machine, resolved against `base`, is local, unless
 * it is a bare repository.
 */
export function remoteManifest(spec: string, base = process.cwd()): RemoteManifest | undefined {
  const local = expandPath(spec, base);
  if (existsSync(local))
    return isBareRepository(local) ? { repo: local, path: DEFAULT_MANIFEST } : undefined;
  const split = splitRepoPath(spec);
  if (split) {
    const repo = expandPath(split.repo, base);
    return isBareRepository(repo) ? { ...split, repo } : split;
  }
  return (
    webManifest(spec) ?? (isRepository(spec) ? { repo: spec, path: DEFAULT_MANIFEST } : undefined)
  );
}

/**
 * The spec as config.json keeps it: `<repo>//<file>`, or an absolute path, so it reads the same
 * from any folder. A link that names a branch stays the link, the one form that keeps the branch.
 */
export function canonicalManifestSpec(spec: string): string {
  const remote = remoteManifest(spec);
  if (remote?.ref) return spec;
  return remote ? `${remote.repo}//${remote.path}` : expandPath(spec);
}

/** Where a manifest spec lives on disk, fetching it when it is in a remote repository. */
export async function locateManifest(
  spec: string,
  { offline = false, cacheRoot = join(paths.cache(), "manifests"), base = process.cwd() } = {},
) {
  const remote = remoteManifest(spec, base);
  if (!remote) {
    // A folder, such as a clone of the manifest's repository, means its skills.json.
    const path = expandPath(spec, base);
    return statSync(path, { throwIfNoEntry: false })?.isDirectory()
      ? join(path, DEFAULT_MANIFEST)
      : path;
  }
  const url = gitUrl(remote.repo);
  const clone = await fetchClone(url, remote.ref, cacheRoot, { offline });
  const file = join(clone.dir, remote.path);
  if (!existsSync(file))
    throw new ManifestError(
      `${url} has no ${remote.path}; name the manifest file as ${remote.repo}//<file>`,
    );
  return file;
}

function readManifestFile(file: string): Manifest {
  if (!existsSync(file)) throw new ManifestError(`${file}: no such manifest`);
  let raw: unknown;
  try {
    raw = readJsonFile(file);
  } catch (error) {
    throw new ManifestError(`${file}: ${(error as Error).message}`);
  }
  return parseManifest(file, raw);
}

/**
 * Loads the root manifest and everything it extends. Extended manifests add sources only:
 * their hooks, fleet, hub and report are dropped, so a team manifest cannot run commands
 * on a teammate's machine.
 */
export async function loadManifest(
  spec: string,
  options: { offline?: boolean; cacheRoot?: string } = {},
): Promise<LoadedManifest> {
  const rootFile = await locateManifest(spec, options);
  const root = readManifestFile(rootFile);
  const warnings: string[] = [];
  const failed: string[] = [];
  const sources = [...root.sources];
  const seen = new Set([rootFile]);
  const ids = new Set(sources.map((source) => nameKey(source.id)));
  // NPM_TOKEN goes to the registry the user configured and to registries the root manifest names.
  const tokenOrigins = new Set([
    urlOrigin(registryUrl(undefined)),
    ...root.sources.flatMap((source) =>
      source.kind === "npm" && source.registry ? [urlOrigin(source.registry)] : [],
    ),
  ]);
  const visit = async (manifest: Manifest) => {
    for (const parent of manifest.extends) {
      let file: string;
      try {
        file = await locateManifest(parent, { ...options, base: dirname(manifest.file) });
      } catch (error) {
        warnings.push(`extends ${parent}: ${(error as Error).message}`);
        failed.push(parent);
        continue;
      }
      if (seen.has(file)) continue;
      seen.add(file);
      let team: Manifest;
      try {
        team = readManifestFile(file);
      } catch (error) {
        warnings.push(`extends ${parent}: ${(error as Error).message}`);
        failed.push(parent);
        continue;
      }
      const ignored = [
        team.hooks.length > 0 && "hooks",
        team.fleet.length > 0 && "fleet",
        team.hub && "hub",
        team.report && "report",
      ].filter(Boolean);
      if (ignored.length > 0)
        warnings.push(
          `extends ${parent}: ignored ${ignored.join(", ")}; only the root manifest can run commands or name machines`,
        );
      for (const source of team.sources) {
        if (source.kind === "clone" || source.kind === "local") {
          warnings.push(
            `extends ${parent}: ignored source "${source.id}"; only the root manifest can name a folder on this machine (${source.kind === "clone" ? "path" : "local"})`,
          );
          continue;
        }
        if (ids.has(nameKey(source.id))) {
          warnings.push(
            `extends ${parent}: source "${source.id}" is already declared; the first one is used`,
          );
          continue;
        }
        ids.add(nameKey(source.id));
        if (source.kind === "npm")
          source.sendToken = !source.registry || tokenOrigins.has(urlOrigin(source.registry));
        sources.push(source);
      }
      await visit(team);
    }
  };
  await visit(root);
  return { root, sources, warnings, failed };
}

/**
 * Reads, changes and writes back the root manifest's JSON, keeping fields skillfleet does not know.
 * A dry run checks that the changed manifest is valid and writes nothing.
 */
export function editManifest(
  file: string,
  change: (raw: Record<string, unknown>) => void,
  { dryRun = false } = {},
) {
  const raw = readJson(file);
  if (!isRecord(raw)) throw new ManifestError(`${file}: the manifest must be a JSON object`);
  change(raw);
  parseManifest(file, raw);
  if (!dryRun) writeJson(file, raw);
}
