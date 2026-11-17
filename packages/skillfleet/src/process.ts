import { execFileSync } from "node:child_process";
import { readFileSync, readlinkSync } from "node:fs";
import { hostname, uptime } from "node:os";

/**
 * When the process `pid` started, in milliseconds since the epoch, as the OS recorded it; undefined
 * when the OS would not say. A pid is reused once its process is gone, so a process that started
 * after another one with its pid is not that one. This tells them apart without reading command
 * lines, which name the same script in many spellings (`bin\..\app\cli.mjs`, a relative path,
 * npm's shim, a link to the state folder).
 */
export function processStartedAt(pid: number): number | undefined {
  try {
    if (process.platform === "linux") return linuxStartedAt(pid);
    if (process.platform === "win32") return windowsStartedAt(pid);
    return psStartedAt(pid);
  } catch {
    return undefined;
  }
}

/**
 * Linux: field 22 of /proc/<pid>/stat is the start in clock ticks since boot, and `btime` in
 * /proc/stat the boot in seconds since the epoch. USER_HZ is 100 on every architecture Node.js runs on.
 */
function linuxStartedAt(pid: number): number | undefined {
  const ticks = startTicks(pid);
  const boot = Number(readFileSync("/proc/stat", "utf8").match(/^btime (\d+)$/m)?.[1]);
  return ticks !== undefined && boot > 0 ? boot * 1000 + ticks * 10 : undefined;
}

function startTicks(pid: number | "self"): number | undefined {
  const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
  // The command name in parentheses may hold spaces and parentheses itself.
  const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
  const ticks = Number(fields[19]);
  return Number.isInteger(ticks) ? ticks : undefined;
}

/**
 * Linux only: when the process `pid` (or this one) started, in clock ticks since boot. It never
 * moves, where a start in epoch time moves whenever the clock is set, so two reads of it compare
 * exactly; undefined elsewhere, or when /proc would not say.
 */
export function processStartTicks(pid: number | "self" = "self"): number | undefined {
  if (process.platform !== "linux") return undefined;
  try {
    return startTicks(pid);
  } catch {
    return undefined;
  }
}

/**
 * How long the process `pid` has run, in milliseconds. On Linux it counts from boot, so setting the
 * clock does not change it; elsewhere it is the OS's start time against the clock.
 */
export function processAge(pid: number): number | undefined {
  const ticks = processStartTicks(pid);
  if (ticks !== undefined) return uptime() * 1000 - ticks * 10;
  const started = processStartedAt(pid);
  return started === undefined ? undefined : Date.now() - started;
}

/**
 * Which machine, boot and process namespace this process runs in, for the sync lock: a pid means
 * something only in the namespace it came from, and two containers or two machines can share one
 * HOME (a bind mount, NFS). `boot` is Linux's boot id; elsewhere the boot time in seconds since
 * the epoch, as `t:<seconds>`, which `sameBoot` compares with some slack. `ns` is the pid namespace
 * on Linux. `uptime` counts milliseconds since boot, which setting the clock does not move on Linux
 * and Windows.
 */
export interface Whereabouts {
  host: string;
  boot: string;
  ns?: string;
  uptime: number;
}

export function whereabouts(): Whereabouts {
  const up = uptime() * 1000;
  let boot: string | undefined;
  let ns: string | undefined;
  if (process.platform === "linux") {
    try {
      boot = readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim() || undefined;
    } catch {}
    try {
      ns = readlinkSync("/proc/self/ns/pid");
    } catch {}
  }
  return {
    host: hostname(),
    boot: boot ?? `t:${Math.round((Date.now() - up) / 1000)}`,
    ...(ns ? { ns } : {}),
    uptime: Math.round(up),
  };
}

/** Whether two `Whereabouts.boot` values name one boot. A boot time read twice may differ by a second or two. */
export function sameBoot(a: string, b: string): boolean {
  if (!a.startsWith("t:") || !b.startsWith("t:")) return a === b;
  return Math.abs(Number(a.slice(2)) - Number(b.slice(2))) <= 120;
}

/**
 * macOS and other Unix systems: `ps -o etime=` is the time since the process started, as
 * `[[dd-]hh:]mm:ss`. It is whole seconds, so the start it gives is up to a second late.
 */
function psStartedAt(pid: number): number | undefined {
  const etime = execFileSync("ps", ["-o", "etime=", "-p", String(pid)], {
    encoding: "utf8",
    env: { ...process.env, LC_ALL: "C" },
    stdio: ["ignore", "pipe", "ignore"],
    timeout: 5000,
  }).trim();
  const match = /^(?:(?:(\d+)-)?(\d+):)?(\d+):(\d+)$/.exec(etime);
  if (!match) return undefined;
  const [days = 0, hours = 0, minutes = 0, seconds = 0] = match
    .slice(1)
    .map((part) => Number(part ?? 0));
  return Date.now() - (((days * 24 + hours) * 60 + minutes) * 60 + seconds) * 1000;
}

/**
 * Windows: Win32_Process's CreationDate, `yyyymmddHHMMSS.ffffff±UUU` (local time and its offset
 * from UTC in minutes), read as UTC here so a daylight saving change does not move it. WMI answers
 * for every process, where opening another user's process to read its start may be refused.
 * [wmisearcher] loads no module: Get-CimInstance would, and with a fresh profile PowerShell first
 * spends seconds indexing every module.
 */
function windowsStartedAt(pid: number): number | undefined {
  const created = execFileSync(
    "powershell.exe",
    [
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      `([wmisearcher]'SELECT CreationDate FROM Win32_Process WHERE ProcessId=${pid}').Get() | ForEach-Object { $_.CreationDate }`,
    ],
    { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 30_000, windowsHide: true },
  ).trim();
  return cimDate(created);
}

/** A CIM datetime, `yyyymmddHHMMSS.ffffff±UUU`, in milliseconds since the epoch. */
export function cimDate(text: string): number | undefined {
  const match = /^(\d{4})(\d\d)(\d\d)(\d\d)(\d\d)(\d\d)\.(\d{6})([+-])(\d{3})$/.exec(text);
  if (!match) return undefined;
  const [year, month, day, hour, minute, second, micro, sign, offset] = match.slice(1);
  const local = Date.UTC(+year!, +month! - 1, +day!, +hour!, +minute!, +second!, +micro! / 1000);
  return local - (sign === "-" ? -1 : 1) * Number(offset) * 60_000;
}
