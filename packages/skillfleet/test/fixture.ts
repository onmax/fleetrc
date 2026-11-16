// Isolated machines for end-to-end tests: a temporary HOME with agent folders, git remotes made
// with real git, HTTP servers for well-known indexes and an npm registry, and the built CLI run
// as a subprocess against all of it.
import { execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { delimiter, dirname, join, resolve } from "node:path";
import { gzipSync } from "node:zlib";
import { afterAll } from "vite-plus/test";

const pkg = JSON.parse(readFileSync(resolve("package.json"), "utf8")) as {
  version: string;
  bin: { skillfleet: string };
};
export const version = pkg.version;
export const cli = resolve(pkg.bin.skillfleet);
export const isWindows = process.platform === "win32";

const made: string[] = [];
const servers: Server[] = [];
afterAll(async () => {
  for (const server of servers) await new Promise((done) => server.close(done));
  for (const dir of made) rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
});

export type Files = Record<string, string | Uint8Array>;

export function writeFiles(root: string, files: Files) {
  for (const [file, content] of Object.entries(files)) {
    const path = join(root, file);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, content);
  }
}

export const read = (path: string) => readFileSync(path, "utf8");

export const skillMd = (name: string, body = `${name} body`) =>
  `---\nname: ${name}\ndescription: The ${name} skill\n---\n${body}\n`;

/** `<prefix><name>/SKILL.md` for each name. */
export const skills = (prefix: string, ...names: string[]): Files =>
  Object.fromEntries(names.map((name) => [`${prefix}${name}/SKILL.md`, skillMd(name)]));

/** Agent config folders created in the temporary HOME, so `skills` detects these agents. */
export const AGENT_HOMES = [
  ".claude",
  ".codex",
  ".gemini",
  ".config/opencode",
  ".cursor",
  ".copilot",
];

/** The global skills folder of each detected agent, as `skills` 1.9 places them. */
export const AGENT_DIRS = [
  ".agents/skills",
  ".claude/skills",
  ".config/opencode/skills",
  ".copilot/skills",
  ".cursor/skills",
  ".gemini/skills",
];

export interface RunResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

export interface Machine {
  root: string;
  home: string;
  env: NodeJS.ProcessEnv;
  /** A path inside the temporary HOME. */
  at(...parts: string[]): string;
  run(...args: string[]): Promise<RunResult>;
  runWith(
    options: { input?: string; env?: NodeJS.ProcessEnv },
    ...args: string[]
  ): Promise<RunResult>;
  /** Runs the CLI with `--json` and parses the report. */
  json<T = Report>(...args: string[]): Promise<T>;
  git(cwd: string, ...args: string[]): string;
  manifest(content: object): string;
  stateDir: string;
}

export interface Report {
  ok: boolean;
  skills: { total: number; names: string[]; added: string[]; removed: string[]; updated: string[] };
  sources: {
    id: string;
    status: string;
    error?: string;
    changed: string[];
    from?: string;
    to?: string;
    held?: { reason: string; files: string[] };
  }[];
  shadowed: { skill: string; winner: string; loser: string }[];
  edited: { source: string; skill: string; files: string[] }[];
  held: { source: string; reason: string; files: string[] }[];
  pending: { source: string; skill: string; reason: string; files: string[] }[];
  targets: {
    dir: string;
    created: string[];
    removed: string[];
    foreign: string[];
    warnings: string[];
    skipped?: string;
  }[];
  hooks: { name: string; matched: string[]; code: number | null; output: string }[];
  warnings: string[];
  errors: string[];
}

function spawnAsync(
  command: string,
  args: string[],
  options: { cwd: string; env: NodeJS.ProcessEnv; input?: string },
) {
  return new Promise<RunResult>((done) => {
    const child = spawn(command, args, { cwd: options.cwd, env: options.env, windowsHide: true });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => (stdout += chunk));
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => (stderr += chunk));
    child.on("close", (code) => done({ code, stdout, stderr }));
    child.stdin.end(options.input ?? "");
  });
}

