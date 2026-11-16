import { existsSync, readFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { fetchClone, gitUrl, splitRepoPath } from "./gitcache.ts";
import { isRecord, readJson, writeJson } from "./fs.ts";
import { expandPath, paths } from "./paths.ts";

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

export const isVendored = (source: Source): source is VendoredSource =>
  source.kind === "git" || source.kind === "index" || source.kind === "npm";

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
  const update = raw.update ?? "auto";
  if (update !== "auto" && update !== "review")
    fail(file, `${at}.update`, 'must be "auto" or "review"');
  if (raw.adopt !== undefined && typeof raw.adopt !== "boolean")
    fail(file, `${at}.adopt`, "must be a boolean");
  const common: SourceCommon = {
    id,
    update,
    origin: file,
    skills: optionalString(file, `${at}.skills`, raw.skills),
    include: stringList(file, `${at}.include`, raw.include),
    exclude: stringList(file, `${at}.exclude`, raw.exclude),
  };
  const ref = optionalString(file, `${at}.ref`, raw.ref);
  const kind = kinds[0]!;
  const spec = optionalString(file, `${at}.${kind}`, raw[kind])!;
  const onlyFor = (key: string, kinds: string) => {
    if (raw[key] !== undefined) fail(file, `${at}.${key}`, `only applies to ${kinds} sources`);
  };
  switch (kind) {
    case "git": {
      onlyFor("registry", "npm");
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

/** Validates a manifest file's JSON. `base` resolves relative paths. */
export function parseManifest(file: string, raw: unknown, base = dirname(file)): Manifest {
  if (!isRecord(raw)) fail(file, "the manifest", "must be a JSON object");
  for (const key of Object.keys(raw))
    if (!ROOT_KEYS.has(key)) fail(file, key, "is not a manifest field");
  const agents = raw.agents ?? "all";
  if (agents !== "all" && stringList(file, "agents", agents) === undefined)
    fail(file, "agents", 'must be "all" or a list');
  if (!Array.isArray(raw.sources ?? [])) fail(file, "sources", "must be an array");
  const sources = ((raw.sources ?? []) as unknown[]).map((source, i) =>
    parseSource(file, `sources[${i}]`, source, base),
  );
  const ids = new Set<string>();
  for (const source of sources) {
    if (ids.has(source.id)) fail(file, "sources", `declare "${source.id}" twice; give one an id`);
    ids.add(source.id);
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
    if (timer.cron.trim().split(/\s+/).length !== 5)
      fail(file, "timer.cron", "must have five fields");
    timer.timeZone = optionalString(file, "timer.timeZone", raw.timer.timeZone);
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

export interface Config {
  /** A manifest path, or `<git repo>//<file>` such as `github:org/agents//skills.json`. */
  manifest: string;
}

export function readConfig(): Config | undefined {
  const raw = readJson(paths.config());
  if (raw === undefined) return undefined;
  if (!isRecord(raw) || typeof raw.manifest !== "string")
    throw new ManifestError(`${paths.config()}: needs a "manifest" string`);
  return { manifest: raw.manifest };
}

export const writeConfig = (config: Config) => writeJson(paths.config(), config);

export interface LoadedManifest {
  root: Manifest;
  /** Root sources first, then each extended manifest's, in order. */
  sources: Source[];
  warnings: string[];
}

/** Where a manifest spec lives on disk, fetching it when it is in a remote repository. */
export async function locateManifest(
  spec: string,
  { offline = false, cacheRoot = join(paths.cache(), "manifests") } = {},
) {
  const remote = splitRepoPath(spec);
  if (remote && !existsSync(spec)) {
    const clone = await fetchClone(gitUrl(remote.repo), undefined, cacheRoot, { offline });
    return join(clone.dir, remote.path);
  }
  return expandPath(spec);
}

function readManifestFile(file: string): Manifest {
  if (!existsSync(file)) throw new ManifestError(`${file}: no such manifest`);
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(file, "utf8"));
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
  const sources = [...root.sources];
  const seen = new Set([rootFile]);
  const ids = new Set(sources.map((source) => source.id));
  const visit = async (manifest: Manifest) => {
    for (const parent of manifest.extends) {
      let file: string;
      try {
        const remote = splitRepoPath(parent);
        file =
          remote && !existsSync(parent)
            ? await locateManifest(parent, options)
            : expandPath(parent, dirname(manifest.file));
      } catch (error) {
        warnings.push(`extends ${parent}: ${(error as Error).message}`);
        continue;
      }
      if (seen.has(file)) continue;
      seen.add(file);
      const team = readManifestFile(file);
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
        if (ids.has(source.id)) {
          warnings.push(
            `extends ${parent}: source "${source.id}" is already declared; the first one is used`,
          );
          continue;
        }
        ids.add(source.id);
        sources.push(source);
      }
      await visit(team);
    }
  };
  await visit(root);
  return { root, sources, warnings };
}

/** Reads, changes and writes back the root manifest's JSON, keeping fields skillfleet does not know. */
export function editManifest(file: string, change: (raw: Record<string, unknown>) => void) {
  const raw: unknown = JSON.parse(readFileSync(file, "utf8"));
  if (!isRecord(raw)) throw new ManifestError(`${file}: the manifest must be a JSON object`);
  change(raw);
  parseManifest(file, raw);
  writeJson(file, raw);
}
