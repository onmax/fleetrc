import { mkdirSync, renameSync } from "node:fs";
import { dirname, join } from "node:path";
import { dict, type Hashes, isRecord, JsonFileError, readJson, writeJson } from "./fs.ts";
import { isVendoredKind, type Source } from "./manifest.ts";
import { paths, tildify } from "./paths.ts";

/** A vendored skill as skillfleet last installed it: the merge base for local edits. */
export interface InstalledCopy {
  hashes: Hashes;
  /** Folder of the skill inside its source, when the source has a tree. */
  path?: string;
}

export interface PendingUpdate {
  /** `review`: the source waits for `skillfleet update`; `edited`: the local copy has edits. */
  reason: "review" | "edited";
  since: string;
}

export interface SourceState {
  kind: Source["kind"];
  /** Commit of the last fetch (git) or of the working clone's HEAD. */
  commit?: string;
  /** npm package version. */
  version?: string;
  fetchedAt?: string;
  skills: Record<string, InstalledCopy>;
  pending: Record<string, PendingUpdate>;
}

/** When each skill name first appeared on this machine and last changed. */
export interface SkillRecord {
  source: string;
  dir: string;
  addedAt: string;
  changedAt: string;
}

/** What the last sync found upstream of a fork (the manifest's `forks`). */
export interface ForkState {
  /** The fork's `base` when it was checked. */
  base: string;
  /** The upstream commit checked. */
  upstream: string;
  /** A hash of the skill's folder at `upstream`, so a new version is told apart from the last one. */
  tree: string;
  /** Files of the skill that changed upstream between `base` and `upstream`; none when it did not move. */
  files: string[];
}

export interface State {
  version: 1;
  sources: Record<string, SourceState>;
  skills: Record<string, SkillRecord>;
  forks?: Record<string, ForkState>;
  /** Last time any linked skill was added, removed or changed. */
  lastChange?: string;
}

export const emptyState = (): State => ({ version: 1, sources: dict(), skills: dict() });

/**
 * Reads state.json. A file that does not parse, or has a shape this version does not know (another
 * version wrote it), reads as empty: the sync rebuilds what it can from the store, and vendored
 * copies it cannot vouch for count as edited, so nothing local is overwritten. With `warnings` (a
 * sync that will write a new state), the old file is first moved to the backup folder.
 */
export function loadState(warnings?: string[]): State {
  let raw: unknown;
  try {
    raw = readJson(paths.state());
  } catch (error) {
    if (!(error instanceof JsonFileError)) throw error;
    if (warnings) backUp("was corrupt", warnings);
    return emptyState();
  }
  if (raw === undefined) return emptyState();
  if (!isRecord(raw) || raw.version !== 1 || !isRecord(raw.sources) || !isRecord(raw.skills)) {
    if (warnings)
      backUp(
        isRecord(raw) && typeof raw.version === "number" && raw.version !== 1
          ? `is version ${raw.version}, from another skillfleet,`
          : "has a shape skillfleet does not know,",
        warnings,
      );
    return emptyState();
  }
  // An older build, or a hand edit, may have left records of another shape inside: each one is
  // read on its own, and one that can't be read is lost, which the sync rebuilds from the store.
  return {
    version: 1,
    sources: records(raw.sources, sourceRecord),
    skills: records(raw.skills, skillRecord),
    ...(isRecord(raw.forks) ? { forks: records(raw.forks, forkRecord) } : {}),
    ...(typeof raw.lastChange === "string" ? { lastChange: raw.lastChange } : {}),
  };
}

const KINDS: readonly string[] = [
  "git",
  "npm",
  "index",
  "clone",
  "local",
] satisfies Source["kind"][];

/** The entries of `value` that `read` accepts, as read. */
function records<T>(value: unknown, read: (record: unknown) => T | undefined): Record<string, T> {
  const out = dict<T>();
  if (!isRecord(value)) return out;
  for (const [key, record] of Object.entries(value)) {
    const parsed = read(record);
    if (parsed !== undefined) out[key] = parsed;
  }
  return out;
}

const text = (value: unknown) => (typeof value === "string" ? value : undefined);

/** Optional string fields of `record` that are strings. */
const strings = <K extends string>(record: Record<string, unknown>, ...keys: K[]) =>
  Object.fromEntries(keys.flatMap((key) => (text(record[key]) ? [[key, record[key]]] : []))) as {
    [P in K]?: string;
  };

function sourceRecord(record: unknown): SourceState | undefined {
  if (!isRecord(record) || !KINDS.includes(String(record.kind))) return undefined;
  return {
    kind: record.kind as Source["kind"],
    ...strings(record, "commit", "version", "fetchedAt"),
    skills: records(record.skills, installedCopy),
    pending: records(record.pending, pendingUpdate),
  };
}

function installedCopy(record: unknown): InstalledCopy | undefined {
  if (!isRecord(record) || !isRecord(record.hashes)) return undefined;
  const hashes = Object.entries(record.hashes);
  if (hashes.some(([, hash]) => typeof hash !== "string")) return undefined;
  return { hashes: dict(hashes as [string, string][]), ...strings(record, "path") };
}

function pendingUpdate(record: unknown): PendingUpdate | undefined {
  if (!isRecord(record) || (record.reason !== "review" && record.reason !== "edited"))
    return undefined;
  return { reason: record.reason, since: text(record.since) ?? new Date(0).toISOString() };
}

function forkRecord(record: unknown): ForkState | undefined {
  if (!isRecord(record) || !text(record.base) || !text(record.upstream)) return undefined;
  const files = Array.isArray(record.files)
    ? record.files.filter((file): file is string => typeof file === "string")
    : [];
  return {
    base: record.base as string,
    upstream: record.upstream as string,
    tree: text(record.tree) ?? "",
    files,
  };
}

function skillRecord(record: unknown): SkillRecord | undefined {
  if (!isRecord(record) || !text(record.source) || !text(record.dir)) return undefined;
  const at = text(record.addedAt) ?? text(record.changedAt) ?? new Date(0).toISOString();
  return {
    source: record.source as string,
    dir: record.dir as string,
    addedAt: at,
    changedAt: text(record.changedAt) ?? at,
  };
}

function backUp(problem: string, warnings: string[]) {
  const to = join(paths.backup(), `state-${new Date().toISOString().replace(/[:.]/g, "-")}.json`);
  mkdirSync(dirname(to), { recursive: true });
  renameSync(paths.state(), to);
  warnings.push(
    `${tildify(paths.state())} ${problem} so skillfleet started a new one and kept the old one at ${tildify(to)}`,
  );
}

export const saveState = (state: State) => writeJson(paths.state(), state);

/**
 * The state of `source`. A source that moved from one vendored kind to another (git to npm) keeps
 * its install records, which are still the base of the copies in its store.
 */
export function sourceState(state: State, source: Source): SourceState {
  const existing = state.sources[source.id];
  if (existing && existing.kind === source.kind) return existing;
  if (existing && isVendoredKind(existing.kind) && isVendoredKind(source.kind)) {
    const moved: SourceState = {
      kind: source.kind,
      skills: existing.skills,
      pending: existing.pending,
    };
    state.sources[source.id] = moved;
    return moved;
  }
  const fresh: SourceState = { kind: source.kind, skills: dict(), pending: dict() };
  state.sources[source.id] = fresh;
  return fresh;
}
