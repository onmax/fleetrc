#!/usr/bin/env node
// The bin. It checks the Node version before the bundle loads, since an older Node fails to parse
// the bundle with a SyntaxError that names no version. Keep this file to syntax old versions read:
// no top-level await. MAJOR.MINOR matches `engines` in package.json.
import module from "node:module";
import { homedir, tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";

const [MAJOR, MINOR] = [22, 12];
const [major = 0, minor = 0] = process.versions.node.split(".").map(Number);
if (major < MAJOR || (major === MAJOR && minor < MINOR)) {
  console.error(
    `skillfleet needs Node.js ${MAJOR}.${MINOR} or newer, and this is Node.js ${process.versions.node} (${process.execPath}).`,
  );
  process.exit(1);
}
// Where node keeps the bundle compiled, so a run after the first skips most of its parse: the XDG
// cache folder, else the user's temp folder on Windows, else ~/.cache. Never the state folder, which
// a hook on a machine skillfleet never set up leaves uncreated.
function compileCacheDir(): string {
  const xdg = process.env.XDG_CACHE_HOME;
  if (xdg && isAbsolute(xdg)) return join(xdg, "skillfleet", "compile");
  if (process.platform === "win32") return join(tmpdir(), "skillfleet-compile");
  return join(homedir(), ".cache", "skillfleet", "compile");
}
try {
  // Node 22.1 and newer; a folder that can't be made leaves the cache off.
  module.enableCompileCache?.(compileCacheDir());
} catch {}
// What an agent's session hook runs, when a session starts: hook.ts alone, without the rest of the
// CLI. `hook prompt`, the per-prompt hook older versions documented, does nothing now; settings
// files may still call it, so it exits 0 at once.
const [command, action, agent] = process.argv.slice(2);
if (command === "hook" && action === "prompt" && process.argv.length === 4) process.exitCode = 0;
else if (
  command === "hook" &&
  action === "run" &&
  (agent === "claude-code" || agent === "codex") &&
  process.argv.length === 5
)
  void import("./hook.ts").then((hook) => hook.runHook(agent));
// What programs built on skillfleet run: list.ts reads state.json alone. An error it meets (a
// state.json it may not read) goes to the CLI, which says it in one line.
else if (command === "list" && action === "--json" && process.argv.length === 4)
  void import("./list.ts").then((list) => list.printSkillList()).catch(() => import("./cli.ts"));
else if ((command === "--version" || command === "-v") && process.argv.length === 3)
  void import("./version.ts").then(({ version }) => console.log(version));
else void import("./cli.ts");
