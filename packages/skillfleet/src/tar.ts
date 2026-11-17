import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { gunzipSync } from "node:zlib";

const text = (bytes: Uint8Array, start: number, length: number) => {
  const slice = bytes.subarray(start, start + length);
  const end = slice.indexOf(0);
  return new TextDecoder().decode(end >= 0 ? slice.subarray(0, end) : slice);
};

/** A relative `/`-separated path that stays inside the folder it is extracted to, or undefined. */
export function safeRelativePath(raw: string): string | undefined {
  if (
    !raw ||
    raw.includes("\0") ||
    raw.includes("\\") ||
    raw.startsWith("/") ||
    /^[A-Za-z]:/.test(raw)
  )
    return undefined;
  const parts = raw.split("/").filter((part) => part !== "" && part !== ".");
  if (parts.length === 0 || parts.includes("..")) return undefined;
  return parts.join("/");
}

/** The most a .tgz may unpack to, and the most entries it may hold. */
const UNPACKED_LIMIT = 100 * 1024 * 1024;
const ENTRY_LIMIT = 50_000;

/** Unpacks a gzip stream, refusing one that unpacks to more than the limit. */
export function gunzipCapped(gz: Uint8Array): Buffer {
  try {
    return gunzipSync(gz, { maxOutputLength: UNPACKED_LIMIT });
  } catch (error) {
    if (error instanceof RangeError)
      throw new Error("the archive unpacks to more than 100 MB, over skillfleet's size limit");
    throw error;
  }
}

/** Regular files in a .tgz, keyed by path. Throws on links, on paths that leave the archive, and past the size limits. */
export function readTgz(gz: Uint8Array): Map<string, Uint8Array> {
  const tar = gunzipCapped(gz);
  const files = new Map<string, Uint8Array>();
  let offset = 0;
  let longName: string | undefined;
  let entries = 0;
  while (offset + 512 <= tar.length) {
    if (++entries > ENTRY_LIMIT)
      throw new Error(`the archive has more than ${ENTRY_LIMIT} entries, over skillfleet's limit`);
    const header = tar.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) break;
    const size = Number.parseInt(text(header, 124, 12).trim() || "0", 8);
    if (!Number.isFinite(size) || size < 0) throw new Error("invalid tar entry size");
    const type = String.fromCharCode(header[156] ?? 0);
    const prefix = text(header, 345, 155);
    const name = longName ?? (prefix ? `${prefix}/${text(header, 0, 100)}` : text(header, 0, 100));
    const body = tar.subarray(offset + 512, offset + 512 + size);
    offset += 512 + Math.ceil(size / 512) * 512;
    longName = undefined;
    if (type === "x") {
      // pax header: "<length> path=<value>\n" records
      const path = new TextDecoder().decode(body).match(/(?:^|\n)\d+ path=([^\n]*)\n/);
      longName = path?.[1];
      continue;
    }
    if (type === "L") {
      longName = text(body, 0, body.length);
      continue;
    }
    if (type === "1" || type === "2") throw new Error(`archive entry ${name} is a link`);
    if (type !== "0" && type !== "\0") continue;
    const path = safeRelativePath(name);
    if (!path) throw new Error(`archive entry ${name} would be written outside the package`);
    files.set(path, new Uint8Array(body));
  }
  return files;
}

/** Writes archive files under `dir`, dropping the first path segment (npm's `package/`). */
export function extractStripped(files: Map<string, Uint8Array>, dir: string) {
  for (const [path, content] of files) {
    const stripped = path.split("/").slice(1).join("/");
    if (!stripped) continue;
    const target = join(dir, stripped);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, content);
  }
}
