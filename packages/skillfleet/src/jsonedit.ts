/**
 * Edits JSON text in place: given the value a file holds and the value it should hold, changes only
 * the parts that differ, so a hand-written manifest keeps its layout (one-line arrays, key order,
 * blank lines). A new array item or object member copies the layout of its siblings.
 */

// The package's main is a UMD build that hands `require` to a factory, which the bundler can't
// follow into dist/cli.mjs; its ESM build is plain imports.
import { type Node as TreeNode, type ParseError, parseTree } from "jsonc-parser/lib/esm/main.js";

interface Node {
  start: number;
  end: number;
  /** Items of an array, members of an object (with the start of their key). */
  items?: Node[];
  members?: { key: string; keyStart: number; value: Node }[];
}

/**
 * The value `text` holds as offsets into it, or undefined unless it is plain JSON: no comments, no
 * trailing commas. Keys an object holds twice, which JSON.parse reads as the last one alone, go
 * into `duplicates`.
 */
function parse(text: string, duplicates: string[]): Node | undefined {
  const errors: ParseError[] = [];
  // A byte order mark reads as a space, which keeps every offset.
  const root = parseTree(text.replace(/^\uFEFF/, " "), errors, { disallowComments: true });
  if (!root || errors.length > 0) return undefined;
  const node = (tree: TreeNode): Node => {
    const range = { start: tree.offset, end: tree.offset + tree.length };
    const children = tree.children ?? [];
    if (tree.type === "array") return { ...range, items: children.map(node) };
    if (tree.type !== "object") return range;
    const members = children.map(({ children: [key, value] = [] }) => ({
      key: key!.value as string,
      keyStart: key!.offset,
      value: node(value!),
    }));
    for (const [i, { key }] of members.entries())
      if (members.findIndex((member) => member.key === key) < i) duplicates.push(key);
    return { ...range, members };
  };
  return node(root);
}

interface Edit {
  start: number;
  end: number;
  text: string;
}

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

/**
 * Edits `text`, which parses to `before`, so it parses to `after`. Returns undefined when it can't
 * (for example, the offset tree is too deep or an object repeats a key); the caller then writes
 * the whole file. Repeated keys are named in `notes`.
 */