/** A fresh temporary machine. `agents: false` leaves out the agent folders. */
export function machine({ agents = true }: { agents?: boolean } = {}): Machine {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "skillfleet-e2e-")));
  made.push(root);
  const home = join(root, "home");
  mkdirSync(home, { recursive: true });
  if (agents) for (const dir of AGENT_HOMES) mkdirSync(join(home, dir), { recursive: true });
  const gitConfig = join(root, "gitconfig");
  writeFileSync(
    gitConfig,
    [
      "[user]\n\tname = skillfleet test\n\temail = test@example.com",
      "[init]\n\tdefaultBranch = main",
      "[commit]\n\tgpgsign = false",
      "[core]\n\tautocrlf = false\n\tsymlinks = true",
      '[protocol "file"]\n\tallow = always',
      "[advice]\n\tdetachedHead = false",
    ].join("\n") + "\n",
  );
  const env: NodeJS.ProcessEnv = {
    PATH: process.env.PATH,
    Path: process.env.Path,
    SystemRoot: process.env.SystemRoot,
    COMSPEC: process.env.COMSPEC,
    PATHEXT: process.env.PATHEXT,
    TEMP: process.env.TEMP,
    TMP: process.env.TMP,
    TMPDIR: process.env.TMPDIR,
    HOME: home,
    USERPROFILE: home,
    APPDATA: join(home, "AppData", "Roaming"),
    LOCALAPPDATA: join(home, "AppData", "Local"),
    XDG_CONFIG_HOME: join(home, ".config"),
    XDG_STATE_HOME: join(home, ".local", "state"),
    XDG_CACHE_HOME: join(home, ".cache"),
    XDG_DATA_HOME: join(home, ".local", "share"),
    CLAUDE_CONFIG_DIR: join(home, ".claude"),
    CODEX_HOME: join(home, ".codex"),
    GIT_CONFIG_GLOBAL: gitConfig,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CEILING_DIRECTORIES: root,
    DO_NOT_TRACK: "1",
    NO_COLOR: "1",
  };
  for (const key of Object.keys(env)) if (env[key] === undefined) delete env[key];
  const self: Machine = {
    root,
    home,
    env,
    stateDir: join(home, ".local", "state", "skillfleet"),
    at: (...parts) => join(home, ...parts),
    run: (...args) => self.runWith({}, ...args),
    runWith: (options, ...args) =>
      spawnAsync(process.execPath, [cli, ...args], {
        cwd: home,
        env: { ...env, ...options.env },
        input: options.input,
      }),
    async json<T>(...args: string[]) {
      const result = await self.run(...args, "--json");
      try {
        return JSON.parse(result.stdout) as T;
      } catch {
        throw new Error(
          `skillfleet ${args.join(" ")} --json printed no JSON (exit ${result.code}):\n${result.stdout}\n${result.stderr}`,
        );
      }
    },
    git: (cwd, ...args) =>
      execFileSync("git", args, {
        cwd,
        env,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      }).trim(),
    manifest(content) {
      const file = join(root, "manifest", "skills.json");
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, `${JSON.stringify(content, null, 2)}\n`);
      return file;
    },
  };
  return self;
}

export interface Remote {
  /** The bare repository: what sources point at. */
  url: string;
  /** A clone where tests make upstream commits. */
  work: string;
  /** Writes files (null deletes), commits and pushes. Returns the new commit. */
  commit(files: Record<string, string | null>, message?: string): string;
  head(): string;
}

/** A bare git remote with an initial commit of `files`. */
export function remote(m: Machine, name: string, files: Files): Remote {
  const url = join(m.root, "remotes", `${name}.git`);
  const work = join(m.root, "upstream", name);
  mkdirSync(url, { recursive: true });
  m.git(url, "init", "--quiet", "--bare");
  mkdirSync(work, { recursive: true });
  m.git(work, "init", "--quiet");
  writeFiles(work, files);
  m.git(work, "add", "-A");
  m.git(work, "commit", "--quiet", "-m", "init");
  m.git(work, "remote", "add", "origin", url);
  m.git(work, "push", "--quiet", "-u", "origin", "main");
  const self: Remote = {
    url,
    work,
    commit(changes, message = "change") {
      for (const [file, content] of Object.entries(changes)) {
        const path = join(work, file);
        if (content === null) rmSync(path, { recursive: true, force: true });
        else writeFiles(work, { [file]: content });
      }
      m.git(work, "add", "-A");
      m.git(work, "commit", "--quiet", "-m", message);
      m.git(work, "push", "--quiet", "origin", "main");
      return self.head();
    },
    head: () => m.git(work, "rev-parse", "HEAD"),
  };
  return self;
}

/** A working clone of `r` at `path` inside HOME, like `~/onmax/skills`. */
export function clone(m: Machine, r: Remote, path: string): string {
  const dir = m.at(path);
  mkdirSync(dirname(dir), { recursive: true });
  m.git(dirname(dir), "clone", "--quiet", r.url, dir);
  return dir;
}

// ---------------------------------------------------------------------------
// tar.gz archives, written by hand so tests can build unsafe ones too.

function tarHeader(name: string, size: number, type = "0"): Buffer {
  const header = Buffer.alloc(512);
  const put = (value: string, offset: number, length: number) =>
    header.write(value.slice(0, length), offset, length, "utf8");
  put(name, 0, 100);
  put("0000644\0", 100, 8);
  put("0000000\0", 108, 8);
  put("0000000\0", 116, 8);
  put(`${size.toString(8).padStart(11, "0")}\0`, 124, 12);
  put("00000000000\0", 136, 12);
  put("        ", 148, 8);
  put(type, 156, 1);
  put("ustar\0", 257, 6);
  put("00", 263, 2);
  let sum = 0;
  for (const byte of header) sum += byte;
  put(`${sum.toString(8).padStart(6, "0")}\0 `, 148, 8);
  return header;
}

