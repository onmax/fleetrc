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

/** Each entry of an unpacked tar, long names (pax `path`, GNU `L`) applied. Throws past the entry limit. */
export function* tarEntries(
  tar: Uint8Array,
): Generator<{ name: string; type: string; body: Uint8Array }> {
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
    yield { name, type, body };
  }
}

/** Regular files in a .tgz, keyed by path. Throws on links, on paths that leave the archive, and past the size limits. */
export function readTgz(gz: Uint8Array): Map<string, Uint8Array> {
  const files = new Map<string, Uint8Array>();
  for (const { name, type, body } of tarEntries(gunzipCapped(gz))) {
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

/** A zip number past `Number.MAX_SAFE_INTEGER` reads as invalid. */
function safe(value: bigint, what: string): number {
  if (value > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error(`invalid zip archive: ${what}`);
  return Number(value);
}

/**
 * Each entry of a zip archive as its central directory lists it, with the size it unpacks to (zip64
 * sizes and offsets read). Throws for an archive that is not a zip, and past the entry limit.
 */
export function* zipEntries(
  zip: Uint8Array,
): Generator<{ name: string; directory: boolean; size: number }> {
  const buffer = Buffer.from(zip.buffer, zip.byteOffset, zip.byteLength);
  const invalid = (what: string) => new Error(`invalid zip archive: ${what}`);
  const within = (offset: number, length: number, what: string) => {
    if (offset < 0 || offset + length > buffer.length) throw invalid(what);
  };
  // The end of central directory record, 22 bytes, then a comment of at most 65535.
  let end = -1;
  for (let at = buffer.length - 22; at >= 0 && at >= buffer.length - 22 - 0xffff; at--)
    if (buffer.readUInt32LE(at) === 0x06054b50) {
      end = at;
      break;
    }
  if (end < 0) throw invalid("no end of central directory");
  let entries = buffer.readUInt16LE(end + 10);
  let offset = buffer.readUInt32LE(end + 16);
  if (entries === 0xffff || offset === 0xffffffff) {
    const locator = end - 20;
    within(locator, 20, "no zip64 locator");
    if (buffer.readUInt32LE(locator) !== 0x07064b50) throw invalid("no zip64 locator");
    const record = safe(buffer.readBigUInt64LE(locator + 8), "zip64 record offset");
    within(record, 56, "zip64 end of central directory");
    if (buffer.readUInt32LE(record) !== 0x06064b50) throw invalid("zip64 end of central directory");
    entries = safe(buffer.readBigUInt64LE(record + 32), "zip64 entry count");
    offset = safe(buffer.readBigUInt64LE(record + 48), "zip64 central directory offset");
  }
  if (entries > ENTRY_LIMIT)
    throw new Error(`the archive has more than ${ENTRY_LIMIT} entries, over skillfleet's limit`);
  for (let i = 0; i < entries; i++) {
    within(offset, 46, "central directory entry");
    if (buffer.readUInt32LE(offset) !== 0x02014b50) throw invalid("central directory entry");
    let size = buffer.readUInt32LE(offset + 24);
    const nameLength = buffer.readUInt16LE(offset + 28);
    const extraLength = buffer.readUInt16LE(offset + 30);
    const commentLength = buffer.readUInt16LE(offset + 32);
    const type = (buffer.readUInt32LE(offset + 38) >>> 16) & 0o170000;
    const extra = offset + 46 + nameLength;
    within(offset + 46, nameLength + extraLength + commentLength, "central directory entry");
    const name = buffer.subarray(offset + 46, extra).toString("utf8");
    if (size === 0xffffffff) {
      // The zip64 extra field (id 1) starts with the unpacked size when the entry's says 0xffffffff.
      let at = extra;
      let found = false;
      while (at + 4 <= extra + extraLength) {
        const id = buffer.readUInt16LE(at);
        const length = buffer.readUInt16LE(at + 2);
        if (id === 1 && length >= 8 && at + 12 <= extra + extraLength) {
          size = safe(buffer.readBigUInt64LE(at + 4), "zip64 entry size");
          found = true;
          break;
        }
        at += 4 + length;
      }
      if (!found) throw invalid("zip64 entry size");
    }
    yield { name, directory: name.endsWith("/") || type === 0o040000, size };
    offset = extra + extraLength + commentLength;
  }
}
