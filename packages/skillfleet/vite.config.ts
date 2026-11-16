import { defineConfig } from "vite-plus";

export default defineConfig({
  // ESM only, for Node, and publint fails the build on a broken package.json.
  // Every dependency is bundled, so dist/cli.mjs runs on its own: the timer runs a copy of it from
  // the state folder, away from node_modules.
  pack: {
    noExternal: ["skills", "@vite-hub/schedule"],
    deps: {
      onlyBundle: [
        "skills",
        "yaml",
        "nostics",
        "tar",
        "@vite-hub/schedule",
        "@vite-hub/runtime",
        "cron-schedule",
      ],
    },
    entry: { cli: "src/entry.ts" },
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
