import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vite-plus/test";
import { loginShellPath } from "../src/selfinstall.ts";

it.skipIf(process.platform === "win32")(
  "resolves login PATH despite a profile's pwd function",
  () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "fleetrc-login-path-")));
    try {
      const shell = join(root, "login-shell");
      writeFileSync(
        shell,
        '#!/bin/sh\ncd "${0%/*}" || exit 1\nPATH="$PWD/.local/bin:bin"\npwd() { printf "~/login\\n"; }\neval "$3"\n',
        { mode: 0o755 },
      );
      expect(loginShellPath(shell)).toEqual([join(root, ".local/bin"), join(root, "bin")]);
    } finally {
      rmSync(root, { recursive: true });
    }
  },
);
