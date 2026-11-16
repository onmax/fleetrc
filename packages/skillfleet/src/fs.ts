import { createHash } from "node:crypto";
import {
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  renameSync,
  rmSync,
  type Stats,
  statSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, relative, sep } from "node:path";

export type Hashes = Record<string, string>;

export const lstat = (path: string): Stats | undefined =>
  lstatSync(path, { throwIfNoEntry: false });

/**
 * sha256 of every file under `dir`, keyed by `/`-separated relative path. Links hash their target
 * text; with `skillMdAsFile`, a top-level SKILL.md link hashes as the file it points to, as
 * `materializeSkillMd` leaves it.
 */
export function hashDir(dir: string, { skillMdAsFile = false } = {}): Hashes {
  const hashes: Hashes = {};
  const walk = (current: string) => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const path = join(current, entry.name);
      const key = relative(dir, path).split(sep).join("/");
      if (entry.isDirectory()) walk(path);
      else if (entry.isSymbolicLink())
        hashes[key] =
          (skillMdAsFile && key === SKILL_MD && linkedFile(path)) ||
          sha256(`link:${readlinkSync(path)}`);
      else if (entry.isFile()) hashes[key] = sha256(readFileSync(path));
    }
  };
  if (existsSync(dir)) walk(dir);
  return Object.fromEntries(Object.entries(hashes).sort(([a], [b]) => (a < b ? -1 : 1)));
}

export const sha256 = (data: string | Uint8Array) =>
  createHash("sha256").update(data).digest("hex");

const SKILL_MD = "SKILL.md";

/** sha256 of the file a link points to, or undefined when it points to no file. */
function linkedFile(path: string): string | undefined {
  try {
    return statSync(path).isFile() ? sha256(readFileSync(path)) : undefined;
  } catch {
    return undefined;
  }
}

/**
 * In `copy`, a copy of the skill folder `original`, replaces a SKILL.md that is a link with the
 * file it points to from `original`, where a relative link resolves. Codex and Cursor skip a
 * skill whose SKILL.md is a link. A link to no file stays.
 */
export function materializeSkillMd(copy: string, original: string) {
  const file = join(copy, SKILL_MD);
  const from = join(original, SKILL_MD);
  if (!lstat(file)?.isSymbolicLink() || !linkedFile(from)) return;
  unlinkSync(file);
  writeFileSync(file, readFileSync(from));
}

/** Files whose hash differs between two trees, including added and removed ones. */
export function changedFiles(before: Hashes, after: Hashes): string[] {
  const files = new Set([...Object.keys(before), ...Object.keys(after)]);
  return [...files].filter((file) => before[file] !== after[file]).sort();
}

export const sameTree = (a: Hashes, b: Hashes) => changedFiles(a, b).length === 0;

/** Replaces `to` with a copy of `from`. */
/**
 * Copies a file or folder tree; a link is copied as a link with the same target. Not cpSync: on
 * Windows, Node 22's cpSync fails for a path with non-ASCII characters, such as a HOME named José.
 */
function copyTree(from: string, to: string) {
  const stat = lstatSync(from);
  if (stat.isSymbolicLink()) symlinkSync(readlinkSync(from), to);
  else if (stat.isDirectory()) {
    mkdirSync(to, { recursive: true });
    for (const name of readdirSync(from)) copyTree(join(from, name), join(to, name));
  } else copyFileSync(from, to);
}

export function copyDir(from: string, to: string) {
  rmSync(to, { recursive: true, force: true });
  mkdirSync(dirname(to), { recursive: true });
  copyTree(from, to);
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
