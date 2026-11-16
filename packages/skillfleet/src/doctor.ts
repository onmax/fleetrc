import { existsSync, readdirSync, readFileSync } from "node:fs";
import { homedir, userInfo } from "node:os";
import { delimiter, dirname, join, sep } from "node:path";
import { agentTargets, codexLegacyDir } from "./agents.ts";
import { exec, git } from "./exec.ts";
import { lstat } from "./fs.ts";
import { gitUrl } from "./gitcache.ts";
import { linkTarget } from "./linker.ts";
import { loadManifest, type Source } from "./manifest.ts";
import { paths, tildify } from "./paths.ts";
import { installedCli, launcherNode, launcherPath } from "./selfinstall.ts";
import { manifestSpec } from "./sync.ts";
import { formatTimerStatus, TimerError, type TimerStatus, timerStatus } from "./timer.ts";

export interface Check {
  name: string;
  ok: boolean;
  detail: string;
}

function remoteOf(source: Source): string | undefined {
  if (source.kind === "git" || source.kind === "clone") return gitUrl(source.git);
  return undefined;
}

/** Names in `dir` that are skills, following links. */
function skillNames(dir: string): string[] {
  try {
    return readdirSync(dir).filter(
      (name) => !name.startsWith(".") && existsSync(join(dir, name, "SKILL.md")),
    );
  } catch {
    return [];
  }
}

async function nodeCheck(): Promise<Check> {
  const launcher = launcherPath();
  if (!existsSync(launcher))
    return {
      name: "node",
      ok: true,
      detail: `${process.execPath} (no installed copy yet; \`skillfleet timer install\` makes one)`,
    };
  const text = readFileSync(launcher, "utf8");
  const node = launcherNode(text);
  const ok = Boolean(node && existsSync(node)) && existsSync(installedCli());
  return {
    name: "node",
    ok,
    detail: ok
      ? `${tildify(launcher)} runs ${node}`
      : `${tildify(launcher)} points at ${node ?? "nothing"}, which is gone; run \`skillfleet timer install\` again`,
  };
}

async function lingerCheck(): Promise<Check | undefined> {
  if (process.platform !== "linux") return undefined;
  const run = await exec("loginctl", ["show-user", userInfo().username, "--property=Linger"], {
    timeoutMs: 5000,
  });
  if (run.spawnError === "ENOENT")
    return { name: "systemd linger", ok: true, detail: "loginctl is not installed; skipped" };
  // Without lingering and with no login session (cron, `sudo -u`, `docker exec`), loginctl knows
  // no such user: "User ID 1000 is not logged in or lingering".
  const unknownUser = /not logged in or lingering/.test(run.stderr);
  if (run.code !== 0 && !unknownUser)
    return {
      name: "systemd linger",
      ok: true,
      detail: `loginctl could not tell (${run.stderr.trim().split("\n")[0] || `exit ${run.code}`}); skipped`,
    };
  const ok = !unknownUser && run.stdout.trim() === "Linger=yes";
  return {
    name: "systemd linger",
    ok,
    detail: ok
      ? "on: the timer runs while you are logged out"
      : `off: the timer stops when you log out; run \`loginctl enable-linger ${userInfo().username}\``,
  };
}

/** Whether the OS scheduler has the timer, and how its last run ended. */
async function timerCheck(): Promise<Check> {
  const name = "timer";
  let status: TimerStatus;
  try {
    status = await timerStatus();
  } catch (error) {
    if (!(error instanceof TimerError)) throw error;
    return { name, ok: false, detail: error.message.split("\n")[0]! };
  }
  if (!status.installed) return { name, ok: false, detail: formatTimerStatus(status) };
  // One timer name per user: after a change of HOME or XDG_STATE_HOME, it may run another copy.
  const logs = paths.logs();
  if (status.logFile && !status.logFile.startsWith(logs + sep))
    return {
      name,
      ok: false,
      detail: `installed, but it syncs another skillfleet state folder (its log is ${tildify(status.logFile)}); run \`skillfleet timer install\` to point it at ${tildify(dirname(logs))}`,
    };
  const failed = status.lastExitCode !== undefined && status.lastExitCode !== 0;
  return {
    name,
    ok: !failed,
    detail: failed
      ? `the last run exited with ${status.lastExitCode}${status.logFile ? `; see ${status.logFile}` : ""}`
      : formatTimerStatus(status),
  };
}

