import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, relative } from "node:path";
import { listSkills } from "skills";
import { agentTargets, aliasOf, codexLegacyDir } from "./agents.ts";
import { personalSkillsDir, personalSource } from "./edits.ts";
import { isRecord, lstat, moveDir, readJsonFile } from "./fs.ts";
import { linkTarget, MANIFEST_FILE, removeLink } from "./linker.ts";
import {
  defaultSourceId,
  editManifest,
  type Fork,
  loadManifest,
  type LoadedManifest,
  locateManifest,
  type Manifest,
  parseManifest,
  remoteManifest,
  writeConfig,
} from "./manifest.ts";
import { findName } from "./names.ts";
import { paths, tildify } from "./paths.ts";
import type { Report } from "./report.ts";
import { sync } from "./sync.ts";

export type Migration =
  | { kind: "unfold"; dir: string; target: string }
  | { kind: "unlink"; path: string; target: string }
  | { kind: "backup"; path: string; reason: string }
  | { kind: "adopt"; path: string; to: string };

export interface Imports {
  sources: Record<string, unknown>[];
  forks: Record<string, Fork>;
  notes: string[];
}

export interface InitPlan {
  manifestSpec: string;
  manifestFile: string;
  /** False when the manifest lives in a remote repository skillfleet only reads. */
  editable: boolean;
  /** Skill names any agent folder shows today, and after init. */
  before: string[];
  after: string[];
  lost: string[];
  migrations: Migration[];
  imports: Imports;
  kept: string[];
  sync: Report;
  warnings: string[];
  /** The manifest's `timer` settings, for the timer init installs. */
  timer: Manifest["timer"];
}

/** Names shown in a skills folder (following a whole-folder link), without dotfiles. */
function entries(dir: string): string[] {
  try {
    return readdirSync(dir).filter((name) => !name.startsWith("."));
  } catch {
    return [];
  }
}

interface LockEntry {
  name: string;
  source: string;
  sourceType?: string;
  sourceUrl?: string;
  skillPath?: string;
  commit?: string;
  ref?: string;
}

/** Entries of a `skills-lock.json` (versions 1 and 2 share these fields). */
export function readSkillsLock(file: string): LockEntry[] {
  if (!existsSync(file)) return [];
  const raw = readJsonFile(file);
  if (!isRecord(raw) || (raw.version !== 1 && raw.version !== 2) || !isRecord(raw.skills))
    return [];
  return Object.entries(raw.skills).flatMap(([name, entry]) => {
    if (!isRecord(entry) || typeof entry.source !== "string") return [];
    const text = (key: string) =>
      typeof entry[key] === "string" ? (entry[key] as string) : undefined;
    return [
      {
        name,
        source: entry.source,
        sourceType: text("sourceType"),
        sourceUrl: text("sourceUrl"),
        skillPath: text("skillPath"),
        commit: text("commit"),
        ref: text("ref"),
      },
    ];
  });
}

