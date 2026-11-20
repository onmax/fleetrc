import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vite-plus/test";
import { machine, type Machine, names, remote, skills } from "./fixture.ts";

/**
 * A fake `tailscale` for SKILLFLEET_TAILSCALE that prints `<dir>/status.json`, so a test can change
 * the policy between runs, and touches `<dir>/tailscale-ran`.
 */
function fakeTailscale(m: Machine) {
  const dir = join(m.root, "tailscale");
  mkdirSync(dir, { recursive: true });
  const script = join(dir, "tailscale.mjs");
  writeFileSync(
    script,
    `import { appendFileSync, readFileSync } from "node:fs";
appendFileSync(${JSON.stringify(join(dir, "tailscale-ran"))}, process.argv.slice(2).join(" ") + "\\n");
process.stdout.write(readFileSync(${JSON.stringify(join(dir, "status.json"))}, "utf8"));`,
  );
  const status = join(dir, "status.json");
  return {
    env: { SKILLFLEET_TAILSCALE: script },
    ran: join(dir, "tailscale-ran"),
    /** The policy hands this machine `values` under skillfleet's capability, or nothing. */
    policy(values?: unknown[]) {
      const capMap = values ? { "github.com/onmax/skillfleet": values } : {};
      writeFileSync(
        status,
        JSON.stringify({ BackendState: "Running", Self: { PublicKey: "self", CapMap: capMap } }),
      );
    },
  };
}

const config = (m: Machine) =>
  JSON.parse(readFileSync(m.at(".config/skillfleet/config.json"), "utf8")) as Record<
    string,
    unknown
  >;

function team(m: Machine, name: string, skill: string) {
  const vendor = remote(m, `${name}-skills`, skills("skills/", skill));
  return remote(m, name, {
    ".skillfleet/manifest.json": JSON.stringify({
      agents: ["claude-code"],
      sources: [{ id: name, git: vendor.https }],
    }),
  });
}

