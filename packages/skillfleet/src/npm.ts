import { createHash } from "node:crypto";
import { existsSync, mkdirSync, renameSync, rmSync } from "node:fs";
import { join } from "node:path";
import { isRecord } from "./fs.ts";
import { extractStripped, readTgz } from "./tar.ts";

/** `@scope/name@1.2.3` → name and version or dist-tag (default `latest`). */
export function parseNpmSpec(spec: string): { name: string; want: string } {
  const at = spec.indexOf("@", spec.startsWith("@") ? 1 : 0);
  return at < 0
    ? { name: spec, want: "latest" }
    : { name: spec.slice(0, at), want: spec.slice(at + 1) || "latest" };
}

const registryUrl = (registry: string | undefined) =>
  (
    registry ??
    process.env.npm_config_registry ??
    process.env.NPM_CONFIG_REGISTRY ??
    "https://registry.npmjs.org"
  ).replace(/\/$/, "");

function headers(): Record<string, string> {
  const token = process.env.NPM_TOKEN;
  return token ? { authorization: `Bearer ${token}` } : {};
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
export async function fetchNpm(spec: string, registry: string | undefined, cacheRoot: string) {
  const { name, want } = parseNpmSpec(spec);
  const base = registryUrl(registry);
  const response = await fetch(`${base}/${name.replace("/", "%2f")}`, {
    headers: { accept: "application/json", ...headers() },
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
  const dir = join(cacheRoot, `${name.replace("/", "+")}@${version}`);
  if (existsSync(dir)) return { dir, version };
  const tarball = await fetch(manifest.dist.tarball, {
    headers: headers(),
    signal: AbortSignal.timeout(60_000),
  });
  if (!tarball.ok)
    throw new Error(`npm ${name}@${version}: tarball download answered ${tarball.status}`);
  const bytes = new Uint8Array(await tarball.arrayBuffer());
  verify(bytes, manifest.dist, `npm ${name}@${version}`);
  const temp = `${dir}.${process.pid}.tmp`;
  rmSync(temp, { recursive: true, force: true });
  mkdirSync(temp, { recursive: true });
  extractStripped(readTgz(bytes), temp);
  renameSync(temp, dir);
  return { dir, version };
}