export function tgz(files: Files): Buffer {
  const parts: Buffer[] = [];
  for (const [name, content] of Object.entries(files)) {
    const body = Buffer.from(content);
    parts.push(tarHeader(name, body.length), body, Buffer.alloc((512 - (body.length % 512)) % 512));
  }
  parts.push(Buffer.alloc(1024));
  return gzipSync(Buffer.concat(parts));
}

export const sha256 = (data: Uint8Array) => createHash("sha256").update(data).digest("hex");

// ---------------------------------------------------------------------------
// HTTP: a well-known skills index and an npm registry.

export interface Http {
  url: string;
  routes: Map<string, { body: Uint8Array | string; type: string }>;
  close(): Promise<void>;
}

export async function http(): Promise<Http> {
  const routes = new Map<string, { body: Uint8Array | string; type: string }>();
  const server = createServer((req, res) => {
    const route = routes.get(new URL(req.url ?? "/", "http://x").pathname);
    if (!route) {
      res.writeHead(404).end("not found");
      return;
    }
    res.writeHead(200, { "content-type": route.type }).end(route.body);
  });
  servers.push(server);
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("no port");
  return {
    url: `http://127.0.0.1:${address.port}`,
    routes,
    close: () => new Promise((done) => server.close(() => done())),
  };
}

export interface IndexSkill {
  name: string;
  files: Files;
  /** Serve bytes that do not match the digest in the index. */
  tamper?: boolean;
}

/** A v0.2.0 index of archive skills at `/.well-known/agent-skills/`, the way vite-hub/skills serves them. */
export function serveIndexV2(server: Http, list: IndexSkill[]) {
  const entries = list.map((skill) => {
    const archive = tgz(skill.files);
    const path = `/.well-known/agent-skills/${skill.name}.tar.gz`;
    server.routes.set(path, {
      body: skill.tamper
        ? tgz({ ...skill.files, "SKILL.md": `${String(skill.files["SKILL.md"])}\nevil\n` })
        : archive,
      type: "application/gzip",
    });
    return {
      name: skill.name,
      type: "archive",
      description: `The ${skill.name} skill`,
      url: `${skill.name}.tar.gz`,
      digest: `sha256:${sha256(archive)}`,
    };
  });
  server.routes.set("/.well-known/agent-skills/index.json", {
    body: JSON.stringify({
      $schema: "https://schemas.agentskills.io/discovery/0.2.0/schema.json",
      skills: entries,
    }),
    type: "application/json",
  });
}

/** A v0.1 index (file lists, no digests) at `/.well-known/skills/`. */
export function serveIndexV1(
  server: Http,
  list: { name: string; files: Record<string, string> }[],
) {
  for (const skill of list)
    for (const [file, content] of Object.entries(skill.files))
      server.routes.set(`/.well-known/skills/${skill.name}/${file}`, {
        body: content,
        type: "text/plain",
      });
  server.routes.set("/.well-known/skills/index.json", {
    body: JSON.stringify({
      skills: list.map((skill) => ({
        name: skill.name,
        description: `The ${skill.name} skill`,
        files: Object.keys(skill.files),
      })),
    }),
    type: "application/json",
  });
}

/** Publishes `name@version` with these files (under `package/`) to a fake registry. */
export function publishNpm(
  server: Http,
  name: string,
  versions: Record<string, Files>,
  latest: string,
) {
  const packument = { name, "dist-tags": { latest }, versions: {} as Record<string, unknown> };
  for (const [version, files] of Object.entries(versions)) {
    const tarball = tgz(
      Object.fromEntries(
        Object.entries({ "package.json": JSON.stringify({ name, version }), ...files }).map(
          ([file, content]) => [`package/${file}`, content],
        ),
      ),
    );
    const path = `/${name.replace("/", "-")}-${version}.tgz`;
    server.routes.set(path, { body: tarball, type: "application/octet-stream" });
    packument.versions[version] = {
      name,
      version,
      dist: {
        tarball: `${server.url}${path}`,
        integrity: `sha512-${createHash("sha512").update(tarball).digest("base64")}`,
      },
    };
  }
  server.routes.set(`/${name.replace("/", "%2f")}`, {
    body: JSON.stringify(packument),
    type: "application/json",
  });
  server.routes.set(`/${name}`, { body: JSON.stringify(packument), type: "application/json" });
}

// ---------------------------------------------------------------------------
// Looking at agent folders.

export function isLink(path: string): boolean {
  return lstatSync(path, { throwIfNoEntry: false })?.isSymbolicLink() ?? false;
}

/** Where a link points, resolved. */
export function linkOf(path: string): string {
  return realpathSync(resolve(dirname(path), readlinkSync(path).replace(/^\\\\\?\\/, "")));
}

/** Skill names in a folder, without dotfiles. */
export function names(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((name) => !name.startsWith("."))
    .sort();
}

export const pathWith = (dir: string, env: NodeJS.ProcessEnv) =>
  [dir, env.PATH ?? env.Path ?? ""].join(delimiter);