describe("the manifest from the tailnet policy", () => {
  it("a new machine runs bare init and syncs the manifest the policy names", async () => {
    const m = machine();
    const tailscale = fakeTailscale(m);
    tailscale.policy([{ manifest: team(m, "home", "from-tailnet").https }]);
    const run = await m.runWith({ env: tailscale.env }, "init", "--no-hooks");
    expect(run.code, run.stdout + run.stderr).toBe(0);
    expect(readFileSync(tailscale.ran, "utf8")).toBe("status --json --peers=false\n");
    expect(config(m)).toMatchObject({
      manifest: "https://git.skillfleet.test/home.git//.skillfleet/manifest.json",
      tailscale: true,
    });
    expect(names(m.at(".claude/skills"))).toEqual(["from-tailnet"]);
    const status = await m.runWith({ env: tailscale.env }, "status");
    expect(status.stdout).toContain("(from the tailnet policy)");
  });

  it("each sync follows the policy to a new manifest, and keeps the last one when Tailscale can't say", async () => {
    const m = machine();
    const tailscale = fakeTailscale(m);
    tailscale.policy([{ manifest: team(m, "home", "first").https }]);
    expect((await m.runWith({ env: tailscale.env }, "init", "--no-hooks")).code).toBe(0);

    tailscale.policy([{ manifest: team(m, "moved", "second").https }]);
    const moved = await m.runWith({ env: tailscale.env }, "sync");
    expect(moved.code, moved.stdout + moved.stderr).toBe(0);
    expect(moved.stdout + moved.stderr).toContain("the tailnet policy now names the manifest");
    expect(config(m).manifest).toBe(
      "https://git.skillfleet.test/moved.git//.skillfleet/manifest.json",
    );
    expect(names(m.at(".claude/skills"))).toEqual(["second"]);

    tailscale.policy();
    const kept = await m.runWith({ env: tailscale.env }, "sync");
    expect(kept.code, kept.stdout + kept.stderr).toBe(0);
    expect(kept.stdout + kept.stderr).toContain("kept the manifest");
    expect(config(m).manifest).toBe(
      "https://git.skillfleet.test/moved.git//.skillfleet/manifest.json",
    );
    expect(names(m.at(".claude/skills"))).toEqual(["second"]);
  });

  it("a dry-run sync names the new manifest without saving it", async () => {
    const m = machine();
    const tailscale = fakeTailscale(m);
    tailscale.policy([{ manifest: team(m, "home", "first").https }]);
    expect((await m.runWith({ env: tailscale.env }, "init", "--no-hooks")).code).toBe(0);
    tailscale.policy([{ manifest: team(m, "moved", "second").https }]);
    const dry = await m.runWith({ env: tailscale.env }, "sync", "--dry-run");
    expect(dry.code, dry.stdout + dry.stderr).toBe(0);
    expect(dry.stdout + dry.stderr).toContain("moved.git");
    expect(config(m).manifest).toBe(
      "https://git.skillfleet.test/home.git//.skillfleet/manifest.json",
    );
  });

  it("does not save a policy repository whose manifest cannot be loaded", async () => {
    const m = machine();
    const tailscale = fakeTailscale(m);
    const home = team(m, "home", "first");
    tailscale.policy([{ manifest: home.https }]);
    expect((await m.runWith({ env: tailscale.env }, "init", "--no-hooks")).code).toBe(0);
    const before = config(m);

    const missing = remote(m, "missing-manifest", { "README.md": "empty" });
    tailscale.policy([{ manifest: missing.https }]);
    const failed = await m.runWith({ env: tailscale.env }, "sync");
    expect(failed.code, failed.stdout + failed.stderr).toBe(1);
    expect(config(m)).toEqual(before);
    const offline = await m.runWith({ env: tailscale.env }, "sync", "--offline");
    expect(offline.code, offline.stdout + offline.stderr).toBe(0);
    tailscale.policy();
    const kept = await m.runWith({ env: tailscale.env }, "sync");
    expect(kept.code, kept.stdout + kept.stderr).toBe(0);
    expect(names(m.at(".claude/skills"))).toEqual(["first"]);
  });

  it("preserves the offline checkout after a rejected file switch in the same repository", async () => {
    const m = machine();
    const tailscale = fakeTailscale(m);
    const home = team(m, "home", "first");
    tailscale.policy([{ manifest: home.https }]);
    expect((await m.runWith({ env: tailscale.env }, "init", "--no-hooks")).code).toBe(0);
    const before = config(m);

    home.commit({
      ".skillfleet/manifest.json": null,
      "new.json": JSON.stringify({ agents: ["claude-code"], sources: [] }),
    });
    tailscale.policy([{ manifest: `${home.https}//missing.json` }]);
    const failed = await m.runWith({ env: tailscale.env }, "sync");
    expect(failed.code, failed.stdout + failed.stderr).toBe(1);
    expect(failed.stderr).toContain("has no missing.json");
    expect(config(m)).toEqual(before);
    const offline = await m.runWith({ env: tailscale.env }, "sync", "--offline");
    expect(offline.code, offline.stdout + offline.stderr).toBe(0);
    expect(names(m.at(".claude/skills"))).toEqual(["first"]);

    const replacement = `${home.https}//new.json`;
    tailscale.policy([{ manifest: replacement }]);
    const switched = await m.runWith({ env: tailscale.env }, "sync");
    expect(switched.code, switched.stdout + switched.stderr).toBe(0);
    expect(config(m).manifest).toBe(replacement);
    const switchedOffline = await m.runWith({ env: tailscale.env }, "sync", "--offline");
    expect(switchedOffline.code, switchedOffline.stdout + switchedOffline.stderr).toBe(0);
  });

  it("accepts --manifest tailscale: for init", async () => {
    const m = machine();
    const tailscale = fakeTailscale(m);
    tailscale.policy([{ manifest: team(m, "home", "first").https }]);
    const run = await m.runWith(
      { env: tailscale.env },
      "init",
      "--manifest",
      "tailscale:",
      "--no-hooks",
    );
    expect(run.code, run.stdout + run.stderr).toBe(0);
    expect(config(m).tailscale).toBe(true);
    expect(names(m.at(".claude/skills"))).toEqual(["first"]);
  });

  it("a machine set up with a manifest of its own never asks Tailscale", async () => {
    const m = machine();
    const tailscale = fakeTailscale(m);
    tailscale.policy([{ manifest: team(m, "other", "unwanted").https }]);
    const own = team(m, "own", "mine");
    expect((await m.runWith({ env: tailscale.env }, "init", own.https, "--no-hooks")).code).toBe(0);
    expect((await m.runWith({ env: tailscale.env }, "init", "--no-hooks")).code).toBe(0);
    expect((await m.runWith({ env: tailscale.env }, "sync")).code).toBe(0);
    expect(existsSync(tailscale.ran)).toBe(false);
    expect(config(m).tailscale).toBeUndefined();
    expect(names(m.at(".claude/skills"))).toEqual(["mine"]);
  });

  it("init with a manifest on a machine that followed the tailnet stops following it", async () => {
    const m = machine();
    const tailscale = fakeTailscale(m);
    tailscale.policy([{ manifest: team(m, "home", "first").https }]);
    expect((await m.runWith({ env: tailscale.env }, "init", "--no-hooks")).code).toBe(0);
    const own = team(m, "own", "mine");
    // Switching manifests drops the old one's skills, which init asks --force for.
    const run = await m.runWith({ env: tailscale.env }, "init", own.https, "--no-hooks", "--force");
    expect(run.code, run.stdout + run.stderr).toBe(0);
    expect(config(m).tailscale).toBeUndefined();
    rmSync(tailscale.ran);
    expect((await m.runWith({ env: tailscale.env }, "sync")).code).toBe(0);
    expect(existsSync(tailscale.ran)).toBe(false);
  });

  it("owner/repo in the policy is GitHub's even beside a folder of that name", async () => {
    const m = machine();
    mkdirSync(m.at("me/skills/.skillfleet"), { recursive: true });
    writeFileSync(m.at("me/skills/.skillfleet/manifest.json"), JSON.stringify({ sources: [] }));
    const tailscale = fakeTailscale(m);
    tailscale.policy([{ manifest: "me/skills" }]);
    const run = await m.runWith(
      { env: tailscale.env },
      "init",
      "--dry-run",
      "--offline",
      "--no-hooks",
    );
    expect(run.stdout + run.stderr).not.toContain("not in a repository");
    expect(run.stdout + run.stderr).toContain("github.com/me/skills");
  });

  it("init that names the manifest the tailnet gave, with an option, keeps following it", async () => {
    const m = machine();
    const tailscale = fakeTailscale(m);
    const home = team(m, "home", "first");
    tailscale.policy([{ manifest: home.https }]);
    expect((await m.runWith({ env: tailscale.env }, "init", "--no-hooks")).code).toBe(0);
    const before = config(m).manifest;
    tailscale.policy([{ manifest: team(m, "moved", "second").https }]);
    rmSync(tailscale.ran);
    const run = await m.runWith({ env: tailscale.env }, "init", home.https, "--no-hooks", "--copy");
    expect(run.code, run.stdout + run.stderr).toBe(0);
    expect(config(m)).toMatchObject({ manifest: before, tailscale: true, copy: true });
    expect(existsSync(tailscale.ran)).toBe(false);
    expect(names(m.at(".claude/skills"))).toEqual(["first"]);
    const synced = await m.runWith({ env: tailscale.env }, "sync");
    expect(synced.code, synced.stdout + synced.stderr).toBe(0);
    expect(names(m.at(".claude/skills"))).toEqual(["second"]);
  });

  it("bare init without Tailscale or without a policy entry says what init needs", async () => {
    const m = machine();
    const missing = await m.runWith(
      { env: { SKILLFLEET_TAILSCALE: join(m.root, "no-tailscale") } },
      "init",
      "--no-hooks",
    );
    expect(missing.code).toBe(2);
    expect(missing.stderr).toContain("init needs a manifest");
    expect(missing.stderr).toContain("not installed");

    const tailscale = fakeTailscale(m);
    tailscale.policy();
    const none = await m.runWith({ env: tailscale.env }, "init", "tailscale:", "--no-hooks");
    expect(none.code).toBe(1);
    expect(none.stderr).toContain('"nodeAttrs"');
    expect(existsSync(m.at(".config/skillfleet/config.json"))).toBe(false);
  });

  it("a policy that names a folder on this machine, or an option, is refused", async () => {
    const m = machine();
    const tailscale = fakeTailscale(m);
    for (const manifest of [m.root, "./skills", "config/team.json", "-oProxyCommand=x", "-o/x"]) {
      tailscale.policy([{ manifest }]);
      const run = await m.runWith(
        { env: tailscale.env },
        "init",
        "tailscale:",
        "--offline",
        "--no-hooks",
      );
      expect(run.code, manifest).toBe(1);
      expect(run.stderr).toContain("not in a repository");
    }
    expect(existsSync(m.at(".config/skillfleet/config.json"))).toBe(false);
  });
});
