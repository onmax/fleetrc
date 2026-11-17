import { spawnSync } from "node:child_process";
import {
  accessSync,
  constants,
  chmodSync,
  mkdirSync,
  readlinkSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { basename, delimiter, dirname, isAbsolute, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { copyDir, hashDir, lstat, sameTree } from "./fs.ts";
import { removeLink } from "./linker.ts";
import { paths, tildify } from "./paths.ts";

/** The launcher the timer and `fleet` run: an absolute node path and skillfleet's own copy. */
export const launcherPath = () =>
  join(paths.bin(), process.platform === "win32" ? "skillfleet.cmd" : "skillfleet");
export const installedCli = () => join(paths.app(), "cli.mjs");

/** A path inside sh double quotes, where `$`, a backtick, `"` and `\` keep a special meaning. */
const shQuote = (path: string) => `"${path.replace(/[$`"\\]/g, "\\$&")}"`;

/**
 * Beside the .cmd launcher, a junction to node's folder when node's path is not ASCII: cmd reads a
 * batch file in the console's code page, where `C:\Users\José\scoop\…` is another path, while
 * `%~dp0` is expanded as Unicode. A short (8.3) name would do only where the volume keeps them, and
 * `chcp 65001` changes the console the user goes on typing in.
 */
export const NODE_LINK = "node-dir";

/**
 * The launchers. The sh one is, on Windows, for Git Bash, which takes forward slashes. The .cmd one
 * finds the copy next to itself through `%~dp0`, so the state folder's path (the user's name, in
 * the code page cmd reads the file in) is never written into it; `%` in node's path is doubled,
 * since cmd expands it even inside quotes. Started by a quoted name it found on PATH
 * (`"skillfleet" sync`), cmd gives `%~dp0` the current folder, so it then finds itself on PATH.
 * The .ps1 one is what PowerShell runs for `skillfleet`: it passes arguments to node as typed,
 * where through the .cmd, cmd would act on `&`, `|`, `^` and `%` in them first. It is UTF-8 with a
 * byte order mark, which Windows PowerShell needs to read it as UTF-8.
 */
export function launchers(
  node: string,
  cli: string,
  options: { nodeLink?: boolean } = {},
): { sh: string; cmd: string; ps1: string } {
  const posix = (path: string) => (process.platform === "win32" ? path.replace(/\\/g, "/") : path);
  const doubled = (path: string) => path.replace(/%/g, "%%");
  const cmdNode = (dir: string) =>
    options.nodeLink ? `${dir}${NODE_LINK}\\${doubled(basename(node))}` : doubled(node);
  const run = (dir: string) => `@"${cmdNode(dir)}" "${dir}..\\app\\cli.mjs" %*`;
  const psNode = `'${node.replace(/['\u2018\u2019\u201A\u201B]/g, "$&$&")}'`;
  return {
    sh: `#!/bin/sh\nexec ${shQuote(posix(node))} ${shQuote(posix(cli))} "$@"\n`,
    cmd: [
      `@if not exist "%~dp0..\\app\\cli.mjs" goto path`,
      run("%~dp0"),
      "@goto :eof",
      ":path",
      run("%~dp$PATH:0"),
      "",
    ].join("\r\n"),
    ps1: `\uFEFF${[
      "# skillfleet's launcher for PowerShell: arguments reach node as typed.",
      "$cli = Join-Path $PSScriptRoot '..\\app\\cli.mjs'",
      `if ($MyInvocation.ExpectingInput) { $input | & ${psNode} $cli $args } else { & ${psNode} $cli $args }`,
      "exit $LASTEXITCODE",
      "",
    ].join("\r\n")}`,
  };
}

/** The node path a launcher written by `launchers` runs; `dir` is the launcher's folder. */
export function launcherNode(text: string, dir = paths.bin()): string | undefined {
  const sh = text.match(/^exec "((?:[^"\\]|\\.)*)"/m);
  if (sh) return sh[1]!.replace(/\\(.)/g, "$1");
  const cmd = text.match(/^@"([^"]+)"/m)?.[1];
  if (cmd === undefined) return undefined;
  const linked = cmd.match(new RegExp(`^%~dp0${NODE_LINK}\\\\(.+)$`))?.[1];
  if (linked === undefined) return cmd.replace(/%%/g, "%");
  try {
    return join(readlinkSync(join(dir, NODE_LINK)), linked.replace(/%%/g, "%"));
  } catch {
    return undefined;
  }
}

