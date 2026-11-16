import {
  existsSync,
  mkdirSync,
  readlinkSync,
  rmdirSync,
  rmSync,
  symlinkSync,
  unlinkSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import {
  copyDir,
  type Hashes,
  hashDir,
  isErrno,
  isRecord,
  lstat,
  readJson,
  sameTree,
  writeJson,
} from "./fs.ts";
import { segmentProblem } from "./names.ts";
import { tildify } from "./paths.ts";

export const MANIFEST_FILE = ".skillfleet-manifest.json";

export type LinkKind = "symlink" | "junction" | "copy";

export interface LinkRecord {
  target: string;
  kind: LinkKind;
  source: string;
  /** For copies: the files as written, to tell an edited copy from a stale one. */
  hashes?: Hashes;
}

export interface TargetManifest {
  version: 1;
  links: Record<string, LinkRecord>;
}

export interface DesiredLink {
  name: string;
  target: string;
  source: string;
}

export interface TargetReport {
  dir: string;
  created: string[];
  replaced: string[];
  removed: string[];
  /** Hand-made folders and links skillfleet did not create, left as they are. */
  foreign: string[];
  skipped?: string;
  warnings: string[];
}

export function readTargetManifest(dir: string): TargetManifest {
  const raw = readJson(join(dir, MANIFEST_FILE));
  if (!isRecord(raw) || raw.version !== 1 || !isRecord(raw.links)) return { version: 1, links: {} };
  const links: Record<string, LinkRecord> = {};
  for (const [name, record] of Object.entries(raw.links)) {
    if (!isRecord(record) || typeof record.target !== "string" || typeof record.source !== "string")
      continue;
    // A record is only trusted to name a folder directly inside this one.
    if (segmentProblem(name)) continue;
    const kind = record.kind === "junction" || record.kind === "copy" ? record.kind : "symlink";
    links[name] = {
      target: record.target,
      kind,
      source: record.source,
      ...(isRecord(record.hashes)
        ? {
            hashes: Object.fromEntries(
              Object.entries(record.hashes).map(([k, v]) => [k, String(v)]),
            ),
          }
        : {}),
    };
  }
  return { version: 1, links };
}

const stripLongPrefix = (path: string) => path.replace(/^\\\\\?\\/, "");

/** Where a link points, as an absolute path. */
export function linkTarget(path: string): string {
  return resolve(dirname(path), stripLongPrefix(readlinkSync(path)));
}

const samePath = (a: string, b: string) =>
  process.platform === "win32"
    ? resolve(a).toLowerCase() === resolve(b).toLowerCase()
    : resolve(a) === resolve(b);

/** Removes a link without touching what it points to. */
export function removeLink(path: string) {
  try {
    unlinkSync(path);
  } catch (error) {
    if (!isErrno(error, "EPERM", "EISDIR")) throw error;
    rmdirSync(path);
  }
}

/** Links `path` to the `target` folder: a symlink, a junction on Windows, or a copy. */
export function makeLink(target: string, path: string, copy: boolean): LinkKind {
  mkdirSync(dirname(path), { recursive: true });
  if (!copy) {
    try {
      symlinkSync(target, path, process.platform === "win32" ? "junction" : "dir");
      return process.platform === "win32" ? "junction" : "symlink";
    } catch (error) {
      if (process.platform !== "win32") throw error;
    }
  }
  copyDir(target, path);
  return "copy";
}

/**
 * Makes each folder hold exactly one link per desired skill. Only links recorded in the folder's
 * manifest are replaced or pruned; hand-made folders and foreign links stay, with a warning.
 */
export function linkTargetDir(
  dir: string,
  desired: readonly DesiredLink[],
  { copy = false, dryRun = false }: { copy?: boolean; dryRun?: boolean } = {},
): TargetReport {
  const report: TargetReport = {
    dir,
    created: [],
    replaced: [],
    removed: [],
    foreign: [],
    warnings: [],
  };
  const stat = lstat(dir);
  if (stat?.isSymbolicLink()) {
    report.skipped = `${tildify(dir)} is a link to ${tildify(linkTarget(dir))}; run \`skillfleet init\` to give it one link per skill`;
    return report;
  }
  if (stat && !stat.isDirectory()) {
    report.skipped = `${tildify(dir)} is not a folder`;
    return report;
  }
  if (!stat && !dryRun) mkdirSync(dir, { recursive: true });
  const manifest = readTargetManifest(dir);
  const wanted = new Map<string, DesiredLink>();
  for (const link of desired) {
    const problem = segmentProblem(link.name);
    if (problem) report.warnings.push(`skipped the skill "${link.name}": its name ${problem}`);
    else wanted.set(link.name, link);
  }
  const write = (name: string, link: DesiredLink, replacing: boolean) => {
    const path = join(dir, name);
    if (!dryRun) {
      if (replacing) {
        const existing = lstat(path);
        if (existing?.isSymbolicLink()) removeLink(path);
        else rmSync(path, { recursive: true, force: true });
      }
      const kind = makeLink(link.target, path, copy);
      manifest.links[name] = {
        target: link.target,
        kind,
        source: link.source,
        ...(kind === "copy" ? { hashes: hashDir(path) } : {}),
      };
    }
    (replacing ? report.replaced : report.created).push(name);
  };

  for (const link of wanted.values()) {
    const path = join(dir, link.name);
    const current = lstat(path);
    const record = manifest.links[link.name];
    if (!current) {
      write(link.name, link, false);
      continue;
    }
    if (current.isSymbolicLink()) {
      const pointsTo = linkTarget(path);
      if (samePath(pointsTo, link.target) && !copy) {
        if (!record && !dryRun)
          manifest.links[link.name] = {
            target: link.target,
            kind: process.platform === "win32" ? "junction" : "symlink",
            source: link.source,
          };
        if (record) record.source = link.source;
        continue;
      }
      if (record && record.kind !== "copy") write(link.name, link, true);
      else {
        report.foreign.push(link.name);
        report.warnings.push(
          `${tildify(path)} links to ${tildify(pointsTo)}, not ${tildify(link.target)}; skillfleet did not make it, so it stays`,
        );
      }
      continue;
    }
    if (current.isDirectory() && record?.kind === "copy") {
      const now = hashDir(path);
      if (record.hashes && !sameTree(now, record.hashes)) {
        report.warnings.push(`${tildify(path)} is a copy with local edits, so it is not refreshed`);
        continue;
      }
      if (!copy || !sameTree(now, hashDir(link.target)) || !samePath(record.target, link.target))
        write(link.name, link, true);
      continue;
    }
    report.foreign.push(link.name);
    report.warnings.push(
      `${tildify(path)} is a ${current.isDirectory() ? "folder" : "file"} skillfleet did not make, so it stays`,
    );
  }

  for (const [name, record] of Object.entries(manifest.links)) {
    if (wanted.has(name)) continue;
    const path = join(dir, name);
    const current = lstat(path);
    if (current?.isSymbolicLink() && samePath(linkTarget(path), record.target)) {
      if (!dryRun) removeLink(path);
      report.removed.push(name);
    } else if (
      current?.isDirectory() &&
      record.kind === "copy" &&
      record.hashes &&
      sameTree(hashDir(path), record.hashes)
    ) {
      if (!dryRun) rmSync(path, { recursive: true, force: true });
      report.removed.push(name);
    } else if (current) {
      report.warnings.push(
        `${tildify(path)} changed since skillfleet made it, so it is not removed`,
      );
    }
    if (!dryRun) delete manifest.links[name];
  }
  if (!dryRun && existsSync(dir)) writeJson(join(dir, MANIFEST_FILE), manifest);
  return report;
}