/** Turns `skills` lock entries into manifest sources and forks. */
async function collectImports(loaded: LoadedManifest): Promise<Imports> {
  const imports: Imports = { sources: [], forks: {}, notes: [] };
  const personal = personalSource(loaded.sources);
  const lockEntries: LockEntry[] = [];
  for (const source of loaded.sources)
    if (source.kind === "clone" || source.kind === "local")
      lockEntries.push(
        ...readSkillsLock(
          join(source.kind === "clone" ? source.path : source.local, "skills-lock.json"),
        ),
      );
  const known = new Set(
    loaded.sources.flatMap((source) =>
      "git" in source ? [source.git] : "index" in source ? [source.index] : [],
    ),
  );
  const grouped = new Map<string, Record<string, unknown> & { include: string[] }>();
  for (const entry of lockEntries) {
    const local = personal ? join(personalSkillsDir(personal), entry.name) : undefined;
    if (local && existsSync(join(local, "SKILL.md"))) {
      if (findName(Object.keys(loaded.root.forks), entry.name) === undefined)
        imports.forks[entry.name] = {
          from: entry.source,
          path: entry.skillPath ? dirname(entry.skillPath) : entry.name,
          base: entry.commit ?? entry.ref ?? "unknown",
        };
      continue;
    }
    if (entry.sourceType === "local") continue;
    const spec =
      entry.sourceType === "well-known" ? (entry.sourceUrl ?? entry.source) : entry.source;
    if (known.has(spec)) continue;
    const key = entry.sourceType === "well-known" ? `index:${spec}` : `git:${spec}`;
    const group = grouped.get(key) ?? {
      ...(entry.sourceType === "well-known" ? { index: spec } : { git: spec }),
      include: [],
    };
    group.include.push(entry.name);
    grouped.set(key, group);
  }
  // Skills installed globally with `npx skills add -g`, as `skills` itself lists them.
  try {
    const global = await listSkills({ scope: "global", config: { telemetry: false } });
    for (const skill of global.skills) {
      if (!skill.source || !/^[\w.-]+\/[\w.-]+$/.test(skill.source) || known.has(skill.source))
        continue;
      const group = grouped.get(`git:${skill.source}`) ?? { git: skill.source, include: [] };
      if (!group.include.includes(skill.name)) group.include.push(skill.name);
      grouped.set(`git:${skill.source}`, group);
    }
  } catch (error) {
    imports.notes.push(`could not read the global skills lock: ${(error as Error).message}`);
  }
  const ids = new Set(loaded.sources.map((source) => source.id));
  for (const group of grouped.values()) {
    let id = defaultSourceId(group);
    for (let n = 2; ids.has(id); n++) id = `${defaultSourceId(group)}-${n}`;
    ids.add(id);
    imports.sources.push({ id, ...group });
  }
  return imports;
}