const realpath = (path: string) => {
  try {
    return realpathSync(path);
  } catch {
    return undefined;
  }
};

/**
 * PATH folders that a later run, outside this shell, can rely on: absolute, not world-writable,
 * and none of what npx, `pnpm dlx` or npm scripts add for one command (each parent folder's
 * `node_modules/.bin`, the npx and dlx caches, npm's node-gyp-bin). The timer gets these, so it
 * runs nothing that anyone on the machine, or a package in a cache, could drop on PATH.
 */
export function lastingPathDirs(path = process.env.PATH ?? process.env.Path ?? ""): string[] {
  const dirs = path.split(delimiter).filter((dir) => {
    if (!dir || !isAbsolute(dir)) return false;
    const parts = resolve(dir).split(/[\\/]/);
    const at = (name: string) => parts.includes(name);
    if (parts.at(-1) === ".bin" && parts.at(-2) === "node_modules") return false;
    if (at("_npx") || at("node-gyp-bin") || parts.some((part) => /^dlx(-|$)/.test(part)))
      return false;
    if (process.platform === "win32") return true;
    try {
      return (statSync(dir).mode & 0o002) === 0;
    } catch {
      // A folder that does not exist now may still be the user's, such as ~/bin before it is made.
      return true;
    }
  });
  return [...new Set(dirs)];
}

/**
 * The first `command` in the folders of `lastingPathDirs`, the way a shell finds it, without
 * spawning `which` or `where`: a lookup that times out would give the timer another PATH.
 */
export function findOnPath(command: string): string | undefined {
  const names =
    process.platform === "win32"
      ? [".exe", ".cmd", ".bat", ".com"].map((ext) => `${command}${ext}`)
      : [command];
  for (const dir of lastingPathDirs())
    for (const name of names) {
      const file = join(dir, name);
      try {
        if (statSync(file).isFile() && isExecutable(file)) return file;
      } catch {}
    }
  return undefined;
}

/** The Node.js that skillfleet needs: `engines` in package.json and src/entry.ts. */
const NODE_MIN = [22, 12] as const;

/**
 * Version managers whose shim runs the user's chosen Node.js: when node runs from one of their
 * install folders, its own path goes away with the next upgrade, and the shim stays.
 */
function shims(home: string, env: NodeJS.ProcessEnv): { installs: string; shim: string }[] {
  const volta = env.VOLTA_HOME || join(home, ".volta");
  const asdf = env.ASDF_DATA_DIR || join(home, ".asdf");
  const mise =
    env.MISE_DATA_DIR || join(env.XDG_DATA_HOME || join(home, ".local", "share"), "mise");
  return [
    { installs: join(volta, "tools", "image", "node"), shim: join(volta, "bin", "node") },
    { installs: join(asdf, "installs", "nodejs"), shim: join(asdf, "shims", "node") },
    { installs: join(mise, "installs", "node"), shim: join(mise, "shims", "node") },
  ];
}

/** Whether `node`, run from HOME as the timer runs it, is a Node.js skillfleet can run on. */
function runsSupportedNode(node: string, home: string): boolean {
  const run = spawnSync(node, ["-p", "process.versions.node"], {
    cwd: home,
    encoding: "utf8",
    timeout: 15_000,
    windowsHide: true,
  });
  const [major = 0, minor = 0] = (run.stdout ?? "").trim().split(".").map(Number);
  return (
    run.status === 0 && (major > NODE_MIN[0] || (major === NODE_MIN[0] && minor >= NODE_MIN[1]))
  );
}

/**
 * A path to the running Node.js that survives its upgrade, for the launcher and the timer.
 * `process.execPath` is the resolved, versioned binary (a Homebrew Cellar folder, nvm's or a
 * tarball's `node-v24.x`), which an upgrade deletes. In order: the first `node` on PATH that is a
 * link to this binary (what the user's shell runs, such as /opt/homebrew/bin/node), a link in a
 * known place (Homebrew, /usr/local/bin, ~/.local/bin, fnm's default alias), the shim of the
 * version manager this node came from (Volta, asdf, mise); else `process.execPath`.
 */
