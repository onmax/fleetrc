import { isRecord } from "./fs.ts";

export interface SkillRecord {
  source: string;
  dir: string;
  addedAt: string;
  changedAt: string;
}

export function skillRecord(record: unknown): SkillRecord | undefined {
  if (!isRecord(record)) return undefined;
  const { source, dir, addedAt, changedAt } = record;
  if (typeof source !== "string" || !source || typeof dir !== "string" || !dir) return undefined;
  const changed = typeof changedAt === "string" ? changedAt : undefined;
  const added = typeof addedAt === "string" ? addedAt : (changed ?? new Date(0).toISOString());
  return { source, dir, addedAt: added, changedAt: changed ?? added };
}
