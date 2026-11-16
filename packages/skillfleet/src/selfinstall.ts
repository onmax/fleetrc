import {
  accessSync,
  constants,
  chmodSync,
  mkdirSync,
  readlinkSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { delimiter, dirname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { copyDir, hashDir, lstat, sameTree } from "./fs.ts";
import { paths, tildify } from "./paths.ts";

/** The launcher the timer and `fleet` run: an absolute node path and skillfleet's own copy. */
export const launcherPath = () =>
  join(paths.bin(), process.platform === "win32" ? "skillfleet.cmd" : "skillfleet");
export const installedCli = () => join(paths.app(), "cli.mjs");

/** A path inside sh double quotes, where `$`, a backtick, `"` and `\` keep a special meaning. */
const shQuote = (path: string) => `"${path.replace(/[$`"\\]/g, "\\$&")}"`;

/**
 * The sh launcher. On Windows it is for Git Bash, which takes forward slashes. The .cmd launcher
 * finds the copy next to itself through `%~dp0`, so the state folder's path (the user's name, in
 * the code page cmd reads the file in) is never written into it; `%` in node's path is doubled,
 * since cmd expands it even inside quotes.
 */
export function launchers(node: string, cli: string): { sh: string; cmd: string } {
  const posix = (path: string) => (process.platform === "win32" ? path.replace(/\\/g, "/") : path);
  return {
    sh: `#!/bin/sh\nexec ${shQuote(posix(node))} ${shQuote(posix(cli))} "$@"\n`,
    cmd: `@"${node.replace(/%/g, "%%")}" "%~dp0..\\app\\cli.mjs" %*\r\n`,
  };
}

/** The node path a launcher written by `launchers` runs. */
export function launcherNode(text: string): string | undefined {
  const sh = text.match(/^exec "((?:[^"\\]|\\.)*)"/m);
  if (sh) return sh[1]!.replace(/\\(.)/g, "$1");
  const cmd = text.match(/^@"([^"]+)"/m);
  return cmd?.[1]!.replace(/%%/g, "%");
}

/**
 * Copies the running build (one bundled file plus chunks) into the state folder and writes
 * launchers, so scheduled runs never depend on the npx cache or on PATH.
 */
export function selfInstall(): { cli: string; launcher: string; node: string } {
  const dist = dirname(fileURLToPath(import.meta.url));
  const app = paths.app();
  const node = process.execPath;
  // An unchanged copy stays as it is: the timer may be running it right now.
  if (dist !== app && !sameTree(hashDir(dist), hashDir(app))) {
    const temp = `${app}.${process.pid}.tmp`;
    copyDir(dist, temp);
    copyDir(temp, app);
    rmSync(temp, { recursive: true, force: true });
  }
  mkdirSync(paths.bin(), { recursive: true });
  const cli = installedCli();
  const text = launchers(node, cli);
  const sh = join(paths.bin(), "skillfleet");
  writeFileSync(sh, text.sh);
  chmodSync(sh, 0o755);
  if (process.platform === "win32") writeFileSync(join(paths.bin(), "skillfleet.cmd"), text.cmd);
  return { cli, launcher: launcherPath(), node };
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
    return `to run \`skillfleet\` from a new shell, add ${tildify(bin)} to PATH, for example in ~/.profile: export PATH='${bin.replace(/'/g, `'\\''`)}':"$PATH"`;
  }
  return `to run \`skillfleet\` from a new shell, add ${bin} to your user PATH, for example in PowerShell: [Environment]::SetEnvironmentVariable("Path", [Environment]::GetEnvironmentVariable("Path", "User") + ";${bin}", "User")`;
}
