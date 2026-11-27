import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { create } from "tar";
import { expect, it, onTestFinished } from "vite-plus/test";
import { fetchNpm } from "../src/npm.ts";

function registry(root: string, base: string, value: string, rejectedStatus?: number) {
  const tarball = join(root, "package.tgz");
  mkdirSync(join(root, "package"), { recursive: true });
  writeFileSync(join(root, "package", "value.txt"), value);
  create({ cwd: root, file: tarball, gzip: true, sync: true }, ["package"]);
  const bytes = new Uint8Array(readFileSync(tarball));
  const integrity = `sha512-${createHash("sha512").update(bytes).digest("base64")}`;
  const requests: string[] = [];
  const fetch: typeof globalThis.fetch = async (input, init) => {
    if (input === `${base}/package.tgz`) return new Response(bytes);
    if (input !== `${base}/pkg`) return new Response(null, { status: 404 });
    const accept = new Headers(init?.headers).get("accept") ?? "";
    requests.push(accept);
    if (rejectedStatus !== undefined && accept !== "application/json")
      return new Response("no packument", { status: rejectedStatus });
    return Response.json({
      "dist-tags": { latest: "1.0.0" },
      versions: { "1.0.0": { dist: { tarball: `${base}/package.tgz`, integrity } } },
    });
  };
  return { requests, fetch };
}

it("isolates npm caches by registry path and ignores unscoped entries", async () => {
  const root = mkdtempSync(join(tmpdir(), "fleetrc-npm-"));
  onTestFinished(() => rmSync(root, { recursive: true, force: true }));
  const cache = join(root, "cache");
  const legacy = join(cache, "pkg@1.0.0");
  mkdirSync(legacy, { recursive: true });
  writeFileSync(join(legacy, "value.txt"), "legacy");

  const base = "https://registry.example";
  const firstRegistry = registry(root, base, "first");
  const first = await fetchNpm("pkg@1.0.0", base, cache, firstRegistry);
  const other = `${base}/other`;
  await expect
    .soft(fetchNpm("pkg@1.0.0", other, cache, firstRegistry))
    .rejects.toThrow("answered 404");
  expect.soft(readFileSync(join(first.dir, "value.txt"), "utf8")).toBe("first");

  const secondRegistry = registry(root, other, "second");
  const second = await fetchNpm("pkg@latest", other, cache, secondRegistry);
  expect(readFileSync(join(second.dir, "value.txt"), "utf8")).toBe("second");
  expect(readFileSync(join(first.dir, "value.txt"), "utf8")).toBe("first");
  const warm = await fetchNpm("pkg@1.0.0", `${other}/`, cache, {
    fetch: async () => {
      throw new Error("a warm pin should not fetch");
    },
  });
  expect(warm).toEqual(second);
});

it.each([406, 404])("retries a packument HTTP %i with plain JSON", async (status) => {
  const root = mkdtempSync(join(tmpdir(), "fleetrc-npm-"));
  onTestFinished(() => rmSync(root, { recursive: true, force: true }));
  const base = "https://registry.example";
  const server = registry(root, base, "package", status);
  const pkg = await fetchNpm("pkg", base, join(root, "cache"), server);
  expect(server.requests).toEqual([
    expect.stringContaining("application/vnd.npm.install-v1+json"),
    "application/json",
  ]);
  expect(readFileSync(join(pkg.dir, "value.txt"), "utf8")).toBe("package");
});
