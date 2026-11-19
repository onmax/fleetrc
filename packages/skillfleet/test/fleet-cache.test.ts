import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vite-plus/test";
import { exec } from "../src/exec.ts";
import { fleet, resolveFleet } from "../src/fleet.ts";

vi.mock("../src/exec.ts", () => ({ exec: vi.fn() }));

it.each([true, false])(
  "refreshes offline reports only for the same peer and endpoint (reassigned: %s)",
  async (reassigned) => {
    const root = mkdtempSync(join(tmpdir(), "skillfleet-cache-"));
    vi.stubEnv("XDG_STATE_HOME", root);
    vi.stubEnv("SKILLFLEET_TAILSCALE", "tailscale");
    vi.stubEnv("SKILLFLEET_SSH", "ssh");
    const times = ["2026-01-01T00:00:00Z", "2026-01-01T00:01:00Z", "2026-01-01T00:02:00Z"];
    const address = "100.64.0.5";
    const name = "old.tail.test";
    const peer = {
      ID: "a",
      DNSName: `${name}.`,
      TailscaleIPs: [address],
      Tags: ["tag:servers"],
      Online: true,
    };
    const offline = { ...peer, DNSName: "new.tail.test.", Online: false };
    let peers = { a: peer, b: undefined as typeof peer | undefined };
    let user = "alice";
    let time = times[0];
    vi.mocked(exec).mockImplementation(async (command, args) => {
      const stdout =
        command === "tailscale"
          ? JSON.stringify({ BackendState: "Running", Peer: peers })
          : args.includes("-G")
            ? `hostname ${args[args.indexOf("--") + 1]}\nuser ${user}\nport 22\n`
            : JSON.stringify({ finishedAt: time, ok: true, skills: 1 });
      return { stdout, stderr: "", code: 0, timedOut: false, truncated: false };
    });
    const status = async (host: string) => {
      const { targets } = await resolveFleet([host], async (hostname) =>
        hostname === name ? [address] : [],
      );
      return fleet(targets, "status", "0.0.0");
    };
    try {
      expect(await status("tag:servers")).toMatchObject([
        { host: name, lastRun: { finishedAt: times[0] } },
      ]);
      if (reassigned)
        peers = {
          a: { ...offline, TailscaleIPs: ["100.64.0.6"] },
          b: { ...peer, ID: "b", Tags: [] },
        };
      time = times[1];
      expect(await status(name)).toMatchObject([{ lastRun: { finishedAt: times[1] } }]);
      if (!reassigned) {
        user = "bob";
        time = times[2];
        expect(await status(name)).toMatchObject([{ lastRun: { finishedAt: times[2] } }]);
        peers = { a: offline, b: undefined };
      }
      expect(await status("tag:servers")).toMatchObject([
        {
          host: "new.tail.test",
          error: "offline in Tailscale",
          lastRun: { finishedAt: times[reassigned ? 0 : 1] },
        },
      ]);
    } finally {
      vi.unstubAllEnvs();
      rmSync(root, { recursive: true, force: true });
    }
  },
);