async function launchdCheck(): Promise<Check | undefined> {
  if (process.platform !== "darwin") return undefined;
  const run = await exec("launchctl", ["getenv", "PATH"], { timeoutMs: 5000 });
  const path = run.stdout.trim() || "/usr/bin:/bin:/usr/sbin:/sbin";
  const dirs = path.split(delimiter);
  const missing = ["git"].filter((tool) => !dirs.some((dir) => existsSync(join(dir, tool))));
  return {
    name: "launchd PATH",
    ok: missing.length === 0,
    detail:
      missing.length === 0
        ? path
        : `launchd's PATH (${path}) has no ${missing.join(", ")}; the timer passes its own PATH, but hooks may need them`,
  };
}

export async function doctor(): Promise<Check[]> {
  const checks: Check[] = [];
  checks.push(await nodeCheck());
  const gitVersion = await git(["--version"], { allowFail: true });
  checks.push({
    name: "git",
    ok: gitVersion.code === 0,
    detail: gitVersion.code === 0 ? gitVersion.stdout.trim() : "git is not on PATH",
  });
  checks.push(await timerCheck());
  for (const check of [await lingerCheck(), await launchdCheck()]) if (check) checks.push(check);

  let spec: string;
  try {
    spec = manifestSpec();
  } catch (error) {
    checks.push({ name: "manifest", ok: false, detail: (error as Error).message });
    return checks;
  }
  const loaded = await loadManifest(spec, { offline: true }).catch((error: Error) => error);
  if (loaded instanceof Error) {
    checks.push({ name: "manifest", ok: false, detail: loaded.message });
    return checks;
  }
  checks.push({
    name: "manifest",
    ok: true,
    detail: `${tildify(loaded.root.file)}, ${loaded.sources.length} sources`,
  });
  // Without git, the git check above already says so once.
  const reachable = gitVersion.code === 0 ? loaded.sources : [];
  await Promise.all(
    reachable.map(async (source) => {
      const remote = remoteOf(source);
      if (!remote) return;
      const run = await git(["ls-remote", "--exit-code", "--", remote, "HEAD"], {
        allowFail: true,
        timeoutMs: 30_000,
      });
      checks.push({
        name: `git auth ${source.id}`,
        ok: run.code === 0,
        detail:
          run.code === 0 ? remote : `${remote}: ${(run.stderr || "no HEAD").trim().split("\n")[0]}`,
      });
    }),
  );

  // Codex reads both of its folders, so one name in both shows twice.
  const codexDirs = [join(homedir(), ".agents", "skills"), codexLegacyDir()];
  const [modern, legacy] = codexDirs.map(skillNames);
  const both = modern!.filter((name) => legacy!.includes(name));
  checks.push({
    name: "duplicate skills",
    ok: both.length === 0,
    detail:
      both.length === 0
        ? "no skill is in two folders one agent reads"
        : `Codex reads ${both.join(", ")} from both ${codexDirs.map(tildify).join(" and ")}; \`skillfleet init\` empties the second`,
  });
  // Agent folders should agree on where each name points.
  const targets = await agentTargets(loaded.root.agents);
  const pointsTo = new Map<string, Set<string>>();
  for (const target of targets) {
    const stat = lstat(target.dir);
    if (!stat || stat.isSymbolicLink()) continue;
    for (const name of skillNames(target.dir)) {
      const path = join(target.dir, name);
      const resolved = lstat(path)?.isSymbolicLink() ? linkTarget(path) : path;
      pointsTo.set(name, (pointsTo.get(name) ?? new Set()).add(resolved));
    }
  }
  const split = [...pointsTo].filter(([, dirs]) => dirs.size > 1).map(([name]) => name);
  checks.push({
    name: "agents agree",
    ok: split.length === 0,
    detail:
      split.length === 0
        ? `${targets.length} agent folders show the same skills`
        : `different copies of ${split.join(", ")} across agent folders`,
  });
  return checks;
}

export const formatChecks = (checks: readonly Check[]) =>
  checks.map((check) => `${check.ok ? "ok  " : "FAIL"} ${check.name}: ${check.detail}`).join("\n");
