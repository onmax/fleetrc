import { UserError } from "./errors.ts";

// Skill names and source ids become folder names in the store and in every agent folder, so each
// one has to be a single path segment that Linux, macOS and Windows all create the same way.

/** Longest name in UTF-8 bytes: the per-folder limit of ext4, APFS and NTFS. */
const MAX_BYTES = 255;

/** Windows reserves these device names, with or without an extension (`con.md` too). */
const RESERVED = /^(con|prn|aux|nul|com[0-9¹²³]|lpt[0-9¹²³])(\..*)?$/i;

/** Why `name` cannot be a folder name on every system, or undefined when it can. */
export function segmentProblem(name: string): string | undefined {
  if (name === "") return "is empty";
  if (name === "." || name === "..") return "is a relative folder";
  if (/[/\\]/.test(name)) return "contains a slash";
  if (/\p{Cc}/u.test(name)) return "contains a control character";
  if (/[<>:"|?*]/.test(name)) return 'contains one of < > : " | ? *, which Windows does not allow';
  if (name.startsWith(".")) return "starts with a dot";
  if (/[. ]$/.test(name)) return "ends with a dot or a space, which Windows drops";
  if (RESERVED.test(name)) return "is a device name on Windows";
  if (Buffer.byteLength(name) > MAX_BYTES) return `is longer than ${MAX_BYTES} bytes`;
  return undefined;
}

/**
 * Why Windows can't write a file or folder named `segment` where a repository has it, or where
 * writing it would open another one: a device name (`aux.txt`), a trailing dot or space, a
 * character NTFS refuses, git's own folder, or an 8.3 short name (`longna~1`), which NTFS gives
 * a longer name in the same folder. Undefined when it can.
 */
export function checkoutProblem(segment: string): string | undefined {
  if (/[\p{Cc}<>:"|?*\\]/u.test(segment))
    return 'has a control character or one of < > : " | ? * \\, which Windows does not allow';
  if (/[. ]$/.test(segment)) return "ends with a dot or a space, which Windows drops";
  if (/^(con|prn|aux|nul|conin\$|conout\$|com[0-9¹²³]|lpt[0-9¹²³]) *(\..*)?$/i.test(segment))
    return "is a device name on Windows";
  if (nameKey(segment) === ".git") return "is git's own folder";
  const dot = segment.lastIndexOf(".");
  const [stem, extension] =
    dot > 0 ? [segment.slice(0, dot), segment.slice(dot + 1)] : [segment, ""];
  if (/~\d+$/.test(stem) && stem.length <= 8 && extension.length <= 3)
    return "looks like an 8.3 short name, which Windows can resolve to another folder";
  return undefined;
}

/** Throws unless `name` is one plain path segment: the last check before a path is created or removed. */
export function assertSegment(name: string): string {
  const problem = segmentProblem(name);
  if (problem) throw new Error(`refusing the name "${name}": it ${problem}`);
  return name;
}

/**
 * The form two names share when macOS or Windows would store them in one folder: case-folded,
 * Unicode NFC, without trailing dots and spaces.
 */
export const nameKey = (name: string) =>
  name
    .normalize("NFC")
    .toLowerCase()
    .replace(/[. ]+$/, "");

/**
 * The one of `names` that `typed` means: itself, else the one with the same `nameKey`, as a macOS
 * keyboard types NFC. Linked skills are unique by `nameKey` (sync keeps the first of two that macOS
 * and Windows fold together), but a skill held for review may share it with a linked one: then the
 * typed name could mean either, and this throws, naming them.
 */
export function findName(names: Iterable<string>, typed: string): string | undefined {
  const list = new Set(names);
  if (list.has(typed)) return typed;
  const key = nameKey(typed);
  const matches = [...list].filter((name) => nameKey(name) === key);
  if (matches.length > 1)
    throw new UserError(
      `"${typed}" could be any of ${matches.map((name) => `"${name}"`).join(", ")}, which differ only in case or Unicode form; type the one you mean exactly`,
    );
  return matches[0];
}

/**
 * Why a source id cannot name its store folder. The manifest's pattern already limits the
 * characters; a trailing dot is allowed and compared away by `nameKey`.
 */
export function sourceIdProblem(id: string): string | undefined {
  if (RESERVED.test(id.replace(/\.+$/, ""))) return "is a device name on Windows";
  if (Buffer.byteLength(id) > MAX_BYTES) return `is longer than ${MAX_BYTES} bytes`;
  return undefined;
}
