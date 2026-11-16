import { existsSync, mkdirSync, realpathSync, rmSync } from "node:fs";
import { join } from "node:path";
import { git, GitError, gitOut } from "./exec.ts";
import { sha256 } from "./fs.ts";

/** `owner/repo` and `github:owner/repo` become GitHub HTTPS URLs; anything else is a git URL already. */
export function gitUrl(spec: string): string {
  const github = spec.match(/^(?:github:)?([\w.-]+)\/([\w.-]+?)(?:\.git)?$/);
  if (github && !spec.startsWith(".")) return `https://github.com/${github[1]}/${github[2]}.git`;
  const gitlab = spec.match(/^gitlab:(.+?)(?:\.git)?$/);
  if (gitlab) return `https://gitlab.com/${gitlab[1]}.git`;
  return spec;
}

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
  if (offline) {
    if (!existsSync(join(dir, ".git")))
      throw new Error(`${url} has never been fetched and --offline is set`);
    return { dir, commit: await gitOut(["rev-parse", "HEAD"], dir) };
  }
  // A cache a killed clone left half made has a .git folder but no commit: clone it again.
  const cloned = existsSync(join(dir, ".git")) && (await usable(dir));
  if (!cloned) {
    rmSync(dir, { recursive: true, force: true });
    mkdirSync(root, { recursive: true });
    const args = ["clone", "--quiet", "--depth", "1", "--no-tags"];
    if (ref && !/^[0-9a-f]{40}$/.test(ref)) args.push("--branch", ref);
    try {
      await git([...args, "--", url, dir]);
      if (ref && /^[0-9a-f]{40}$/.test(ref)) await checkoutCommit(dir, ref);
    } catch (error) {
      rmSync(dir, { recursive: true, force: true });
      throw error;
    }
  } else {
    // A failed fetch is the network or the remote; the cache stays for --offline and later runs.
    await git(["fetch", "--quiet", "--depth", "1", "--no-tags", "--", "origin", ref ?? "HEAD"], {
      cwd: dir,
    });
    try {
      await git(["reset", "--quiet", "--hard", "FETCH_HEAD"], { cwd: dir });
      await git(["clean", "-qfdx"], { cwd: dir });
    } catch (error) {
      // The fetch worked, so the cache itself is broken: start it over.
      if (!(error instanceof GitError) || error.result.code === null) throw error;
      rmSync(dir, { recursive: true, force: true });
      return fetchClone(url, ref, root);
    }
  }
  return { dir, commit: await gitOut(["rev-parse", "HEAD"], dir) };
}

/**
 * The cache is a repository of its own (git does not climb from a broken one to a parent repository,
 * such as a HOME kept in git), with a commit checked out and an origin. Throws when git can't run.
 */
async function usable(dir: string): Promise<boolean> {
  const answer = async (args: string[]) => {
    const run = await git(args, { cwd: dir, allowFail: true });
    if (run.code === null && !run.timedOut) throw new GitError(args, run);
    return run.code === 0 ? run.stdout.trim() : undefined;
  };
  const gitDir = await answer(["rev-parse", "--absolute-git-dir"]);
  if (!gitDir || realpathSync(gitDir) !== realpathSync(join(dir, ".git"))) return false;
  return (
    (await answer(["rev-parse", "--verify", "--quiet", "HEAD"])) !== undefined &&
    (await answer(["remote", "get-url", "origin"])) !== undefined
  );
}

async function checkoutCommit(dir: string, commit: string) {
  await git(["fetch", "--quiet", "--depth", "1", "--", "origin", commit], { cwd: dir });
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