export async function planInit(
  spec: string,
  { offline = false, dryRun = false } = {},
): Promise<InitPlan> {
  const scratch = mkdtempSync(join(tmpdir(), "skillfleet-init-"));
  try {
    // A dry run fetches a remote manifest into a scratch folder, so it leaves the state folder alone.
    const cache = dryRun ? { cacheRoot: join(scratch, "manifests") } : {};
    const manifestFile = await locateManifest(spec, { offline, ...cache });
    const loaded = await loadManifest(spec, { offline, ...cache });
    const imports = await collectImports(loaded);
    // Plan the sync against the manifest as it will be once the imports are added.
    const raw = readJsonFile(manifestFile);
    if (!isRecord(raw)) throw new Error(`${manifestFile} is not a JSON object`);
    const root = parseManifest(manifestFile, {
      ...raw,
      sources: [...(Array.isArray(raw.sources) ? raw.sources : []), ...imports.sources],
      forks: { ...(isRecord(raw.forks) ? raw.forks : {}), ...imports.forks },
    });
    const augmented: LoadedManifest = {
      root,
      sources: [
        ...root.sources,
        ...loaded.sources.filter((source) => source.origin !== manifestFile),
      ],
      warnings: loaded.warnings,
      failed: loaded.failed,
    };
    const report = await sync({ loaded: augmented, dryRun: true, offline });
    // A remote manifest's file is a cache copy, or in a dry run a scratch one this function deletes.
    report.manifest = remoteManifest(spec) ? spec : manifestFile;
    const provided = new Set(report.skills.names);
    const targets = (await agentTargets(loaded.root.agents)).map((target) => target.dir);
    const legacy = codexLegacyDir();
    const folders = targets.includes(legacy) ? targets : [...targets, legacy];
    const before = new Set(folders.flatMap(entries));
    const personal = personalSource(loaded.sources);
    const adoptInto = personal?.adopt ? personalSkillsDir(personal) : undefined;
    const migrations: Migration[] = [];
    const kept = new Set<string>();
    const adopted = new Set<string>();
    const warnings: string[] = [...report.warnings];

    const handleReal = (path: string, name: string, removeEvenIfKept: boolean) => {
      const hasSkill = existsSync(join(path, "SKILL.md"));
      if (provided.has(name)) {
        migrations.push({ kind: "backup", path, reason: `the manifest provides ${name}` });
      } else if (hasSkill && adoptInto && !lstat(join(adoptInto, name)) && !adopted.has(name)) {
        migrations.push({ kind: "adopt", path, to: join(adoptInto, name) });
        adopted.add(name);
      } else if (removeEvenIfKept && adopted.has(name)) {
        migrations.push({ kind: "backup", path, reason: `${name} is adopted from another folder` });
      } else {
        kept.add(name);
        warnings.push(
          `${tildify(path)} stays: ${hasSkill ? "no source provides it and there is no adopt source" : "it has no SKILL.md"}`,
        );
      }
    };

    for (const dir of folders) {
      const stat = lstat(dir);
      if (!stat) continue;
      const isLegacy = dir === legacy && !targets.includes(legacy);
      if (stat.isSymbolicLink()) {
        // A link to another agent folder shows that folder's skills, which this plan already counts.
        if (aliasOf(dir)) continue;
        const target = linkTarget(dir);
        migrations.push({ kind: "unfold", dir, target });
        for (const name of entries(dir)) if (!provided.has(name)) kept.delete(name);
        continue;
      }
      const ours = new Set(Object.keys(readOwnLinks(dir)));
      for (const name of entries(dir)) {
        const path = join(dir, name);
        const entry = lstat(path);
        if (!entry || ours.has(name)) continue;
        if (entry.isSymbolicLink()) {
          // The manifest links it again (into an agent folder, never into Codex's old one).
          if (provided.has(name))
            migrations.push({ kind: "unlink", path, target: linkTarget(path) });
          else {
            kept.add(name);
            warnings.push(
              `${tildify(path)} stays: it links to ${tildify(linkTarget(path))}, which no source provides`,
            );
          }
          continue;
        }
        if (entry.isDirectory()) handleReal(path, name, isLegacy);
        else kept.add(name);
      }
      if (isLegacy)
        for (const file of [".nuxt-skills-managed", ".skills-managed"])
          if (lstat(join(dir, file)))
            migrations.push({
              kind: "backup",
              path: join(dir, file),
              reason: "list of an old installer's copies",
            });
    }
    // A name that only lived in Codex's old folder and was unlinked there is lost unless something else keeps it.
    const after = new Set([...provided, ...kept, ...adopted]);
    const lost = [...before].filter((name) => !after.has(name)).sort();
    return {
      manifestSpec: spec,
      // A dry run's copy of a remote manifest is gone when this returns.
      manifestFile: dryRun && remoteManifest(spec) ? spec : manifestFile,
      editable: !remoteManifest(spec),
      before: [...before].sort(),
      after: [...after].sort(),
      lost,
      migrations,
      imports,
      kept: [...kept].sort(),
      sync: report,
      warnings,
      timer: root.timer,
    };
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

function readOwnLinks(dir: string): Record<string, unknown> {
  try {
    const raw: unknown = JSON.parse(readFileSync(join(dir, MANIFEST_FILE), "utf8"));
    return isRecord(raw) && isRecord(raw.links) ? raw.links : {};
  } catch {
    return {};
  }
}

/** The plan as text. `errors: false` leaves out the sync's errors, for when the real sync prints them next. */
export function formatPlan(plan: InitPlan, { errors = true } = {}): string {
  const lines = [
    `skillfleet init: manifest ${plan.editable ? tildify(plan.manifestFile) : plan.manifestSpec}`,
  ];
  for (const migration of plan.migrations) {
    switch (migration.kind) {
      case "unfold":
        lines.push(
          `  replace the link ${tildify(migration.dir)} -> ${tildify(migration.target)} with one link per skill`,
        );
        break;
      case "unlink":
        lines.push(`  remove the link ${tildify(migration.path)} -> ${tildify(migration.target)}`);
        break;
      case "backup":
        lines.push(`  move ${tildify(migration.path)} to the backup folder (${migration.reason})`);
        break;
      case "adopt":
        lines.push(`  adopt ${tildify(migration.path)} into ${tildify(migration.to)}`);
        break;
      default: {
        const exhaustive: never = migration;
        return exhaustive;
      }
    }
  }
  for (const source of plan.imports.sources)
    lines.push(`  add source from skills-lock.json: ${JSON.stringify(source)}`);
  for (const [name, fork] of Object.entries(plan.imports.forks))
    lines.push(`  record fork ${name}: ${fork.from} ${fork.path} at ${fork.base}`);
  lines.push(
    `  link ${plan.sync.skills.total} skills into ${plan.sync.targets.length} agent folders: ${plan.sync.targets.map((target) => tildify(target.dir)).join(", ")}`,
  );
  for (const shadow of plan.sync.shadowed)
    lines.push(`  shadowed: ${shadow.skill} from ${shadow.loser} (${shadow.winner} wins)`);
  if (errors) for (const error of plan.sync.errors) lines.push(`  error: ${error}`);
  for (const warning of new Set(plan.warnings)) lines.push(`  warning: ${warning}`);
  lines.push(
    `  skill names: ${plan.before.length} before, ${plan.after.length} after${plan.lost.length ? `; LOST: ${plan.lost.join(", ")}` : "; none lost"}`,
  );
  lines.push(`  names after: ${plan.after.join(", ")}`);
  return lines.join("\n");
}

/** Carries out a plan: back up, adopt, unfold folder links, write config and imports. Sync runs after. */
export function applyPlan(plan: InitPlan): string[] {
  const done: string[] = [];
  const backupRoot = join(paths.backup(), new Date().toISOString().replace(/[:.]/g, "-"));
  const unfold: Extract<Migration, { kind: "unfold" }>[] = [];
  for (const migration of plan.migrations) {
    switch (migration.kind) {
      case "unfold":
        unfold.push(migration);
        break;
      case "unlink":
        removeLink(migration.path);
        done.push(`removed ${tildify(migration.path)}`);
        break;
      case "backup": {
        // Keep the path from HOME, so ~/.codex/skills/x and ~/.claude/skills/x do not collide.
        const fromHome = relative(homedir(), migration.path);
        const to = join(
          backupRoot,
          fromHome.startsWith("..") || isAbsolute(fromHome) ? basename(migration.path) : fromHome,
        );
        moveDir(migration.path, to);
        done.push(`moved ${tildify(migration.path)} to ${tildify(to)}`);
        break;
      }
      case "adopt":
        moveDir(migration.path, migration.to);
        done.push(
          `adopted ${tildify(migration.path)} into ${tildify(migration.to)}; commit it there`,
        );
        break;
      default: {
        const exhaustive: never = migration;
        return exhaustive;
      }
    }
  }
  for (const migration of unfold) {
    removeLink(migration.dir);
    mkdirSync(migration.dir, { recursive: true });
    done.push(`${tildify(migration.dir)} is now a folder of links`);
  }
  writeConfig({ manifest: plan.manifestSpec });
  const hasImports = plan.imports.sources.length > 0 || Object.keys(plan.imports.forks).length > 0;
  if (hasImports && !plan.editable)
    done.push(
      `the manifest is in a remote repository, so add the imported sources there: ${JSON.stringify(plan.imports)}`,
    );
  else if (hasImports) {
    editManifest(plan.manifestFile, (raw) => {
      raw.sources = [...(Array.isArray(raw.sources) ? raw.sources : []), ...plan.imports.sources];
      raw.forks = { ...(isRecord(raw.forks) ? raw.forks : {}), ...plan.imports.forks };
    });
    done.push(
      `added ${plan.imports.sources.length} sources and ${Object.keys(plan.imports.forks).length} forks from skills-lock.json to ${tildify(plan.manifestFile)}`,
    );
  }
  return done;
}