export function editJsonText(
  text: string,
  before: unknown,
  after: unknown,
  notes: string[] = [],
): string | undefined {
  const eol = text.includes("\r\n") ? "\r\n" : "\n";
  const unit = text.match(/\n([ \t]+)\S/)?.[1] ?? "  ";
  const duplicates: string[] = [];
  let root: Node | undefined;
  try {
    root = parse(text, duplicates);
  } catch (error) {
    if (error instanceof RangeError) return undefined;
    throw error;
  }
  if (!root) return undefined;
  // JSON.parse keeps the last of a repeated key, which the text's first one does not match.
  if (duplicates.length > 0) {
    notes.push(
      `it repeats the key${duplicates.length > 1 ? "s" : ""} ${[...new Set(duplicates)].map((key) => JSON.stringify(key)).join(", ")}, so it was written out whole with the last of each`,
    );
    return undefined;
  }
  /** The whitespace a line starts with, for the line holding `at`. */
  const indentAt = (at: number) => {
    const lineStart = text.lastIndexOf("\n", at - 1) + 1;
    return text.slice(lineStart).match(/^[ \t]*/)![0];
  };
  /** Whether `at` is the first thing on its line. */
  const startsLine = (at: number) =>
    /^[ \t]*$/.test(text.slice(text.lastIndexOf("\n", at - 1) + 1, at));
  const multiline = (node: Node) => text.slice(node.start, node.end).includes("\n");
  /** `value` as JSON on one line, spaced as people write it: `{ "a": 1 }`, `["x"]`. */
  const inline = (value: unknown) =>
    JSON.stringify(value, null, 1).replace(/\n\s*/g, " ").replace(/\[ /g, "[").replace(/ \]/g, "]");
  /** `value` laid out on lines, continuing at `indent`. */
  const block = (value: unknown, indent: string) =>
    JSON.stringify(value, null, unit)
      .split("\n")
      .join(eol + indent);

  const edits: Edit[] = [];
  /** Where a new entry goes in `container`, after its last entry, laid out like it. */
  const addAfter = (container: Node, last: Node | undefined, entries: string[]) => {
    if (entries.length === 0) return true;
    if (!last) {
      // An empty container gets one entry per line.
      const indent = indentAt(container.start);
      edits.push({
        start: container.start + 1,
        end: container.end - 1,
        text: `${eol}${entries.map((entry) => indent + unit + entry).join(`,${eol}`)}${eol}${indent}`,
      });
      return true;
    }
    const lineBreak = multiline(container) && startsLine(last.start);
    const separator = lineBreak ? `,${eol}${indentAt(last.start)}` : ", ";
    edits.push({
      start: last.end,
      end: last.end,
      text: entries.map((e) => separator + e).join(""),
    });
    return true;
  };
  /** How a new value is written next to `sibling` (or in an empty container). */
  const layout = (value: unknown, sibling: Node | undefined, container: Node) => {
    const indent =
      sibling && startsLine(sibling.start)
        ? indentAt(sibling.start)
        : indentAt(container.start) + unit;
    // Beside a multi-line sibling, or alone in an empty container, an object or array gets lines.
    const lines = sibling ? multiline(sibling) : isObject(value) || Array.isArray(value);
    return lines ? block(value, indent) : inline(value);
  };
  const replace = (node: Node, value: unknown) => {
    edits.push({
      start: node.start,
      end: node.end,
      text: multiline(node) ? block(value, indentAt(node.start)) : inline(value),
    });
  };
  /** Removes entries `drop` (indexes) from a container whose entries span `spans`. */
  const removeEntries = (
    container: Node,
    spans: { start: number; end: number }[],
    drop: number[],
  ) => {
    if (drop.length === spans.length) {
      edits.push({ start: container.start + 1, end: container.end - 1, text: "" });
      return;
    }
    // Each run of dropped entries goes with the comma before it, or for a run at the start, the
    // comma after it.
    for (let a = 0; a < spans.length; a++) {
      if (!drop.includes(a)) continue;
      let b = a;
      while (drop.includes(b + 1)) b++;
      if (a > 0) edits.push({ start: spans[a - 1]!.end, end: spans[b]!.end, text: "" });
      else edits.push({ start: spans[0]!.start, end: spans[b + 1]!.start, text: "" });
      a = b;
    }
  };

  const walk = (node: Node, from: unknown, to: unknown): boolean => {
    if (same(from, to)) return true;
    if (Array.isArray(from) && Array.isArray(to) && node.items) {
      const items = node.items;
      // Items appended, or items taken out: each kept item stays where it is.
      if (to.length >= from.length && from.every((item, i) => same(item, to[i]))) {
        const added = to.slice(from.length);
        return addAfter(
          node,
          items.at(-1),
          added.map((item) => layout(item, items.at(-1), node)),
        );
      }
      if (to.length < from.length) {
        const drop: number[] = [];
        let j = 0;
        for (let i = 0; i < from.length; i++)
          if (j < to.length && same(from[i], to[j])) j++;
          else drop.push(i);
        if (j === to.length) {
          removeEntries(node, items, drop);
          return true;
        }
      }
      if (to.length === from.length && items.length === from.length)
        return from.every((item, i) => walk(items[i]!, item, to[i]));
      replace(node, to);
      return true;
    }
    if (isObject(from) && isObject(to) && node.members) {
      const members = node.members;
      const drop = members.flatMap((member, i) => (member.key in to ? [] : [i]));
      for (const member of members)
        if (member.key in to && !walk(member.value, from[member.key], to[member.key])) return false;
      const spans = members.map((member) => ({ start: member.keyStart, end: member.value.end }));
      const added = Object.keys(to).filter((key) => !(key in from));
      // Members are appended; a new member that is not last in `to` would change the key order.
      const order = Object.keys(to);
      if (added.some((key, i) => order.indexOf(key) !== order.length - added.length + i))
        return false;
      if (drop.length > 0 && drop.length === members.length && added.length > 0) {
        // Every member replaced: one edit, laid out like the first member was.
        const first = members[0]!;
        const lineBreak = multiline(node) && startsLine(first.keyStart);
        edits.push({
          start: spans[0]!.start,
          end: spans.at(-1)!.end,
          text: added
            .map((key) => `${JSON.stringify(key)}: ${layout(to[key], first.value, node)}`)
            .join(lineBreak ? `,${eol}${indentAt(first.keyStart)}` : ", "),
        });
        return true;
      }
      if (drop.length > 0) removeEntries(node, spans, drop);
      const last = members.filter((_, i) => !drop.includes(i)).at(-1);
      return addAfter(
        node,
        last && { start: last.keyStart, end: last.value.end },
        added.map((key) => {
          const sibling = last?.value;
          return `${JSON.stringify(key)}: ${layout(to[key], sibling, node)}`;
        }),
      );
    }
    replace(node, to);
    return true;
  };

  if (!walk(root, before, after)) return undefined;
  let out = text;
  for (const edit of edits.sort((a, b) => b.start - a.start))
    out = out.slice(0, edit.start) + edit.text + out.slice(edit.end);
  try {
    return same(JSON.parse(out.replace(/^﻿/, "")), after) ? out : undefined;
  } catch {
    return undefined;
  }
}
