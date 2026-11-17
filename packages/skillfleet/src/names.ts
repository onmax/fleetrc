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
 * The one of `names` that `typed` means: itself, else the one with the same `nameKey`. Skill names
 * are unique by `nameKey` (sync keeps the first of two that macOS and Windows fold together), so a
 * name typed in another case or Unicode form, as a macOS keyboard types NFC, finds one skill.
 */
export function findName(names: Iterable<string>, typed: string): string | undefined {
  const list = [...names];
  if (list.includes(typed)) return typed;
  const key = nameKey(typed);
  return list.find((name) => nameKey(name) === key);
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
