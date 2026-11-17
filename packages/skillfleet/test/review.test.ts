// Regression cases for an independent review of main at a05dd0d (CX1–CX9): security and data-loss
// bugs, each reproduced here first. Every run uses the fixture's temporary HOME, and every scheduler
// call goes to the fixture's fake.
import {
  appendFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { gzipSync } from "node:zlib";
import { afterEach, describe, expect, it } from "vite-plus/test";
import { changedFiles, hashDir } from "../src/fs.ts";
import { isRemoteGit, rewriteUrl } from "../src/manifest.ts";
import { loadState, saveState, type State } from "../src/state.ts";
import { type LockHolder, LockHeldError, takeLock } from "../src/sync.ts";
import {
  clone,
  http,
  isWindows,
  machine,
  type Machine,
  names,
  read,
  remote,
  type Files,
  type Report,
  sha256,
  skillMd,
  skills,
  writeFiles,
} from "./fixture.ts";

/** Runs init with --json: its sync report, with the plan's warnings added. */
async function init(m: Machine, manifest: string): Promise<Report> {
  const out = await m.json<{ plan: { warnings?: string[] }; sync: Report }>(
    "init",
    manifest,
    "--no-timer",
  );
  return { ...out.sync, warnings: [...out.sync.warnings, ...(out.plan.warnings ?? [])] };
}

/** Commits a symlink `path -> target` to a remote's working copy and pushes it. */
function commitLink(m: Machine, work: string, path: string, target: string) {
  mkdirSync(join(work, path, ".."), { recursive: true });
  symlinkSync(target, join(work, path));
  m.git(work, "add", "-A");
  m.git(work, "commit", "--quiet", "-m", `link ${path}`);
  m.git(work, "push", "--quiet", "origin", "main");
}

/** Files under `dirs` whose text contains `needle`, without following links. */
function containing(needle: string, ...dirs: string[]): string[] {
  const hits: string[] = [];
  const walk = (dir: string) => {
    if (!existsSync(dir)) return;
    for (const name of readdirSync(dir)) {
      const path = join(dir, name);
      const stat = lstatSync(path);
      if (stat.isDirectory()) walk(path);
      else if (stat.isFile() && readFileSync(path, "utf8").includes(needle)) hits.push(path);
    }
  };
  for (const dir of dirs) walk(dir);
  return hits;
}

/** A folder outside every source: a skill and a key nobody published. */
function privateFolder(m: Machine): string {
  const dir = join(m.root, "private");
  writeFiles(dir, {
    "secret/SKILL.md": skillMd("secret", "PRIVATE skill body"),
    "secret/key.txt": "PRIVATE KEY\n",
    id_rsa: "PRIVATE KEY\n",
  });
  return dir;
}

const lines = (...body: string[]) =>
  `---\nname: tool\ndescription: The tool skill\n---\n${body.join("\n")}\n`;

/** A personal working clone (adopt) and a vendored source `vendor` with `tool`, synced. */
async function personalAndVendor(m: Machine, personalFiles = skills("skills/", "mine")) {
  const personal = remote(m, "personal", personalFiles);
  const vendor = remote(m, "vendor", {
    "skills/tool/SKILL.md": lines("one", "two", "three"),
    "skills/tool/ref.md": "ref v1\n",
  });
  return { personal, vendor };
}

describe("CX1. discovery stays inside a fetched source", () => {
  it.skipIf(isWindows).each<{ via: string; files: Files; link: string }>([
    {
      via: "a skills.sh.json path",
      files: { "skills.sh.json": JSON.stringify({ paths: ["./escape"] }) },
      link: "escape",
    },
    {
      via: "a plugin manifest's skill path",
      files: {
        ".claude-plugin/plugin.json": JSON.stringify({ name: "p", skills: ["./escape/secret"] }),
      },
      link: "escape",
    },
    { via: "an agent's project skills folder", files: {}, link: ".agents/skills" },
  ])(
    "CX1. a link that leaves the repository, reached through $via, is not read",
    async ({ files, link }) => {
      const m = machine();
      const outside = privateFolder(m);
      const vendor = remote(m, "vendor", { ...skills("skills/", "tool"), ...files });
      commitLink(m, vendor.work, link, outside);
      const manifest = m.manifest({
        agents: ["claude-code"],
        sources: [{ id: "vendor", git: vendor.url }],
      });
      const run = await init(m, manifest);
      expect(names(m.at(".claude/skills"))).not.toContain("secret");
      expect(containing("PRIVATE", m.home)).toEqual([]);
      expect([...run.warnings, ...run.errors].join("\n")).toContain(link);
    },
  );

  it.skipIf(isWindows)(
    "CX1. a linked skill folder's own skills.sh.json cannot lead out of the repository",
    async () => {
      const m = machine();
      const outside = privateFolder(m);
      const vendor = remote(m, "vendor", {
        ...skills("shared/", "tool"),
        "shared/tool/skills.sh.json": JSON.stringify({ paths: ["./escape"] }),
      });
      commitLink(m, vendor.work, "shared/tool/escape", outside);
      commitLink(m, vendor.work, "skills/tool", "../shared/tool");
      const manifest = m.manifest({
        agents: ["claude-code"],
        sources: [{ id: "vendor", git: vendor.url, skills: "skills/*" }],
      });
      await m.run("init", manifest, "--no-timer");
      expect(names(m.at(".claude/skills"))).not.toContain("secret");
      expect(containing("PRIVATE", m.home)).toEqual([]);
    },
  );
});

describe("CX2. fork merge never reads through upstream links", () => {
  /** `tool` forked into the personal clone, unedited since. */
  async function forked() {
    const m = machine();
    const { personal, vendor } = await personalAndVendor(m);
    const work = clone(m, personal, "code/skills");
    const manifest = m.manifest({
      agents: ["claude-code"],
      sources: [
        { id: "personal", git: personal.url, path: work, skills: "skills/*", adopt: true },
        { id: "vendor", git: vendor.url },
      ],
    });
    expect((await m.run("init", manifest, "--no-timer")).code).toBe(0);
    const fork = await m.run("fork", "tool");
    expect(fork.code, fork.stdout + fork.stderr).toBe(0);
    return { m, work, vendor };
  }

  it.skipIf(isWindows)(
    "CX2. upstream replacing the forked folder with a link out of the repository copies nothing",
    async () => {
      const { m, work, vendor } = await forked();
      const outside = privateFolder(m);
      vendor.commit({ "skills/tool": null });
      commitLink(m, vendor.work, "skills/tool", outside);
      const merge = await m.run("merge", "tool");
      expect(merge.code).not.toBe(0);
      expect(containing("PRIVATE", work)).toEqual([]);
      expect(read(join(work, "skills/tool/ref.md"))).toBe("ref v1\n");
    },
  );

  it.skipIf(isWindows)(
    "CX2. upstream replacing a file with a link out of the repository does not copy what it points at",
    async () => {
      const { m, work, vendor } = await forked();
      const outside = privateFolder(m);
      vendor.commit({ "skills/tool/ref.md": null });
      commitLink(m, vendor.work, "skills/tool/ref.md", join(outside, "id_rsa"));
      await m.run("merge", "tool");
      expect(containing("PRIVATE", work)).toEqual([]);
    },
  );
});

describe("CX3. fork, adopt and init write only inside the personal clone", () => {
  /** A personal clone whose `skills` folder is a link out of it, and a vendored `tool`. */
  async function escapingClone() {
    const m = machine();
    const outside = join(m.root, "outside");
    mkdirSync(outside, { recursive: true });
    const { personal, vendor } = await personalAndVendor(m, { "README.md": "personal\n" });
    commitLink(m, personal.work, "skills", outside);
    const work = clone(m, personal, "code/skills");
    const manifest = m.manifest({
      agents: ["claude-code"],
      sources: [
        { id: "personal", git: personal.url, path: work, skills: "skills/*", adopt: true },
        { id: "vendor", git: vendor.url },
      ],
    });
    return { m, outside, work, manifest };
  }

  it.skipIf(isWindows)(
    "CX3. fork refuses a skills folder that links out of the clone",
    async () => {
      const { m, outside, manifest } = await escapingClone();
      await m.run("init", manifest, "--no-timer");
      const fork = await m.run("fork", "tool");
      expect(fork.code).not.toBe(0);
      expect(readdirSync(outside)).toEqual([]);
      expect(existsSync(join(m.stateDir, "store", "vendor", "live", "tool", "SKILL.md"))).toBe(
        true,
      );
    },
  );

  it.skipIf(isWindows)(
    "CX3. adopt refuses a skills folder that links out of the clone",
    async () => {
      const { m, outside, manifest } = await escapingClone();
      await m.run("init", manifest, "--no-timer");
      const handmade = m.at("handmade");
      writeFiles(handmade, { "SKILL.md": skillMd("handmade") });
      const adopt = await m.run("adopt", handmade);
      expect(adopt.code).not.toBe(0);
      expect(readdirSync(outside)).toEqual([]);
      expect(read(join(handmade, "SKILL.md"))).toBe(skillMd("handmade"));
    },
  );

  it.skipIf(isWindows)(
    "CX3. init does not move a hand-made skill through a skills folder that links out of the clone",
    async () => {
      const { m, outside, manifest } = await escapingClone();
      writeFiles(m.at(".claude/skills/handmade"), { "SKILL.md": skillMd("handmade", "HANDMADE") });
      await m.run("init", manifest, "--no-timer");
      expect(readdirSync(outside)).toEqual([]);
      expect(containing("HANDMADE", m.home)).not.toEqual([]);
    },
  );
});

describe("CX4. stale lock takeover admits one sync", () => {
  /** Lock texts for fake syncs; pid 1 left the stale lock and is gone. */
  const holder = (pid: number) => JSON.stringify({ pid, started: 1, at: Date.now() });
  const staleBecause = (lock: LockHolder) => (lock.pid === 1 ? "its sync is gone" : undefined);
  let dir: string;
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  /**
   * Sync 2 breaks the stale lock. Sync 3 runs at step `first` of sync 2's takeover, and sync 5 at
   * step `second`; sync 4 runs at step `inner` of sync 3's attempt. Returns the syncs that believe
   * they hold the lock.
   */
  function race(first: number, second: number, inner: number) {
    dir = mkdtempSync(join(tmpdir(), "skillfleet-lock-"));
    const file = join(dir, "sync.lock");
    writeFileSync(file, holder(1));
    const holders: number[] = [];
    const attempt = (pid: number, step?: () => void) => {
      try {
        takeLock(file, holder(pid), { staleBecause, step });
        holders.push(pid);
      } catch (error) {
        if (!(error instanceof LockHeldError)) throw error;
      }
    };
    let steps = 0;
    attempt(2, () => {
      const at = steps++;
      if (at === first) {
        let own = 0;
        attempt(3, () => {
          if (own++ === inner) attempt(4);
        });
      }
      if (at === second) attempt(5);
    });
    return { holders, file };
  }

  it("CX4. whatever runs between the steps of a takeover, exactly one sync holds the lock", () => {
    for (let first = 0; first < 8; first++)
      for (let second = first; second < 8; second++)
        for (let inner = 0; inner < 8; inner++) {
          const { holders, file } = race(first, second, inner);
          const when = `sync 3 at step ${first} (sync 4 at its step ${inner}), sync 5 at step ${second}`;
          expect(holders, when).toHaveLength(1);
          expect(existsSync(file) && JSON.parse(read(file)).pid, when).toBe(holders[0]);
          rmSync(dir, { recursive: true, force: true });
        }
  });
});

describe("CX5. retiring a source keeps edits state.json never recorded", () => {
  it("CX5. an edited skill a killed sync installed without a record is backed up", async () => {
    const m = machine();
    const vendor = remote(m, "vendor", skills("skills/", "tool"));
    const manifest = m.manifest({
      agents: ["claude-code"],
      sources: [{ id: "vendor", git: vendor.url }],
    });
    expect((await m.run("init", manifest, "--no-timer")).code).toBe(0);
    // A sync killed after it installed `fresh` and before it saved its record; then the user edits it.
    const store = join(m.stateDir, "store", "vendor");
    writeFiles(join(store, "live", "fresh"), {
      "SKILL.md": `${skillMd("fresh")}\nmy edit of fresh\n`,
    });
    writeFiles(join(store, "base", "fresh"), { "SKILL.md": skillMd("fresh") });
    writeFileSync(manifest, JSON.stringify({ agents: ["claude-code"], sources: [] }));
    const report = await m.json("sync");
    expect(containing("my edit of fresh", m.home)).not.toEqual([]);
    expect(report.warnings.join("\n")).toContain("fresh");
  });
});

describe("CX6. merge never overwrites a file beside a conflict", () => {
  async function bothAdded() {
    const m = machine();
    const vendor = remote(m, "vendor", skills("skills/", "tool"));
    const manifest = m.manifest({
      agents: ["claude-code"],
      sources: [{ id: "vendor", git: vendor.url }],
    });
    expect((await m.run("init", manifest, "--no-timer")).code).toBe(0);
    writeFileSync(m.at(".claude/skills/tool/added.txt"), "mine\n");
    return { m, vendor, dir: m.at(".claude/skills/tool") };
  }

  it("CX6. an existing .upstream file keeps the user's content", async () => {
    const { m, vendor, dir } = await bothAdded();
    writeFileSync(join(dir, "added.txt.upstream"), "my notes\n");
    vendor.commit({ "skills/tool/added.txt": "theirs\n" });
    await m.run("sync");
    const merge = await m.run("merge", "tool");
    expect(merge.stdout).toContain("conflicts: added.txt");
    expect(read(join(dir, "added.txt.upstream"))).toBe("my notes\n");
    expect(read(join(dir, "added.txt"))).toBe("mine\n");
    expect(containing("theirs", dir)).toHaveLength(1);
  });

  it.skipIf(isWindows)(
    "CX6. merge does not write through a link at the sidecar's path",
    async () => {
      const { m, vendor, dir } = await bothAdded();
      const outside = join(m.root, "outside.txt");
      writeFileSync(outside, "keep\n");
      symlinkSync(outside, join(dir, "added.txt.upstream"));
      vendor.commit({ "skills/tool/added.txt": "theirs\n" });
      await m.run("sync");
      await m.run("merge", "tool");
      expect(read(outside)).toBe("keep\n");
      expect(containing("theirs", dir)).toHaveLength(1);
    },
  );
});

describe("CX7. names that are Object.prototype keys", () => {
  it("CX7. an edited file named __proto__ is an edit, held from upstream", async () => {
    const m = machine();
    const vendor = remote(m, "vendor", {
      ...skills("skills/", "tool"),
      "skills/tool/__proto__": "v1\n",
    });
    const manifest = m.manifest({
      agents: ["claude-code"],
      sources: [{ id: "vendor", git: vendor.url }],
    });
    expect((await m.run("init", manifest, "--no-timer")).code).toBe(0);
    expect(read(m.at(".claude/skills/tool/__proto__"))).toBe("v1\n");
    writeFileSync(m.at(".claude/skills/tool/__proto__"), "mine\n");
    vendor.commit({ "skills/tool/__proto__": "v2\n" });
    const report = await m.json("sync");
    expect(read(m.at(".claude/skills/tool/__proto__"))).toBe("mine\n");
    expect(report.edited).toEqual([{ source: "vendor", skill: "tool", files: ["__proto__"] }]);
  });

  it("CX7. file hashes keep __proto__ and constructor as files", () => {
    const dir = mkdtempSync(join(tmpdir(), "skillfleet-proto-"));
    try {
      writeFiles(dir, { ["__proto__"]: "a", constructor: "b", "x/toString": "c" });
      const hashes = hashDir(dir);
      expect(Object.keys(hashes).sort()).toEqual(["__proto__", "constructor", "x/toString"]);
      expect(changedFiles({}, hashes)).toEqual(["__proto__", "constructor", "x/toString"]);
      expect(changedFiles(hashes, {})).toEqual(["__proto__", "constructor", "x/toString"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("CX7. state.json keeps skills and sources named like Object.prototype keys", () => {
    const dir = mkdtempSync(join(tmpdir(), "skillfleet-proto-"));
    const before = process.env.XDG_STATE_HOME;
    process.env.XDG_STATE_HOME = dir;
    try {
      // Parsed, as state.json is: an object literal would read __proto__ as its prototype.
      const state = JSON.parse(`{
        "version": 1,
        "sources": {
          "__proto__": {
            "kind": "git",
            "skills": { "__proto__": { "hashes": { "__proto__": "h" } }, "constructor": { "hashes": {} } },
            "pending": {}
          }
        },
        "skills": { "__proto__": { "source": "__proto__", "dir": "/x", "addedAt": "t", "changedAt": "t" } }
      }`) as State;
      saveState(state);
      const loaded = loadState();
      expect(Object.keys(loaded.sources)).toEqual(["__proto__"]);
      expect(Object.keys(loaded.sources.__proto__!.skills).sort()).toEqual([
        "__proto__",
        "constructor",
      ]);
      expect(Object.keys(loaded.sources.__proto__!.skills.__proto__!.hashes)).toEqual([
        "__proto__",
      ]);
      expect(Object.keys(loaded.skills)).toEqual(["__proto__"]);
      expect("toString" in loaded.skills).toBe(false);
      expect("constructor" in loaded.sources).toBe(false);
    } finally {
      if (before === undefined) delete process.env.XDG_STATE_HOME;
      else process.env.XDG_STATE_HOME = before;
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("CX8. an extended manifest names only remote repositories", () => {
  // An alias in the user's git config: `url.<to>.insteadOf <from>`, and the URL the team names.
  const alias = (m: Machine, to: string, key = "insteadOf") => {
    appendFileSync(
      join(m.root, "gitconfig"),
      `[url "${to.replace(/\\/g, "/")}"]\n\t${key} = https://mirror.skillfleet.test/private.git\n`,
    );
    return "https://mirror.skillfleet.test/private.git";
  };
  it.each([
    { kind: "a path", spec: (url: string) => url },
    { kind: "a relative path", spec: () => "../remotes/private.git" },
    { kind: "a file: URL", spec: (url: string) => pathToFileURL(url).href },
    { kind: "an ext:: command", spec: () => "ext::git %G" },
    { kind: "an insteadOf alias of a path", spec: (url: string, m: Machine) => alias(m, url) },
    {
      kind: "an insteadOf alias of a file: URL",
      spec: (url: string, m: Machine) => alias(m, pathToFileURL(url).href),
    },
    {
      kind: "a pushInsteadOf alias of a path",
      spec: (url: string, m: Machine) => alias(m, url, "pushInsteadOf"),
    },
  ])("CX8. a team manifest's git source that is $kind is refused", async ({ spec }) => {
    const m = machine();
    const local = remote(m, "private", skills("skills/", "private"));
    const team = join(m.root, "team", "skills.json");
    writeFiles(join(m.root, "team"), {
      "skills.json": JSON.stringify({ sources: [{ id: "team", git: spec(local.url, m) }] }),
    });
    const manifest = m.manifest({ agents: ["claude-code"], extends: [team], sources: [] });
    const run = await init(m, manifest);
    expect(names(m.at(".claude/skills"))).not.toContain("private");
    expect(existsSync(join(m.stateDir, "store", "team"))).toBe(false);
    expect(run.warnings.join("\n")).toMatch(/team.*remote/);
  });

  it("R7-15. a team manifest's insteadOf alias of a remote repository is allowed", async () => {
    const m = machine();
    const vendor = remote(m, "private", skills("skills/", "private"));
    const team = join(m.root, "team", "skills.json");
    writeFiles(join(m.root, "team"), {
      "skills.json": JSON.stringify({ sources: [{ id: "team", git: alias(m, vendor.served) }] }),
    });
    const manifest = m.manifest({ agents: ["claude-code"], extends: [team], sources: [] });
    const run = await init(m, manifest);
    expect(run.warnings.join("\n")).not.toContain("ignored source");
    expect(names(m.at(".claude/skills"))).toEqual(["private"]);
  });

  it("R7-15. each spelling of a repository is remote or not, after the user's rewrites", () => {
    const remote = [
      "owner/repo",
      "github:owner/repo",
      "gitlab:group/sub/repo",
      "https://git.example.com/team/repo.git",
      "http://gitea.local:3000/team/repo.git",
      "git://git.example.com/repo.git",
      "ssh://git@git.example.com:2222/repo.git",
      "git+ssh://git.example.com/repo.git",
      "git@github.com:owner/repo.git",
      "gitea:team/repo.git",
    ];
    const local = [
      "/srv/git/repo.git",
      "./repo.git",
      "../repo.git",
      "repo.git",
      "C:/git/repo.git",
      "C:\\git\\repo.git",
      "file:///srv/git/repo.git",
      "ext::git %G",
      "ext::sh -c touch% /tmp/pwned",
      "fd::3",
      "persistent-https::https://x/y.git",
    ];
    for (const spec of remote) expect(isRemoteGit(spec), spec).toBe(true);
    for (const spec of local) expect(isRemoteGit(spec), spec).toBe(false);
    const rules = [
      { from: "https://mirror.example/", to: "/srv/mirror/", push: false },
      { from: "https://push.example/", to: "file:///srv/push/", push: true },
      { from: "gh:", to: "https://github.com/", push: false },
      { from: "https://mirror.example/remote/", to: "https://git.example.com/", push: false },
    ];
    expect(isRemoteGit("https://mirror.example/team.git", rules)).toBe(false);
    // The longest prefix wins, as in git.
    expect(isRemoteGit("https://mirror.example/remote/team.git", rules)).toBe(true);
    expect(isRemoteGit("https://push.example/team.git", rules)).toBe(false);
    expect(isRemoteGit("gh:owner/repo", rules)).toBe(true);
    expect(rewriteUrl("gh:owner/repo", rules)).toBe("https://github.com/owner/repo");
  });

  it("CX8. the root manifest still names a repository on this machine", async () => {
    const m = machine();
    const local = remote(m, "private", skills("skills/", "private"));
    const manifest = m.manifest({
      agents: ["claude-code"],
      sources: [{ id: "mine", git: local.url }],
    });
    expect((await m.run("init", manifest, "--no-timer")).code).toBe(0);
    expect(names(m.at(".claude/skills"))).toEqual(["private"]);
  });
});

describe("CX9. index archives are capped before `skills` reads them", () => {
  it("CX9. an archive that unpacks past the limit is refused", async () => {
    const m = machine();
    const site = await http();
    const header = (name: string, size: number) => {
      const block = Buffer.alloc(512);
      block.write(name, 0);
      block.write("0000644\0", 100);
      block.write(`${size.toString(8).padStart(11, "0")}\0`, 124);
      block.write("0", 156);
      block.write("ustar\0", 257);
      block.write("00", 263);
      block.write("        ", 148);
      let sum = 0;
      for (const byte of block) sum += byte;
      block.write(`${sum.toString(8).padStart(6, "0")}\0 `, 148);
      return block;
    };
    const body = Buffer.from(skillMd("bomb"));
    const tar = Buffer.concat([
      header("SKILL.md", body.length),
      body,
      Buffer.alloc((512 - (body.length % 512)) % 512),
      // Zero blocks end a tar, and a gzip of them is tiny.
      Buffer.alloc(101 * 1024 * 1024),
    ]);
    const archive = gzipSync(tar, { level: 9 });
    expect(archive.length).toBeLessThan(200 * 1024);
    site.routes.set("/.well-known/agent-skills/bomb.tar.gz", {
      body: archive,
      type: "application/gzip",
    });
    site.routes.set("/.well-known/agent-skills/index.json", {
      body: JSON.stringify({
        $schema: "https://schemas.agentskills.io/discovery/0.2.0/schema.json",
        skills: [
          {
            name: "bomb",
            type: "archive",
            description: "The bomb skill",
            url: "bomb.tar.gz",
            digest: `sha256:${sha256(archive)}`,
          },
        ],
      }),
      type: "application/json",
    });
    const manifest = m.manifest({
      agents: ["claude-code"],
      sources: [{ id: "site", index: site.url }],
    });
    const run = await init(m, manifest);
    expect(names(m.at(".claude/skills"))).not.toContain("bomb");
    expect([...run.errors, ...run.warnings].join("\n")).toMatch(/100 MB/);
  }, 60_000);
});
