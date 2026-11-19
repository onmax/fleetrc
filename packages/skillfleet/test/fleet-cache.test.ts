import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vite-plus/test";
import { exec } from "../src/exec.ts";
import { fleet, resolveFleet, type FleetAction } from "../src/fleet.ts";

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

it.each(["command-specific user", "matching explicit IP", "different explicit user"])(
  "attributes tagged reports to the actual SSH endpoint (%s)",
  async (scenario) => {
    const root = mkdtempSync(join(tmpdir(), "skillfleet-cache-"));
    vi.stubEnv("XDG_STATE_HOME", root);
    vi.stubEnv("SKILLFLEET_TAILSCALE", "tailscale");
    vi.stubEnv("SKILLFLEET_SSH", "ssh");
    const address = "100.64.0.5";
    const tag = "tag:servers";
    const first = "2026-01-01T00:00:00Z";
    const second = "2026-01-01T00:01:00Z";
    const differentCommand = scenario === "command-specific user";
    const differentUser = scenario === "different explicit user";
    let online = true;
    let time = first;
    vi.mocked(exec).mockImplementation(async (command, args) => {
      const [entry, remoteCommand] = args.slice(args.indexOf("--") + 1);
      const user =
        entry === `bob@${address}` || (differentCommand && remoteCommand?.includes("last-run.json"))
          ? "bob"
          : "alice";
      const stdout =
        command === "tailscale"
          ? JSON.stringify({
              BackendState: "Running",
              CurrentTailnet: { MagicDNSEnabled: false },
              Peer: { a: { ID: "a", Tags: [tag], TailscaleIPs: [address], Online: online } },
            })
          : args.includes("-G")
            ? `hostname ${address}\nuser ${user}\nport 22\n`
            : JSON.stringify({ finishedAt: time, ok: true, skills: 1, host: user });
      return { stdout, stderr: "", code: 0, timedOut: false, truncated: false };
    });
    const run = async (action: FleetAction, ...entries: string[]) => {
      const { targets } = await resolveFleet(entries, undefined, 30_000, {
        action,
        version: "0.0.0",
      });
      return fleet(targets, action, "0.0.0");
    };
    try {
      if (differentCommand) {
        expect(await run("sync", tag)).toMatchObject([
          { lastRun: { finishedAt: first, host: "alice" } },
        ]);
        time = second;
        expect(await run("status", address)).toMatchObject([
          { lastRun: { finishedAt: second, host: "bob" } },
        ]);
      } else {
        const host = differentUser ? `bob@${address}` : address;
        const results = await run("status", host, tag);
        expect(results).toMatchObject([{ host, lastRun: { finishedAt: first } }]);
        expect(results[0]?.via).toBeUndefined();
      }
      online = false;
      const results = await run("status", tag);
      expect(results).toMatchObject([{ host: address, error: "offline in Tailscale" }]);
      expect(results[0]?.lastRun).toEqual(
        differentUser ? undefined : expect.objectContaining({ finishedAt: first, host: "alice" }),
      );
    } finally {
      vi.unstubAllEnvs();
      rmSync(root, { recursive: true, force: true });
    }
  },
);
