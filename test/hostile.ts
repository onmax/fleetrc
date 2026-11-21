// Builders for hostile inputs: tarballs with links, devices and odd paths, an HTTP server that
// records what reaches it, and small helpers the adversarial tests share.
import { createHash } from "node:crypto";
import { createServer, type IncomingHttpHeaders, type Server } from "node:http";
import { gzipSync } from "node:zlib";
import { afterAll } from "vite-plus/test";

const servers: Server[] = [];
afterAll(async () => {
  for (const server of servers) await new Promise((done) => server.close(done));
});

export interface TarEntry {
  name: string;
  body?: string | Uint8Array;
  /** `0` file, `1` hard link, `2` symlink, `3` char device, `4` block device, `5` folder. */
  type?: string;
  linkname?: string;
}

function header(entry: TarEntry, size: number): Buffer {
  const out = Buffer.alloc(512);
  const put = (value: string, offset: number, length: number) =>
    out.write(value.slice(0, length), offset, length, "utf8");
  put(entry.name, 0, 100);
  put(entry.type === "5" ? "0000755\0" : "0000644\0", 100, 8);
  put("0000000\0", 108, 8);
  put("0000000\0", 116, 8);
  put(`${size.toString(8).padStart(11, "0")}\0`, 124, 12);
  put("00000000000\0", 136, 12);
  put("        ", 148, 8);
  put(entry.type ?? "0", 156, 1);
  if (entry.linkname) put(entry.linkname, 157, 100);
  put("ustar\0", 257, 6);
  put("00", 263, 2);
  let sum = 0;
  for (const byte of out) sum += byte;
  put(`${sum.toString(8).padStart(6, "0")}\0 `, 148, 8);
  return out;
}

/** The 512-byte header of a regular file, for archives built in pieces. */
export const tarHeaderFor = (name: string, size: number) => header({ name }, size);

/** A .tar.gz of these entries in order; links and devices carry no body. */
export function tarball(entries: TarEntry[]): Buffer {
  const parts: Buffer[] = [];
  for (const entry of entries) {
    const body = Buffer.from(entry.body ?? "");
    const size = entry.type && entry.type !== "0" ? 0 : body.length;
    parts.push(header(entry, size));
    if (size > 0) parts.push(body, Buffer.alloc((512 - (size % 512)) % 512));
  }
  parts.push(Buffer.alloc(1024));
  return gzipSync(Buffer.concat(parts));
}

export const sha512 = (data: Uint8Array) =>
  `sha512-${createHash("sha512").update(data).digest("base64")}`;

export interface Hit {
  method: string;
  path: string;
  headers: IncomingHttpHeaders;
}

export interface Recorder {
  url: string;
  hits: Hit[];
  routes: Map<string, { body: Uint8Array | string; type: string }>;
}

/** An HTTP server on 127.0.0.1 that serves `routes` and records every request with its headers. */
export async function recorder(): Promise<Recorder> {
  const hits: Hit[] = [];
  const routes = new Map<string, { body: Uint8Array | string; type: string }>();
  const server = createServer((req, res) => {
    const path = new URL(req.url ?? "/", "http://x").pathname;
    hits.push({ method: req.method ?? "GET", path, headers: req.headers });
    const route = routes.get(path);
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
  return { url: `http://127.0.0.1:${address.port}`, hits, routes };
}

/** Serves a packument for `name` whose versions point at the given tarballs. */
export function servePackument(
  server: Recorder,
  name: string,
  versions: Record<string, { tarball: string; integrity?: string; shasum?: string }>,
  latest: string,
) {
  const packument = {
    name,
    "dist-tags": { latest },
    versions: Object.fromEntries(
      Object.entries(versions).map(([version, dist]) => [version, { name, version, dist }]),
    ),
  };
  server.routes.set(`/${name.replace("/", "%2f")}`, {
    body: JSON.stringify(packument),
    type: "application/json",
  });
  server.routes.set(`/${name}`, { body: JSON.stringify(packument), type: "application/json" });
}

/** Serves one archive skill in a v0.2.0 index with a caller-chosen index entry. */
export function serveArchiveIndex(
  server: Recorder,
  skills: { name: string; archive: Uint8Array; entry?: Record<string, unknown> }[],
) {
  const entries = skills.map((skill) => {
    server.routes.set(`/.well-known/agent-skills/${skill.name}.tar.gz`, {
      body: skill.archive,
      type: "application/gzip",
    });
    return {
      name: skill.name,
      type: "archive",
      description: `The ${skill.name} skill`,
      url: `${skill.name}.tar.gz`,
      digest: `sha256:${createHash("sha256").update(skill.archive).digest("hex")}`,
      ...skill.entry,
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
