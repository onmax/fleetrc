import { createHash } from "node:crypto";
import { existsSync, mkdirSync, renameSync, rmSync } from "node:fs";
import { join, relative } from "node:path";
import { isRecord } from "./fs.ts";
import { extractStripped, readTgz } from "./tar.ts";

/** `@scope/name@1.2.3` → name and version or dist-tag (default `latest`). */
export function parseNpmSpec(spec: string): { name: string; want: string } {
  const at = spec.indexOf("@", spec.startsWith("@") ? 1 : 0);
  return at < 0
    ? { name: spec, want: "latest" }
    : { name: spec.slice(0, at), want: spec.slice(at + 1) || "latest" };
}

export const registryUrl = (registry: string | undefined) =>
  (
    registry ??
    process.env.npm_config_registry ??
    process.env.NPM_CONFIG_REGISTRY ??
    "https://registry.npmjs.org"
  ).replace(/\/$/, "");

function headers(sendToken: boolean): Record<string, string> {
  const token = process.env.NPM_TOKEN;
  return token && sendToken ? { authorization: `Bearer ${token}` } : {};
}

export const urlOrigin = (url: string) => {
  try {
    return new URL(url).origin;
  } catch {
    return undefined;
  }
};

/** npm package names: lowercase URL-safe characters, optionally under one `@scope/`. */
const PACKAGE_NAME = /^(?:@[a-z0-9~-][a-z0-9._~-]*\/)?[a-z0-9~-][a-z0-9._~-]*$/i;

/** One path segment that looks like a version: semver and the looser versions old registries hold. */
const VERSION = /^[0-9A-Za-z](?:[0-9A-Za-z.+_-]{0,126}[0-9A-Za-z])?$/;

/** Largest tarball skillfleet downloads, and the most it unpacks to. */
const TARBALL_LIMIT = 100 * 1024 * 1024;

async function readCapped(response: Response, label: string): Promise<Uint8Array> {
  const declared = Number(response.headers.get("content-length"));
  if (declared > TARBALL_LIMIT)
    throw new Error(`${label}: the tarball is too large (${declared} bytes)`);
  const chunks: Uint8Array[] = [];
  let size = 0;
  for await (const chunk of response.body ?? []) {
    size += chunk.byteLength;
    if (size > TARBALL_LIMIT) throw new Error(`${label}: the tarball is larger than 100 MB`);
    chunks.push(chunk);
  }
  return new Uint8Array(Buffer.concat(chunks));
}

function verify(bytes: Uint8Array, dist: Record<string, unknown>, label: string) {
  if (typeof dist.integrity === "string") {
    const [algorithm, expected] = dist.integrity.split(/-(.*)/s);
    if (algorithm && expected && ["sha512", "sha384", "sha256", "sha1"].includes(algorithm)) {
      const actual = createHash(algorithm).update(bytes).digest("base64");
      if (actual !== expected)
        throw new Error(`${label}: tarball integrity mismatch (${algorithm})`);
      return;
    }
  }
  if (typeof dist.shasum === "string") {
    if (createHash("sha1").update(bytes).digest("hex") !== dist.shasum)
      throw new Error(`${label}: tarball shasum mismatch`);
    return;
  }
  throw new Error(`${label}: the registry gave no integrity hash`);
}

/**
 * Downloads an npm package into `cacheRoot/<name>@<version>` and returns that folder.
 * `skills` has no npm source type; it discovers skills in the unpacked folder like any local path.
 */
export async function fetchNpm(
  spec: string,
  registry: string | undefined,
  cacheRoot: string,
  { sendToken = true }: { sendToken?: boolean } = {},
) {
  const { name, want } = parseNpmSpec(spec);
  if (!PACKAGE_NAME.test(name)) throw new Error(`npm "${name}" is not a package name`);
  const base = registryUrl(registry);
  const response = await fetch(`${base}/${name.replace("/", "%2f")}`, {
    headers: { accept: "application/json", ...headers(sendToken) },
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) throw new Error(`npm ${name}: registry answered ${response.status}`);
  const packument: unknown = await response.json();
  if (!isRecord(packument) || !isRecord(packument.versions))
    throw new Error(`npm ${name}: unexpected registry response`);
  const tags = isRecord(packument["dist-tags"]) ? packument["dist-tags"] : {};
  const tagged = tags[want];
  const version = typeof tagged === "string" ? tagged : want;
  const manifest = packument.versions[version];
  if (!isRecord(manifest) || !isRecord(manifest.dist) || typeof manifest.dist.tarball !== "string")
    throw new Error(`npm ${name}: no version or tag "${want}"`);
  if (!VERSION.test(version)) throw new Error(`npm ${name}: the registry gave an invalid version`);
  const dir = join(cacheRoot, `${name.replace("/", "+")}@${version}`);
  const inside = relative(cacheRoot, dir);
  if (!inside || inside.startsWith("..") || /[/\\]/.test(inside))
    throw new Error(`npm ${name}@${version}: the cache folder would be outside the cache`);
  if (existsSync(dir)) return { dir, version };
  const url = manifest.dist.tarball;
  // The token is for the registry; a packument can point the tarball at any host.
  const tarballOrigin = urlOrigin(url);
  const sameOrigin = tarballOrigin !== undefined && tarballOrigin === urlOrigin(base);
  const tarball = await fetch(url, {
    headers: headers(sendToken && sameOrigin),
    signal: AbortSignal.timeout(60_000),
  });
  if (!tarball.ok)
    throw new Error(`npm ${name}@${version}: tarball download answered ${tarball.status}`);
  const bytes = await readCapped(tarball, `npm ${name}@${version}`);
  verify(bytes, manifest.dist, `npm ${name}@${version}`);
  let files: Map<string, Uint8Array>;
  try {
    files = readTgz(bytes);
  } catch (error) {
    throw new Error(`npm ${name}@${version}: ${(error as Error).message}`);
  }
  const temp = `${dir}.${process.pid}.tmp`;
  rmSync(temp, { recursive: true, force: true });
  mkdirSync(temp, { recursive: true });
  extractStripped(files, temp);
  renameSync(temp, dir);
  return { dir, version };
}
