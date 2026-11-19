/**
 * A glob as an automaton: `*` matches within one path segment, `**` across segments (a `**`
 * segment at the start or middle is any folders or none, one at the end is the folder and
 * everything in it), `?` one character, and every other character itself, `[`, `{`, `(` and `!`
 * included. Each state has the states it reaches without a character (`next`) and on one (`on`).
 */
interface State {
  next: number[];
  on: { test: (char: string) => boolean; to: number }[];
}

const dot = (char: string) =>
  char !== "\n" && char !== "\r" && char !== "\u2028" && char !== "\u2029";
const inSegment = (char: string) => char !== "/";

export const MAX_GLOB_LENGTH = 8192;
const MATCH_WORK_LIMIT = 10_000_000;

function compile(chars: string): { states: State[]; accept: number } {
  const states: State[] = [];
  const add = () => states.push({ next: [], on: [] }) - 1;
  let at = add();
  for (let i = 0; i < chars.length; i++) {
    const char = chars[i]!;
    if (char === "/" && chars.length === i + 3 && chars[i + 1] === "*" && chars[i + 2] === "*") {
      // `(?:/.*)?`: nothing, or `/` and then anything.
      const end = add();
      const rest = add();
      states[at]!.next.push(end);
      states[at]!.on.push({ test: (c) => c === "/", to: rest });
      states[rest]!.on.push({ test: dot, to: rest });
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
        states[inner]!.on.push({ test: dot, to: inner }, { test: (c) => c === "/", to: end });
        i += 2;
      } else {
        states[at]!.on.push({ test: dot, to: at });
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
 * Match all active states at once, with no backtracking. Each state has at most two edges of each
 * kind, so counting state and target visits also bounds the time spent following edges.
 */
function globMatches(
  { states, accept }: ReturnType<typeof compile>,
  path: string,
  spend: (work: number) => void,
): boolean {
  const seen = new Uint32Array(states.length);
  let round = 0;
  // The states `from` reach without a character, added to `into` once each per round: a worklist
  // shared by the whole round, so memory stays linear in the glob's length.
  const close = (from: readonly number[], into: number[]) => {
    spend(from.length);
    const stack: number[] = [];
    for (const state of from)
      if (seen[state] !== round) {
        seen[state] = round;
        stack.push(state);
      }
    while (stack.length > 0) {
      const state = stack.pop()!;
      spend(1);
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
  for (let index = 0; index < path.length; index++) {
    const char = path[index]!;
    round++;
    spend(current.length);
    const targets: number[] = [];
    for (const state of current)
      for (const edge of states[state]!.on) if (edge.test(char)) targets.push(edge.to);
    const after = close(targets, []);
    if (after.length === 0) return false;
    current = after;
  }
  return current.includes(accept);
}

/** Compile once and share a work budget across all candidate paths in this filter. */
export function globFilter(glob: string, label = "glob"): (path: string) => boolean {
  if (glob.length > MAX_GLOB_LENGTH)
    throw new Error(`${label} exceeds ${MAX_GLOB_LENGTH} UTF-16 code units`);
  const compiled = compile(glob.normalize("NFC"));
  let remaining = MATCH_WORK_LIMIT;
  const spend = (work: number) => {
    remaining -= work;
    if (remaining < 0)
      throw new Error(`${label} exceeded the matching work limit; narrow the pattern`);
  };
  return (path) => {
    spend(1 + path.length + compiled.states.length);
    return globMatches(compiled, path.normalize("NFC"), spend);
  };
}

/** Paths and globs compare in Unicode NFC: macOS lists names in NFD, keyboards type NFC. */
export const matchesGlob = (path: string, glob: string) => globFilter(glob)(path);

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