export function stableNode(
  options: { execPath?: string; env?: NodeJS.ProcessEnv; home?: string } = {},
): string {
  const execPath = options.execPath ?? process.execPath;
  const env = options.env ?? process.env;
  const home = options.home ?? homedir();
  const real = realpath(execPath) ?? execPath;
  const name = process.platform === "win32" ? "node.exe" : "node";
  const fnm = env.FNM_DIR || join(env.XDG_DATA_HOME || join(home, ".local", "share"), "fnm");
  const links = [
    ...lastingPathDirs(env.PATH ?? env.Path ?? "").map((dir) => join(dir, name)),
    "/opt/homebrew/bin/node",
    "/usr/local/bin/node",
    "/home/linuxbrew/.linuxbrew/bin/node",
    join(home, ".local", "bin", "node"),
    join(fnm, "aliases", "default", "bin", "node"),
    join(home, "Library", "Application Support", "fnm", "aliases", "default", "bin", "node"),
    "/usr/bin/node",
  ];
  // fnm's per-shell folders (fnm_multishells) are links too, but each lasts one shell session.
  const found = links.find(
    (link) =>
      link !== real && !link.split(/[\\/]/).includes("fnm_multishells") && realpath(link) === real,
  );
  if (found) return found;
  for (const { installs, shim } of shims(home, env))
    if (real.startsWith(installs + sep) && realpath(shim) && runsSupportedNode(shim, home))
      return shim;
  return execPath;
}

/**
 * Copies the running build (one bundled file plus chunks) into the state folder and writes
 * launchers, so scheduled runs never depend on the npx cache or on PATH.
 */
export function selfInstall(): { cli: string; launcher: string; node: string; notes: string[] } {
  const dist = dirname(fileURLToPath(import.meta.url));
  const app = paths.app();
  const node = stableNode();
  // An unchanged copy stays as it is: the timer may be running it right now.
  if (dist !== app && !sameTree(hashDir(dist), hashDir(app))) {
    const temp = `${app}.${process.pid}.tmp`;
    copyDir(dist, temp);
    copyDir(temp, app);
    rmSync(temp, { recursive: true, force: true });
  }
  const bin = paths.bin();
  mkdirSync(bin, { recursive: true });
  const cli = installedCli();
  const notes: string[] = [];
  let nodeLink = false;
  if (process.platform === "win32") {
    const link = join(bin, NODE_LINK);
    if (lstat(link)) removeLink(link);
    if (/[^\x20-\x7e]/.test(node))
      try {
        symlinkSync(dirname(node), link, "junction");
        nodeLink = true;
      } catch (error) {
        notes.push(
          `could not link ${link} to ${dirname(node)} (${(error as Error).message}), so the .cmd launcher names node's path, which cmd may read in another code page`,
        );
      }
  }
  const text = launchers(node, cli, { nodeLink });
  const sh = join(bin, "skillfleet");
  writeFileSync(sh, text.sh);
  chmodSync(sh, 0o755);
  if (process.platform === "win32") {
    writeFileSync(join(bin, "skillfleet.cmd"), text.cmd);
    const ps1 = join(bin, "skillfleet.ps1");
    const blocked = scriptsBlocked();
    if (blocked) {
      rmSync(ps1, { force: true });
      notes.push(
        `PowerShell's execution policy is ${blocked}, so \`skillfleet\` in PowerShell runs the .cmd launcher, where cmd acts on & | ^ % in arguments; to pass them as typed, run \`Set-ExecutionPolicy -Scope CurrentUser RemoteSigned\`, then \`skillfleet self-install\``,
      );
    } else writeFileSync(ps1, text.ps1);
  }
  return { cli, launcher: launcherPath(), node, notes };
}

/**
 * The execution policy that keeps PowerShell from running a local script (Restricted or
 * AllSigned), in Windows PowerShell or PowerShell 7, or undefined when both run one. PowerShell
 * prefers skillfleet.ps1 to skillfleet.cmd, and with such a policy it fails instead of falling back,
 * so the .ps1 is written only when every PowerShell here runs it. The policy a parent PowerShell
 * set for its own process (`-ExecutionPolicy Bypass`) is not what a new shell gets, so it is left out.
 */
function scriptsBlocked(): string | undefined {
  const env = { ...process.env };
  delete env.PSExecutionPolicyPreference;
  for (const shell of ["powershell.exe", findOnPath("pwsh")]) {
    if (!shell) continue;
    const run = spawnSync(
      shell,
      ["-NoProfile", "-NonInteractive", "-Command", "Get-ExecutionPolicy"],
      {
        encoding: "utf8",
        env,
        timeout: 30_000,
        windowsHide: true,
      },
    );
    const policy = (run.stdout ?? "").trim();
    if (/^(Restricted|AllSigned)$/i.test(policy)) return policy;
  }
  return undefined;
}

