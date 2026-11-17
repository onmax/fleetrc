import { createHash } from "node:crypto";
import {
  appendFileSync,
  constants,
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  renameSync,
  rmSync,
  type Stats,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, isAbsolute, join, relative, sep } from "node:path";

export type Hashes = Record<string, string>;

export const lstat = (path: string): Stats | undefined =>
  lstatSync(path, { throwIfNoEntry: false });

/** sha256 of every file under `dir`, keyed by `/`-separated relative path. Links hash their target text. */
export function hashDir(dir: string): Hashes {
  const hashes: Hashes = {};
  const walk = (current: string) => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const path = join(current, entry.name);
      const key = relative(dir, path).split(sep).join("/");
      if (entry.isDirectory()) walk(path);
      else if (entry.isSymbolicLink()) hashes[key] = sha256(`link:${readlinkSync(path)}`);
      else if (entry.isFile()) hashes[key] = sha256(readFileSync(path));
    }
  };
  if (existsSync(dir)) walk(dir);
  return sorted(hashes);
}

const sorted = (hashes: Hashes): Hashes =>
  Object.fromEntries(Object.entries(hashes).sort(([a], [b]) => (a < b ? -1 : 1)));

/** Every file and link under `dir`, as `/`-separated relative paths. */
export function listFiles(dir: string): string[] {
  const files: string[] = [];
  const walk = (current: string, prefix: string) => {
    for (const entry of readdirSync(current, { withFileTypes: true }))
      if (entry.isDirectory()) walk(join(current, entry.name), `${prefix}${entry.name}/`);
      else files.push(`${prefix}${entry.name}`);
  };
  if (existsSync(dir)) walk(dir, "");
  return files;
}

export const sha256 = (data: string | Uint8Array) =>
  createHash("sha256").update(data).digest("hex");

/** Whether `path` is `root` or inside it. */
export const inside = (root: string, path: string) => {
  const rel = relative(root, path);
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
};

/** A link an agent's copy of a skill leaves out, `/`-separated from the skill folder, and why. */
export interface DroppedLink {
  path: string;
  reason: "outside" | "nothing" | "loop";
}

interface ResolvedEntry {
  /** `/`-separated, from the skill folder. */
  rel: string;
  real: string;
  dir: boolean;
}

/**
 * The tree of the skill folder `dir` as an agent's copy holds it: the folder and every link in it
 * are followed to what they resolve to. Copied, a relative link would point at nothing, and a link
 * into the source would no longer lead into it. A link that leaves `within` (when given), leads to
 * nothing, or leads to a folder that holds it is left out and named in `dropped`.
 */
function resolvedTree(dir: string, within: string | undefined, dropped: DroppedLink[]) {
  const bound = within === undefined ? undefined : realpathSync(within);
  const entries: ResolvedEntry[] = [];
  const walk = (real: string, rel: string, open: readonly string[]) => {
    for (const name of readdirSync(real)) {
      const path = join(real, name);
      const childRel = rel ? `${rel}/${name}` : name;
      let target = path;
      let stat = lstatSync(path);
      if (stat.isSymbolicLink()) {
        try {
          target = realpathSync(path);
          stat = statSync(target);
        } catch {
          dropped.push({ path: childRel, reason: "nothing" });
          continue;
        }
        if (bound !== undefined && !inside(bound, target)) {
          dropped.push({ path: childRel, reason: "outside" });
          continue;
        }
      }
      if (stat.isDirectory()) {
        if (open.some((folder) => inside(target, folder))) {
          dropped.push({ path: childRel, reason: "loop" });
          continue;
        }
        entries.push({ rel: childRel, real: target, dir: true });
        walk(target, childRel, [...open, target]);
      } else if (stat.isFile()) entries.push({ rel: childRel, real: target, dir: false });
    }
  };
  const root = realpathSync(dir);
  walk(root, "", [root]);
  return entries;
}

/**
 * Hashes of the copy `copyResolved(dir, within)` makes, without making it: what `hashDir` of a
 * fresh copy reads.
 */
