import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

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
  const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
  // The command name in parentheses may hold spaces and parentheses itself.
  const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
  const ticks = Number(fields[19]);
  const boot = Number(readFileSync("/proc/stat", "utf8").match(/^btime (\d+)$/m)?.[1]);
  return Number.isFinite(ticks) && boot > 0 ? boot * 1000 + ticks * 10 : undefined;
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
