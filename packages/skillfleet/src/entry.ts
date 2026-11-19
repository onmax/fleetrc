#!/usr/bin/env node
// The bin. It checks the Node version before the bundle loads, since an older Node fails to parse
// the bundle with a SyntaxError that names no version. Keep this file to syntax old versions read:
// no top-level await. MAJOR.MINOR matches `engines` in package.json.
const [MAJOR, MINOR] = [22, 12];
const [major = 0, minor = 0] = process.versions.node.split(".").map(Number);
if (major < MAJOR || (major === MAJOR && minor < MINOR)) {
  console.error(
    `skillfleet needs Node.js ${MAJOR}.${MINOR} or newer, and this is Node.js ${process.versions.node} (${process.execPath}).`,
  );
  process.exit(1);
}
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
  void import("./hook.ts").then((module) => module.runHook(agent));
else void import("./cli.ts");
