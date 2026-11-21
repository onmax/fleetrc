import { exec } from "./exec.ts";
import { isRecord } from "./fs.ts";
import { notInstalled, program } from "./program.ts";

/** The capability a tailnet policy's `nodeAttrs` grants to hand machines the manifest's location. */
export const TAILSCALE_CAPABILITY = "github.com/onmax/fleetrc";

/** `tailscale status --json` with `args`, parsed, or why Tailscale could not answer. */
export async function tailscaleStatus(
  args: readonly string[],
  timeoutMs: number,
): Promise<{ status: Record<string, unknown> } | { error: string }> {
  const { command, prefix } = program("FLEETRC_TAILSCALE", "tailscale");
  const run = await exec(command, [...prefix, "status", "--json", ...args], {
    timeoutMs,
    maxOutput: 64 * 1024 * 1024,
  });
  if (run.spawnError === "ENOENT")
    return { error: notInstalled(command, "tailscale", "FLEETRC_TAILSCALE") };
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
  const values = isRecord(self.CapMap) ? self.CapMap[TAILSCALE_CAPABILITY] : undefined;
  const manifest = Array.isArray(values)
    ? values.find((value) => isRecord(value) && typeof value.manifest === "string")?.manifest
    : undefined;
  if (typeof manifest === "string" && manifest.trim() !== "") return { manifest: manifest.trim() };
  return {
    error: `the tailnet policy gives this machine no manifest; add "nodeAttrs": [{ "target": ["*"], "app": { "${TAILSCALE_CAPABILITY}": [{ "manifest": "<owner/repo>" }] } }] to it`,
  };
}