const isExecutable = (file: string) => {
  try {
    accessSync(file, process.platform === "win32" ? constants.F_OK : constants.X_OK);
    return true;
  } catch {
    return false;
  }
};

/**
 * Makes `skillfleet` a command in new shells, and says how. A `skillfleet` already on PATH, such
 * as a global npm install, is left alone. Otherwise, when `~/.local/bin` is on PATH (Linux, and
 * macOS when the user put it there), `~/.local/bin/skillfleet` links to the launcher; failing
 * that, the message says which folder to add to PATH. npx and `pnpm dlx` put their own temporary
 * `node_modules/.bin` on PATH, which a new shell does not have, so those folders do not count.
 */
export function commandOnPath(launcher = launcherPath()): string {
  const bin = dirname(launcher);
  const dirs = (process.env.PATH ?? "")
    .split(delimiter)
    .filter((dir) => dir && !resolve(dir).endsWith(`${sep}node_modules${sep}.bin`));
  const names =
    process.platform === "win32" ? ["skillfleet.cmd", "skillfleet.exe"] : ["skillfleet"];
  const found = dirs
    .flatMap((dir) => names.map((name) => join(dir, name)))
    .find((file) => lstat(file) && isExecutable(file));
  if (found)
    return realpathSync(found) === realpathSync(launcher)
      ? `\`skillfleet\` runs ${tildify(launcher)}${found === launcher ? "" : `, through ${tildify(found)}`}`
      : `\`skillfleet\` runs ${tildify(found)}, which is on PATH; the timer runs ${tildify(launcher)}`;
  if (process.platform !== "win32") {
    const local = join(homedir(), ".local", "bin");
    const link = join(local, "skillfleet");
    if (dirs.some((dir) => resolve(dir) === local)) {
      const existing = lstat(link);
      if (!existing) {
        mkdirSync(local, { recursive: true });
        symlinkSync(launcher, link);
      }
      if (!existing || (existing.isSymbolicLink() && readlinkSync(link) === launcher))
        return `\`skillfleet\` runs ${tildify(launcher)}, through ${tildify(link)}`;
    }
    return pathAdvice(bin);
  }
  return `to run \`skillfleet\` from a new shell, add ${bin} to your user PATH, for example in PowerShell: [Environment]::SetEnvironmentVariable("Path", [Environment]::GetEnvironmentVariable("Path", "User") + ";${bin}", "User")`;
}

/**
 * How to put `bin` on PATH in the user's login shell ($SHELL), in the file and syntax that shell
 * reads: zsh, the macOS default, never reads ~/.profile, and bash reads it only without a
 * ~/.bash_profile; csh, tcsh, fish and nushell have their own.
 */
export function pathAdvice(
  bin: string,
  shell = process.env.SHELL ?? "",
  platform: NodeJS.Platform = process.platform,
): string {
  const quoted = `'${bin.replace(/'/g, `'\\''`)}'`;
  const lead = `to run \`skillfleet\` from a new shell, add ${tildify(bin)} to PATH`;
  const name = basename(shell);
  if (name === "fish") return `${lead}: fish_add_path ${quoted}`;
  // csh and tcsh keep PATH in the list $path; tcsh reads ~/.tcshrc before ~/.cshrc.
  if (name === "tcsh" || name === "csh")
    return `${lead}, for example in ${name === "tcsh" ? "~/.tcshrc" : "~/.cshrc"}: set path = ( ${quoted} $path )`;
  // Nushell keeps PATH as a list, set in config.nu ($nu.config-path).
  if (name === "nu")
    return `${lead}, for example in config.nu (\`$nu.config-path\`): $env.PATH = ($env.PATH | split row (char esep) | prepend ${bin.includes("'") ? JSON.stringify(bin) : `'${bin}'`})`;
  const file =
    name === "zsh"
      ? platform === "darwin"
        ? "~/.zprofile"
        : "~/.zshrc"
      : name === "bash"
        ? platform === "darwin"
          ? "~/.bash_profile"
          : "~/.bashrc"
        : "~/.profile";
  return `${lead}, for example in ${file}: export PATH=${quoted}:"$PATH"`;
}
