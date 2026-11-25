import { join } from "node:path";
import { exec } from "./exec.ts";
import { isRecord } from "./fs.ts";
import { notInstalled, program } from "./program.ts";
import { LEGACY_CAPABILITY, legacyWarning } from "./legacy.ts";

/** The capability a tailnet policy's `nodeAttrs` grants to hand machines the manifest's location. */
export const TAILSCALE_CAPABILITY = "github.com/onmax/fleetrc";

const MAC_APP_CLI = "/Tailscale.app/Contents/MacOS/Tailscale";

/**
 * Where Tailscale's installers put its CLI, tried when `tailscale` is not on PATH. The macOS app
 * never puts its CLI on PATH, and over SSH a Mac's PATH has no Homebrew folder either.
 */
export function tailscaleFallbacks(platform = process.platform, env = process.env): string[] {
  if (platform === "darwin")
    return [
      "/opt/homebrew/bin/tailscale",
      "/usr/local/bin/tailscale",
      `/Applications${MAC_APP_CLI}`,
    ];
  if (platform === "win32")
    return [join(env.ProgramFiles ?? "C:\\Program Files", "Tailscale", "tailscale.exe")];
  return [];
}

/** `tailscale status --json` with `args`, parsed, or why Tailscale could not answer. */
export async function tailscaleStatus(
  args: readonly string[],
  timeoutMs: number,
  fallbacks = tailscaleFallbacks(),
): Promise<{ status: Record<string, unknown> } | { error: string }> {
  const override = "FLEETRC_TAILSCALE";
  const useFallbacks = !process.env[override];
  const { command, prefix } = program(override, "tailscale");
  const statusArgs = ["status", "--json", ...args];
  const options = { timeoutMs, maxOutput: 64 * 1024 * 1024 };
  let run = await exec(command, [...prefix, ...statusArgs], options);
  if (run.spawnError === "ENOENT" && useFallbacks) {
    for (const file of fallbacks) {
      const env = file.endsWith(MAC_APP_CLI)
        ? { ...process.env, TAILSCALE_BE_CLI: "1" }
        : undefined;
      const candidate = await exec(file, statusArgs, { ...options, env });
      if (!candidate.spawnError || candidate.timedOut) {
        run = candidate;
        break;
      }
      if (run.spawnError === "ENOENT" && candidate.spawnError !== "ENOENT") run = candidate;
    }
  }
  if (run.spawnError === "ENOENT") return { error: notInstalled(command, "tailscale", override) };
  if (run.timedOut)
    return { error: `\`tailscale status\` did not answer within ${timeoutMs / 1000} s` };
  if (run.code !== 0) {
    const said = run.stderr.trim().split("\n")[0] || `exit ${run.code}`;
    return { error: `\`tailscale status\` failed: ${said}` };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(run.stdout);
  } catch {
    return { error: "`tailscale status --json` printed something that is not JSON" };
  }
  if (!isRecord(parsed)) return { error: "`tailscale status --json` printed no status" };
  if (parsed.BackendState === "NeedsLogin" || parsed.BackendState === "NoState")
    return { error: "Tailscale is not logged in; run `tailscale up`" };
  if (parsed.BackendState === "Stopped")
    return { error: "Tailscale is stopped; run `tailscale up`" };
  return { status: parsed };
}

/**
 * The manifest the tailnet policy names for this machine, from
 * `"nodeAttrs": [{ "target": [...], "app": { "github.com/onmax/fleetrc": [{ "manifest": "<spec>" }] } }]`,
 * or why there is none.
 */
export async function tailscaleManifest(
  timeoutMs = 5_000,
): Promise<{ manifest: string } | { error: string }> {
  const found = await tailscaleStatus(["--peers=false"], timeoutMs);
  if ("error" in found) return found;
  const self = isRecord(found.status.Self) ? found.status.Self : {};
  const capMap = isRecord(self.CapMap) ? self.CapMap : {};
  let values = capMap[TAILSCALE_CAPABILITY];
  if (values === undefined && capMap[LEGACY_CAPABILITY] !== undefined) {
    values = capMap[LEGACY_CAPABILITY];
    legacyWarning(
      `the tailnet policy names the manifest under "${LEGACY_CAPABILITY}"; rename that capability to "${TAILSCALE_CAPABILITY}" before the next release stops reading it`,
    );
  }
  const manifest = Array.isArray(values)
    ? values.find((value) => isRecord(value) && typeof value.manifest === "string")?.manifest
    : undefined;
  if (typeof manifest === "string" && manifest.trim() !== "") return { manifest: manifest.trim() };
  return {
    error: `the tailnet policy gives this machine no manifest; add "nodeAttrs": [{ "target": ["*"], "app": { "${TAILSCALE_CAPABILITY}": [{ "manifest": "<owner/repo>" }] } }] to it`,
  };
}
