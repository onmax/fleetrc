import { createHash } from "node:crypto";
import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  renameSync,
  rmSync,
  type Stats,
  writeFileSync,
} from "node:fs";
import { dirname, join, relative, sep } from "node:path";

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
  return Object.fromEntries(Object.entries(hashes).sort(([a], [b]) => (a < b ? -1 : 1)));
}

export const sha256 = (data: string | Uint8Array) =>
  createHash("sha256").update(data).digest("hex");

/** Files whose hash differs between two trees, including added and removed ones. */
export function changedFiles(before: Hashes, after: Hashes): string[] {
  const files = new Set([...Object.keys(before), ...Object.keys(after)]);
  return [...files].filter((file) => before[file] !== after[file]).sort();
}

export const sameTree = (a: Hashes, b: Hashes) => changedFiles(a, b).length === 0;

/** Replaces `to` with a copy of `from`. */
export function copyDir(from: string, to: string) {
  rmSync(to, { recursive: true, force: true });
  mkdirSync(dirname(to), { recursive: true });
  cpSync(from, to, { recursive: true, verbatimSymlinks: true });
}

/** Moves a directory, copying when it crosses file systems. */
export function moveDir(from: string, to: string) {
  mkdirSync(dirname(to), { recursive: true });
  try {
    renameSync(from, to);
  } catch (error) {
    if (!isErrno(error, "EXDEV")) throw error;
    cpSync(from, to, { recursive: true, verbatimSymlinks: true });
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
