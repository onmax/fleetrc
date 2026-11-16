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
void import("./cli.ts");