export function resolvedHashes(dir: string, within?: string): Hashes {
  const hashes: Hashes = {};
  if (!existsSync(dir)) return hashes;
  for (const entry of resolvedTree(dir, within, []))
    if (!entry.dir) hashes[entry.rel] = sha256(readFileSync(entry.real));
  return sorted(hashes);
}

/** Files whose hash differs between two trees, including added and removed ones. */
export function changedFiles(before: Hashes, after: Hashes): string[] {
  const files = new Set([...Object.keys(before), ...Object.keys(after)]);
  return [...files].filter((file) => before[file] !== after[file]).sort();
}

export const sameTree = (a: Hashes, b: Hashes) => changedFiles(a, b).length === 0;

/** Files copied by this process. With SKILLFLEET_DEBUG_COPIES, the count goes to that file at exit. */
let copiedFiles = 0;
export const countCopies = (files: number) => {
  copiedFiles += files;
};
const copiesLog = process.env.SKILLFLEET_DEBUG_COPIES;
if (copiesLog) process.on("exit", () => appendFileSync(copiesLog, `${copiedFiles}\n`));

/**
 * Copies a file or folder tree; a link is copied as a link with the same target. Not cpSync: on
 * Windows, Node 22's cpSync fails for a path with non-ASCII characters, such as a HOME named José.
 * A file system that can clone a file (Btrfs, XFS, APFS) shares its blocks until either side is
 * written.
 */
function copyTree(from: string, to: string) {
  const stat = lstatSync(from);
  if (stat.isSymbolicLink()) symlinkSync(readlinkSync(from), to);
  else if (stat.isDirectory()) {
    mkdirSync(to, { recursive: true });
    for (const name of readdirSync(from)) copyTree(join(from, name), join(to, name));
  } else {
    copyFileSync(from, to, constants.COPYFILE_FICLONE);
    copiedFiles++;
  }
}

/** Replaces `to` with a copy of `from`. */
export function copyDir(from: string, to: string) {
  rmSync(to, { recursive: true, force: true });
  mkdirSync(dirname(to), { recursive: true });
  copyTree(from, to);
}

/**
 * Replaces `to` with a copy of the skill folder `from` that holds no links: each is copied as what
 * it resolves to (see `resolvedTree`). Returns the links it left out.
 */
export function copyResolved(from: string, to: string, within?: string): DroppedLink[] {
  const dropped: DroppedLink[] = [];
  const entries = resolvedTree(from, within, dropped);
  rmSync(to, { recursive: true, force: true });
  mkdirSync(to, { recursive: true });
  for (const entry of entries) {
    const path = join(to, entry.rel);
    if (entry.dir) mkdirSync(path, { recursive: true });
    else {
      copyFileSync(entry.real, path, constants.COPYFILE_FICLONE);
      copiedFiles++;
    }
  }
  return dropped;
}

const REPLACING = /^\.(.+)\.(\d+)\.(new|old)$/;

/**
 * Replaces the folder `to` with `from`, copied or, with `move`, renamed. The new tree is made
 * beside `to` and renamed into place, so a crash leaves the old tree or the new one, never half of
 * one; `recoverReplaced` cleans up after it.
 */
export function replaceDir(from: string, to: string, { move = false } = {}) {
  const parent = dirname(to);
  mkdirSync(parent, { recursive: true });
  const temp = join(parent, `.${basename(to)}.${process.pid}.new`);
  const old = join(parent, `.${basename(to)}.${process.pid}.old`);
  rmSync(temp, { recursive: true, force: true });
  rmSync(old, { recursive: true, force: true });
  if (move) moveDir(from, temp);
  else copyTree(from, temp);
  const replaced = lstat(to) !== undefined;
  if (replaced) renameSync(to, old);
  renameSync(temp, to);
  if (replaced) rmSync(old, { recursive: true, force: true });
}

/**
 * Finishes what a killed `replaceDir` or `renameFolder` left in `dir`: a new tree that was never
 * renamed into place is deleted, and an old tree whose replacement never arrived, or a folder left
 * under its third name, goes back. Folders of a process still running are left alone.
 */
