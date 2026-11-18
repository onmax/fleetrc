/**
 * A glob as an automaton: `*` matches within one path segment, `**` across segments (`**/ ` any
 * folders or none, a trailing `; /**` the folder and everything in it), `?` one character, and every
 * other character itself, `[`, `{`, `(` and `!` included. Each state has the states it reaches
 * without a character (`next`) and on one (`on`).
 */
interface State {
  next: number[];
  on: { test: (char: string) => boolean; to: number }[];
}

const anyChar = () => true;
const inSegment = (char: string) => char !== "/";

function compile(glob: string): { states: State[]; accept: number } {
  const states: State[] = [];
  const add = () => states.push({ next: [], on: [] }) - 1;
  let at = add();
  const chars = Array.from(glob);
  for (let i = 0; i < chars.length; i++) {
    const char = chars[i]!;
    if (char === "/" && chars.length === i + 3 && chars[i + 1] === "*" && chars[i + 2] === "*") {
      // `(?:/.*)?`: nothing, or `/` and then anything.
      const end = add();
      const rest = add();
      states[at]!.next.push(end);
      states[at]!.on.push({ test: (c) => c === "/", to: rest });
      states[rest]!.on.push({ test: anyChar, to: rest });
      states[rest]!.next.push(end);
      at = end;
      break;
    }
    if (char === "*" && chars[i + 1] === "*") {
      const end = add();
      if (chars[i + 2] === "/") {
        // `(?:.*/)?`: nothing, or anything that ends with `/`. `a/**/b` also matches `a/b`.
        const inner = add();
        states[at]!.next.push(end, inner);
        states[inner]!.on.push({ test: anyChar, to: inner }, { test: (c) => c === "/", to: end });
        i += 2;
      } else {
        states[at]!.on.push({ test: anyChar, to: at });
        states[at]!.next.push(end);
        i += 1;
      }
      at = end;
    } else if (char === "*") {
      const end = add();
      states[at]!.on.push({ test: inSegment, to: at });
      states[at]!.next.push(end);
      at = end;
    } else {
      const end = add();
      states[at]!.on.push({ test: char === "?" ? inSegment : (c) => c === char, to: end });
      at = end;
    }
  }
  return { states, accept: at };
}

/**
 * Whether `path` matches `glob`. The automaton runs on every state at once, so a glob from a
 * manifest takes time in proportion to the path's length times the glob's, whatever its stars.
 */
function globMatches(glob: string, path: string): boolean {
  const { states, accept } = compile(glob);
  const seen = new Uint32Array(states.length);
  let round = 0;
  // The states `from` reach without a character, added to `into` once each per round: a worklist
  // shared by the whole round, so memory stays linear in the glob's length.
  const close = (from: readonly number[], into: number[]) => {
    const stack: number[] = [];
    for (const state of from)
      if (seen[state] !== round) {
        seen[state] = round;
        stack.push(state);
      }
    while (stack.length > 0) {
      const state = stack.pop()!;
      into.push(state);
      for (const to of states[state]!.next)
        if (seen[to] !== round) {
          seen[to] = round;
          stack.push(to);
        }
    }
    return into;
  };
  round++;
  let current = close([0], []);
  for (const char of path) {
    round++;
    const targets: number[] = [];
    for (const state of current)
      for (const edge of states[state]!.on) if (edge.test(char)) targets.push(edge.to);
    const after = close(targets, []);
    if (after.length === 0) return false;
    current = after;
  }
  return current.includes(accept);
}

/** Paths and globs compare in Unicode NFC: macOS lists names in NFD, keyboards type NFC. */
export const matchesGlob = (path: string, glob: string) =>
  globMatches(glob.normalize("NFC"), path.normalize("NFC"));

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
