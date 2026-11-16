/** `*` matches within one path segment, `**` across segments, `?` one character. */
export function globToRegExp(glob: string): RegExp {
  let source = "";
  for (let i = 0; i < glob.length; i++) {
    const char = glob[i]!;
    if (char === "/" && glob.slice(i + 1) === "**") {
      source += "(?:/.*)?";
      break;
    }
    if (char === "*" && glob[i + 1] === "*") {
      // `a/**/b` also matches `a/b`, and a trailing `/**` matches the folder itself.
      if (glob[i + 2] === "/") {
        source += "(?:.*/)?";
        i += 2;
      } else {
        source += ".*";
        i += 1;
      }
    } else if (char === "*") source += "[^/]*";
    else if (char === "?") source += "[^/]";
    else source += char.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`^${source}$`);
}

/** Paths and globs compare in Unicode NFC: macOS lists names in NFD, keyboards type NFC. */
export const matchesGlob = (path: string, glob: string) =>
  globToRegExp(glob.normalize("NFC")).test(path.normalize("NFC"));

/** The folder part of a glob before its first wildcard: `skills/*` gives `skills`. */
export function globBase(glob: string): string {
  const parts = glob.split("/");
  const fixed: string[] = [];
  for (const part of parts) {
    if (/[*?]/.test(part)) break;
    fixed.push(part);
  }
  return fixed.join("/");
}