export function recoverReplaced(dir: string) {
  if (!existsSync(dir)) return;
  recoverRenames(dir);
  for (const name of readdirSync(dir)) {
    const match = REPLACING.exec(name);
    if (!match || isRunning(Number(match[2]))) continue;
    const path = join(dir, name);
    const target = join(dir, match[1]!);
    if (match[3] === "old" && lstat(target) === undefined) renameSync(path, target);
    else rmSync(path, { recursive: true, force: true });
  }
}

/** Whether another process with this pid runs; this process counts as not running. */
export function isRunning(pid: number): boolean {
  if (!(pid > 0) || pid === process.pid) return false;
  // Windows pids are multiples of 4, and it ignores the low two bits: 4242 would ask about 4240.
  if (process.platform === "win32" && pid % 4 !== 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return isErrno(error, "EPERM");
  }
}

/** Moves a directory, copying when it crosses file systems. */
export function moveDir(from: string, to: string) {
  mkdirSync(dirname(to), { recursive: true });
  try {
    renameSync(from, to);
  } catch (error) {
    if (!isErrno(error, "EXDEV")) throw error;
    copyTree(from, to);
    rmSync(from, { recursive: true, force: true });
  }
}

const RENAMING = /^(.+)\.(\d+)\.rename$/;

/**
 * Renames `from` to `to`, names that may differ only in case or Unicode form: macOS and Windows
 * see one entry there, so it goes through a third name, which `recoverRenames` puts back after a
 * kill. Returns false, changing nothing, when `from` is missing or `to` is another entry.
 */
export function renameFolder(from: string, to: string): boolean {
  if (from === to) return true;
  if (!lstat(from)) return false;
  const temp = `${from}.${process.pid}.rename`;
  renameSync(from, temp);
  if (lstat(to)) {
    renameSync(temp, from);
    return false;
  }
  renameSync(temp, to);
  return true;
}

/**
 * Puts each entry a killed `renameFolder` left in `dir` under its third name back under the name it
 * had, where nothing took that name. With `names`, only entries that had one of them.
 */
export function recoverRenames(dir: string, names?: ReadonlySet<string>) {
  for (const name of readdirSync(dir)) {
    const match = RENAMING.exec(name);
    if (!match || isRunning(Number(match[2])) || (names && !names.has(match[1]!))) continue;
    const original = join(dir, match[1]!);
    if (lstat(original) === undefined) renameSync(join(dir, name), original);
  }
}

export function isErrno(error: unknown, ...codes: string[]): boolean {
  return error instanceof Error && "code" in error && codes.includes(String(error.code));
}

/** A JSON file that exists but does not parse: cut short by a crash or a full disk, or hand-edited. */
export class JsonFileError extends Error {}

/** Some Windows editors start a UTF-8 file with a byte order mark, which JSON.parse refuses. */
const withoutBom = (text: string) => text.replace(/^\uFEFF/, "");

/** Parses a JSON file, skipping a byte order mark. */
export const readJsonFile = (path: string): unknown =>
  JSON.parse(withoutBom(readFileSync(path, "utf8")));

export function readJson(path: string): unknown {
  if (!existsSync(path)) return undefined;
  const text = withoutBom(readFileSync(path, "utf8"));
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new JsonFileError(`${path} is not valid JSON: ${(error as Error).message}`);
  }
}

/** `readJson` for records skillfleet rebuilds anyway (last run, fleet cache, sessions): a corrupt one reads as missing. */
export function readJsonOrNothing(path: string): unknown {
  try {
    return readJson(path);
  } catch (error) {
    if (error instanceof JsonFileError) return undefined;
    throw error;
  }
}

/** Writes JSON through a temporary file, so a crash never leaves half a file. */
export function writeJson(path: string, value: unknown) {
  mkdirSync(dirname(path), { recursive: true });
  const temp = `${path}.${process.pid}.tmp`;
  writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`);
  renameSync(temp, path);
}

export const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
