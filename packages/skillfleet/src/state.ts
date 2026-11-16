import { mkdirSync, renameSync } from "node:fs";
import { dirname, join } from "node:path";
import { type Hashes, isRecord, JsonFileError, readJson, writeJson } from "./fs.ts";
import type { Source } from "./manifest.ts";
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

export interface State {
  version: 1;
  sources: Record<string, SourceState>;
  skills: Record<string, SkillRecord>;
  /** Last time any linked skill was added, removed or changed. */
  lastChange?: string;
}

export const emptyState = (): State => ({ version: 1, sources: {}, skills: {} });

/**
 * Reads state.json. A file that does not parse reads as empty: vendored copies that differ from
 * upstream then count as edited, so nothing local is overwritten. With `warnings` (a sync that
 * will write a new state), the corrupt file is first moved to the backup folder.
 */
export function loadState(warnings?: string[]): State {
  let raw: unknown;
  try {
    raw = readJson(paths.state());
  } catch (error) {
    if (!(error instanceof JsonFileError)) throw error;
    if (warnings) {
      const to = join(
        paths.backup(),
        `state-${new Date().toISOString().replace(/[:.]/g, "-")}.json`,
      );
      mkdirSync(dirname(to), { recursive: true });
      renameSync(paths.state(), to);
      warnings.push(
        `${tildify(paths.state())} was corrupt, so skillfleet started a new one and kept the old one at ${tildify(to)}`,
      );
    }
    return emptyState();
  }
  if (!isRecord(raw) || raw.version !== 1 || !isRecord(raw.sources) || !isRecord(raw.skills))
    return emptyState();
  // Our own file, written by saveState: the shape was checked when it was written.
  return raw as unknown as State;
}

export const saveState = (state: State) => writeJson(paths.state(), state);

export function sourceState(state: State, source: Source): SourceState {
  const existing = state.sources[source.id];
  if (existing && existing.kind === source.kind) return existing;
  const fresh: SourceState = { kind: source.kind, skills: {}, pending: {} };
  state.sources[source.id] = fresh;
  return fresh;
}
