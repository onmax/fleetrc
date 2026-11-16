import { existsSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { git, gitOut } from "./exec.ts";
import { sha256 } from "./fs.ts";

/** `owner/repo` and `github:owner/repo` become GitHub HTTPS URLs; anything else is a git URL already. */
export function gitUrl(spec: string): string {
  const github = spec.match(/^(?:github:)?([\w.-]+)\/([\w.-]+?)(?:\.git)?$/);
  if (github && !spec.startsWith(".")) return `https://github.com/${github[1]}/${github[2]}.git`;
  const gitlab = spec.match(/^gitlab:(.+?)(?:\.git)?$/);
  if (gitlab) return `https://gitlab.com/${gitlab[1]}.git`;
  return spec;
}

/** A repository URL reduced to host and path, so its https, ssh and `owner/repo` forms compare equal. */
export const repoKey = (spec: string) =>
  gitUrl(spec)
    .toLowerCase()
    .replace(/^[a-z+]+:\/\//, "")
    .replace(/^[^@/]+@/, "")
    .replace(":", "/")
    .replace(/(\.git)?\/?$/, "");

export interface CachedClone {
  dir: string;
  commit: string;
}

/**
 * A shallow clone of `url` at `ref` (default branch when absent), kept under `root` between runs.
 * The `skills` package clones into a temporary folder on every call; this cache is what lets a
 * timer run cheap and lets `--offline` work.
 */
export async function fetchClone(
  url: string,
  ref: string | undefined,
  root: string,
  { offline = false }: { offline?: boolean } = {},
): Promise<CachedClone> {
  const dir = join(root, sha256(`${url}#${ref ?? ""}`).slice(0, 16));
  const cloned = existsSync(join(dir, ".git"));
  if (offline) {
    if (!cloned) throw new Error(`${url} has never been fetched and --offline is set`);
    return { dir, commit: await gitOut(["rev-parse", "HEAD"], dir) };
  }
  if (!cloned) {
    rmSync(dir, { recursive: true, force: true });
    mkdirSync(root, { recursive: true });
    const args = ["clone", "--quiet", "--depth", "1", "--no-tags"];
    if (ref && !/^[0-9a-f]{40}$/.test(ref)) args.push("--branch", ref);
    try {
      await git([...args, url, dir]);
      if (ref && /^[0-9a-f]{40}$/.test(ref)) await checkoutCommit(dir, ref);
    } catch (error) {
      rmSync(dir, { recursive: true, force: true });
      throw error;
    }
  } else {
    await git(["fetch", "--quiet", "--depth", "1", "--no-tags", "origin", ref ?? "HEAD"], {
      cwd: dir,
    });
    await git(["reset", "--quiet", "--hard", "FETCH_HEAD"], { cwd: dir });
    await git(["clean", "-qfdx"], { cwd: dir });
  }
  return { dir, commit: await gitOut(["rev-parse", "HEAD"], dir) };
}

async function checkoutCommit(dir: string, commit: string) {
  await git(["fetch", "--quiet", "--depth", "1", "origin", commit], { cwd: dir });
  await git(["reset", "--quiet", "--hard", "FETCH_HEAD"], { cwd: dir });
}

/** Splits `<repo>//<path>` (as in `github:org/repo//skills.json`) into the repository and the file. */
export function splitRepoPath(spec: string): { repo: string; path: string } | undefined {
  const scheme = spec.indexOf("://");
  const from = scheme >= 0 ? scheme + 3 : 0;
  const at = spec.indexOf("//", from);
  if (at < 0) return undefined;
  return { repo: spec.slice(0, at), path: spec.slice(at + 2) };
}
