<h1>
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="https://raw.githubusercontent.com/onmax/fleetrc/main/.github/assets/banner-dark.svg">
    <source media="(prefers-color-scheme: light)" srcset="https://raw.githubusercontent.com/onmax/fleetrc/main/.github/assets/banner-light.svg">
    <img src="https://raw.githubusercontent.com/onmax/fleetrc/main/.github/assets/banner-light.png" alt="fleetrc: the same skills on every agent and every machine, synced when an agent session starts" width="100%">
  </picture>
</h1>

[![npm version](https://comark-ui.onmax.me/badge.svg?source=npm-version&package=fleetrc&icon=npm)](https://www.npmjs.com/package/fleetrc)
[![npm downloads](https://comark-ui.onmax.me/badge.svg?source=npm-downloads&package=fleetrc&period=month&icon=npm)](https://www.npmjs.com/package/fleetrc)
[![Release status](https://comark-ui.onmax.me/badge.svg?source=github-actions&repository=onmax%2Ffleetrc&workflow=release.yaml&icon=github)](https://github.com/onmax/fleetrc/actions/workflows/release.yaml)
[![status: early](https://comark-ui.onmax.me/badge.svg?label=status&value=early)](#status)
[![license: MIT](https://comark-ui.onmax.me/badge.svg?label=license&value=MIT)](https://github.com/onmax/fleetrc/blob/main/LICENSE)

One config for your agent skills across Claude Code, Codex, Gemini CLI, OpenCode, Cursor and GitHub Copilot, synced on every machine when an agent session starts. It also syncs user-level instruction files, subagents, commands, MCP servers and agent hooks.

## Set up with your agent

Paste this into Claude Code, Codex or another agent:

```md
Set up fleetrc on this machine by following https://raw.githubusercontent.com/onmax/fleetrc/main/docs/agent-setup.md
```

The agent looks at your current setup, asks you what it can't find out, and shows you what will go into Git and what will change on this machine before it does anything. The [setup guide](./docs/agent-setup.md) has every step it follows.

[Watch or download the explainer (MP4)](.github/assets/explainer.mp4)

https://github.com/user-attachments/assets/d51e096f-9e02-49c3-85d4-9986b0aa1169

- **One copy per skill.** fleetrc fetches `git`, `npm`, `index` and `local` sources and links each skill into every installed agent's folder.
- **Session-start syncs.** `init` installs `SessionStart` hooks in Claude Code and Codex that start a background sync when none has been tried in the last 15 minutes. Servers without an agent use `--timer`.
- **Safe edits and reviews.** Upstream changes wait for `diff` and `merge` when you edit a skill locally. `"update": "review"` holds later changes until you run `fleetrc update`; the first fetch links skills immediately, so review third-party sources before adding them.
- **Shared team configs.** `"extends"` inherits sources from a team repo while ignoring `hooks`, `report`, `fleet`, `path`, `local`, `mcp` and `agentHooks`, so a team config cannot run commands on your machine.

## Install

Requires Node.js 22.12 or newer, plus `git` for git sources.

```sh
npx fleetrc init my-team/agents
```

The argument can be a repository like `owner/repo`, `github:owner/repo`, `gitlab:group/repo` or a `.git` URL, which fleetrc reads for `.fleetrc/manifest.json`. It can also be a file in a repository like `github:my-team/agents//team.json`, or a local file or folder such as `init .`.

`init` copies fleetrc into `~/.local/state/fleetrc`, or `%LOCALAPPDATA%\fleetrc` on Windows, links `fleetrc` into `~/.local/bin` when it is on `PATH`, migrates existing skills, and installs the session hooks. Pass `--dry-run` first to preview the migration. In Codex, open `/hooks` once to approve the hook.

## Quick start

### Write your config

Your config is `.fleetrc/manifest.json` in a git repository, usually the one that holds your own skills:

```json
{
  "$schema": "https://unpkg.com/fleetrc/schema.json",
  "extends": ["my-team/agents"],
  "sources": [
    {
      "id": "mine",
      "git": "me/skills",
      "path": "~/code/skills",
      "skills": "skills/*",
      "adopt": true
    },
    { "id": "nuxt", "git": "onmax/nuxt-skills", "include": ["nuxt", "nuxt-ui"] },
    { "id": "ag-grid", "git": "ag-grid/skills", "update": "review" }
  ],
  "fleet": ["laptop", "tag:servers"]
}
```

Then run `npx fleetrc init me/skills` on each machine. When two sources have a skill with the same name, the first one wins, and your `sources` come before the ones from `extends`.

### Add a machine

From a machine that is already set up, initialize another over SSH and add it to `fleet`:

```sh
fleetrc fleet init vps2          # or tag:servers on Tailscale; add --timer for a headless server
```

If fleetrc prints an entry to add instead of editing a working clone, add it to `fleet` in the manifest. Commit and push any enrollment change, then refresh the manifest on the controller before syncing the fleet:

```sh
fleetrc sync
fleetrc fleet sync
```

The config must live in a git repository, and the remote host needs Node.js 22.12 or newer.

### Take the config from your tailnet

On Tailscale, set the config once in your tailnet policy's `nodeAttrs`:

```jsonc
"nodeAttrs": [
  { "target": ["*"], "app": { "github.com/onmax/fleetrc": [{ "manifest": "me/skills" }] } }
]
```

Then run `npx fleetrc init` on a fresh machine or one already following the policy. To switch an existing machine from its own manifest, run `npx fleetrc init tailscale:`; bare `init` keeps its current manifest. Only follow a tailnet policy whose editors you trust, because the root config can run local commands through `hooks`, `report`, `mcp` and `agentHooks`.

## Commands

Run `fleetrc <command> --help` for full options. Most commands accept `--dry-run`, `--json`, `--offline`, `--copy`, `--no-copy` and `--manifest <m>`.

| Command                                            | What it does                                                                                                                                      |
| -------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| `sync [source]`                                    | Fetch all sources, or only `source`, and link skills. Plain `fleetrc` runs this.                                                                  |
| `init [manifest]`                                  | Point this machine at a config, migrate folders, sync, and install the CLI and session hooks. Accepts `--no-hooks`, `--timer`, `--force`.         |
| `status`                                           | Show the last run, held or pending updates, edited skills and sessions to restart.                                                                |
| `list`                                             | List linked skills, files and config entries. `list --json` reads local state only, with no network.                                              |
| `agents`                                           | List every agent id, which ones are installed here, and where each reads skills and files.                                                        |
| `doctor`                                           | Check Node.js, git access, session hooks or timer, and duplicate skills.                                                                          |
| `add <source>`                                     | Add `owner/repo`, a git or index URL, `npm:<package>` or a local path and sync. Accepts `--id`, `--skills`, `--include`, `--exclude`, `--review`. |
| `remove <source\|skill>`                           | Remove a source, or exclude a skill from its source or `extends` entry.                                                                           |
| `adopt <path>`                                     | Move a hand-made skill folder into your `"adopt": true` working clone.                                                                            |
| `fork <skill>`                                     | Copy a git source's skill into your personal repo and record it under `forks`.                                                                    |
| `diff [skill]`                                     | Show held updates, local edits, or an MCP server diff with `mcp/<agent>/<server>`.                                                                |
| `merge <skill>`                                    | Merge an upstream update into an edited skill or a fork.                                                                                          |
| `update <source>`                                  | Apply updates held by an `"update": "review"` source.                                                                                             |
| `timer install\|remove\|status`                    | Install, remove or check the scheduled sync timer.                                                                                                |
| `fleet sync\|status\|upgrade\|init\|add [host...]` | Sync, inspect, upgrade or set up SSH hosts and Tailscale `tag:<name>` peers. Accepts `--timeout <s>`.                                             |
| `hook install\|remove [agent]`                     | Add or remove session-start hooks for `claude-code` or `codex`.                                                                                   |
| `self-install`                                     | Copy this fleetrc into the state folder. `init` and `fleet upgrade` run it.                                                                       |

## Config reference

See [`schema.json`](./schema.json) for every field, type and constraint.

| Field                                               | Purpose                                                                                                                                                                                                                                                                        |
| --------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `extends`                                           | Team manifests to inherit sources from. Use `{ "manifest": "...", "exclude": [...], "excludeSources": [...] }` to drop items.                                                                                                                                                  |
| `agents`                                            | `"all"` by default for every installed agent, or a list of ids from `fleetrc agents`.                                                                                                                                                                                          |
| `sources[]`                                         | `git` (with `ref`, `path`, `adopt`, `followLinks`), `index` (`/.well-known/agent-skills/index.json` or v0.1), `npm` (with `registry`), or `local`. Common fields: `id`, `skills`, `include`, `exclude`, `update` (`"auto"` or `"review"`).                                     |
| `sources[].instructions`, `subagents`, `commands`   | Globs or per-agent maps for user-level instruction files, subagents and commands. Files are linked verbatim.                                                                                                                                                                   |
| `sources[].mcp`                                     | Path to a Claude Code-format `{"mcpServers": {...}}` file translated into each agent's config. Secrets must use `${VAR}`. Root config only.                                                                                                                                    |
| `sources[].agentHooks`                              | Path for Claude Code or per-agent map of hook files in each agent's native format. Root config only.                                                                                                                                                                           |
| `fleet`, `timer`, `hooks`, `report`, `hub`, `forks` | SSH or Tailscale hosts, cron schedule (`*/30 * * * *` default), shell commands to run when a source's files change (`FLEETRC_CHANGED`, JSON report on stdin), a command (`report.run`) and a URL (`hub`) that receive each run's report, and the forks `fleetrc fork` records. |

## Supported agents

Skills link into Claude Code, Codex, Gemini CLI, OpenCode, Cursor, GitHub Copilot and the rest of the agents in Vercel's [`skills`](https://github.com/vercel-labs/skills) package. Universal agents that read `~/.agents/skills` share that folder so skills are not duplicated.

Instruction files, subagents, commands, MCP servers and agent hooks sync into Claude Code, Codex, Grok, Gemini CLI, OpenCode, Cursor and GitHub Copilot wherever each agent supports user-level config. Run `fleetrc agents` to see every id and path on your machine.

Works on Linux with systemd, macOS with launchd, and Windows with Task Scheduler and junctions or `--copy`.

## Status

fleetrc is at 0.1.0, so expect changes before 1.0. `hub` currently receives sync reports only.

**Moving from skillfleet.** The first `fleetrc` command that changes anything moves an existing `skillfleet` install, and `fleetrc fleet upgrade` moves every host in `fleet`. For one release fleetrc still reads `.skillfleet/manifest.json`, the `github.com/onmax/skillfleet` tailnet capability and `SKILLFLEET_*` hook variables, with a warning. Rename them before the next release.

**Develop.** Run `pnpm install` and `pnpm ready` to format, build, check and test.

## License

[MIT](https://github.com/onmax/fleetrc/blob/main/LICENSE)
