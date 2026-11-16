import { chmodSync, cpSync, existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { paths } from "./paths.ts";

/** The launcher the timer and `fleet` run: an absolute node path and skillfleet's own copy. */
export const launcherPath = () =>
  join(paths.bin(), process.platform === "win32" ? "skillfleet.cmd" : "skillfleet");
export const installedCli = () => join(paths.app(), "cli.mjs");

/**
 * Copies the running build (one bundled file plus chunks) into the state folder and writes
 * launchers, so scheduled runs never depend on the npx cache or on PATH.
 */
export function selfInstall(): { cli: string; launcher: string; node: string } {
  const dist = dirname(fileURLToPath(import.meta.url));
  const app = paths.app();
  const node = process.execPath;
  if (dist !== app) {
    const temp = `${app}.${process.pid}.tmp`;
    rmSync(temp, { recursive: true, force: true });
    cpSync(dist, temp, { recursive: true });
    rmSync(app, { recursive: true, force: true });
    mkdirSync(dirname(app), { recursive: true });
    cpSync(temp, app, { recursive: true });
    rmSync(temp, { recursive: true, force: true });
  }
  mkdirSync(paths.bin(), { recursive: true });
  const cli = installedCli();
  const sh = join(paths.bin(), "skillfleet");
  const posix = (path: string) => path.replace(/\\/g, "/");
  writeFileSync(sh, `#!/bin/sh\nexec "${posix(node)}" "${posix(cli)}" "$@"\n`);
  chmodSync(sh, 0o755);
  if (process.platform === "win32")
    writeFileSync(join(paths.bin(), "skillfleet.cmd"), `@"${node}" "${cli}" %*\r\n`);
  return { cli, launcher: launcherPath(), node };
}

export const isSelfInstalled = () => existsSync(installedCli());
