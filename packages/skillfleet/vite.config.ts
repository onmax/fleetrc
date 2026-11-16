import { defineConfig } from "vite-plus";

export default defineConfig({
  // ESM only, for Node, and publint fails the build on a broken package.json.
  // `skills` is bundled, so dist/cli.mjs runs on its own: the timer runs a copy of it from the
  // state folder, away from node_modules.
  pack: {
    noExternal: ["skills"],
    deps: { onlyBundle: ["skills", "yaml", "nostics", "tar"] },
    entry: { cli: "src/cli.ts" },
    format: ["esm"],
    platform: "node",
    fixedExtension: true,
    clean: true,
    publint: true,
  },
  test: {
    include: ["test/**/*.test.ts"],
    // End-to-end tests run the built CLI against real git and HTTP.
    testTimeout: 120_000,
    hookTimeout: 120_000,
  },
  staged: {
    "*": "vp check --fix",
  },
  fmt: { ignorePatterns: ["**/dist/**"] },
  lint: {
    ignorePatterns: ["**/dist/**"],
    options: { typeAware: true, typeCheck: false },
  },
});
