import { spawn, type SpawnOptions } from "node:child_process";

export interface ExecResult {
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  /** Why the command could not start, such as `ENOENT` when it is not installed. */
  spawnError?: string;
}

export interface ExecOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  input?: string;
  timeoutMs?: number;
  shell?: boolean;
}

/** Runs a command to completion and collects its output. Never throws for a non-zero exit. */
export function exec(command: string, args: readonly string[], options: ExecOptions = {}) {
  return new Promise<ExecResult>((resolve) => {
    const spawnOptions: SpawnOptions = {
      cwd: options.cwd,
      env: options.env ?? process.env,
      shell: options.shell ?? false,
      windowsHide: true,
    };
    const child = spawn(command, args, spawnOptions);
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    child.stdout?.setEncoding("utf8").on("data", (chunk: string) => (stdout += chunk));
    child.stderr?.setEncoding("utf8").on("data", (chunk: string) => (stderr += chunk));
    const timer = options.timeoutMs
      ? setTimeout(() => {
          timedOut = true;
          child.kill("SIGKILL");
        }, options.timeoutMs)
      : undefined;
    child.on("error", (error) => {
      clearTimeout(timer);
      const spawnError = (error as NodeJS.ErrnoException).code;
      resolve({ code: null, stdout, stderr: stderr || error.message, timedOut, spawnError });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr, timedOut });
    });
    child.stdin?.on("error", () => {});
    child.stdin?.end(options.input ?? "");
  });
}

const GIT_ENV = { GIT_TERMINAL_PROMPT: "0", GIT_ASKPASS: "", SSH_ASKPASS: "", LC_ALL: "C" };

export class GitError extends Error {
  readonly result: ExecResult;
  constructor(args: readonly string[], result: ExecResult) {
    super(
      result.spawnError === "ENOENT"
        ? "git is not installed, or not on PATH; install git to fetch this source"
        : `git ${args.join(" ")} failed: ${(result.stderr || result.stdout).trim()}`,
    );
    this.result = result;
  }
}

/** Runs git without prompts; throws GitError on a non-zero exit unless `allowFail`. */
export async function git(
  args: readonly string[],
  options: { cwd?: string; timeoutMs?: number; allowFail?: boolean } = {},
): Promise<ExecResult> {
  const result = await exec("git", args, {
    cwd: options.cwd,
    timeoutMs: options.timeoutMs ?? 120_000,
    env: { ...process.env, ...GIT_ENV },
  });
  if (result.code !== 0 && !options.allowFail) throw new GitError(args, result);
  return result;
}

export const gitOut = async (args: readonly string[], cwd?: string) =>
  (await git(args, { cwd })).stdout.trim();
