<h1>
  <img src="https://raw.githubusercontent.com/onmax/skillfleet/main/.github/assets/banner-light.png" alt="skillfleet: the same skills on every agent and every machine, kept current by a timer" width="100%">
</h1>

[![npm version](https://comark-ui.onmax.me/badge.svg?source=npm-version&package=skillfleet&icon=npm)](https://www.npmjs.com/package/skillfleet)
[![npm downloads](https://comark-ui.onmax.me/badge.svg?source=npm-downloads&package=skillfleet&period=month&icon=npm)](https://www.npmjs.com/package/skillfleet)
[![Release status](https://comark-ui.onmax.me/badge.svg?source=github-actions&repository=onmax%2Fskillfleet&workflow=release.yaml&icon=github)](https://github.com/onmax/skillfleet/actions/workflows/release.yaml)
[![status: early](https://comark-ui.onmax.me/badge.svg?label=status&value=early)](#status)
[![license: MIT](https://comark-ui.onmax.me/badge.svg?label=license&value=MIT)](./LICENSE)

The same agent skills in Claude Code, Codex, Gemini CLI, OpenCode, Cursor and Copilot, on every machine you use, kept current by a timer.

You list where your skills come from in one manifest in git: your own repo, your team's, GitHub upstreams, skill indexes like Drop's, and npm. Each machine pulls them on a schedule, links every skill into every agent's folder, and reports what changed. A skill you edited on that machine is never overwritten.

[Usage](#usage) · [Manifest](#manifest) · [Agents and systems](#agents-and-systems) · [Status](#status) · [GitHub](https://github.com/onmax/skillfleet)

```sh
npx skillfleet init my-team/agents
```

- **One manifest.** It lives in git next to your skills, so every machine and every teammate reads the same list.
- **Every agent.** The agent folders come from the [`skills`](https://github.com/vercel-labs/skills) package's agent list, so an agent it adds works here too.
- **Your edits stay.** If a sync would change a file you edited, skillfleet keeps your copy, holds that source, and says so in `status`.
- **On a timer.** systemd, launchd or Task Scheduler runs the sync, with no process left running, and catches up after the machine sleeps.
- **The whole fleet.** `skillfleet fleet sync` runs it over SSH on every machine you list. Tailscale names work.

## Usage

```sh
npx skillfleet init <manifest>   # install, link your agents and start the timer
skillfleet                       # sync now
skillfleet status                # last run, held updates, edited skills, sessions to restart
skillfleet doctor                # check node, git access, the timer and duplicate skills
skillfleet fleet sync            # sync every machine in the manifest over SSH
```

`<manifest>` is one of:

- a repository, such as `my-team/agents`, `github:my-team/agents`, `gitlab:group/agents` or a git URL ending in `.git`. skillfleet reads `skills.json` at its root.
- a file inside a repository, such as `github:my-team/agents//team/skills.json`.
- a file or a folder on this machine. A folder means the `skills.json` in it.

`init` copies skillfleet out of the npx cache into its state folder (`~/.local/state/skillfleet`, or `%LOCALAPPDATA%\skillfleet` on Windows), so the timer never points at a folder npm may delete. If `~/.local/bin` is on your PATH, `init` links `skillfleet` there; if not, it prints the folder to add to PATH. `--no-timer` skips the timer and still installs the command.

`add`, `remove` and `fleet add` change the manifest. When it lives in a repository, skillfleet reads a copy that the next sync fetches again, so they change a working clone of that repository instead (a source with a `path`, below) and ask you to push. Without one, they print the JSON to add upstream.

`skillfleet --help` lists the rest: `list`, `adopt`, `fork`, `diff`, `merge`, `update`, `timer install|remove|status`, `fleet status|upgrade|add` and `hook prompt`.

## Manifest

```json
{
  "agents": "all",
  "sources": [
    { "id": "mine", "git": "onmax/skills", "path": "~/onmax/skills" },
    { "id": "team", "git": "my-team/agents", "skills": "skills/*" },
    { "id": "nuxt", "git": "onmax/nuxt-skills", "include": ["nuxt", "nuxt-ui"] },
    { "id": "ag-grid", "git": "ag-grid/skills", "update": "review" },
    { "id": "drop", "index": "https://drop.vitehub.dev" }
  ],
  "fleet": ["laptop", "me@homelab", "ssh://me@vps.example.com:2222"]
}
```

- A source is one of `git`, `index` (a site serving `/.well-known/agent-skills/index.json`), `npm` (with an optional `registry`) or `local` (a folder on this machine). `skills` is a glob of skill folders inside it, and `ref` pins a git branch, tag or commit.
- When two sources have a skill with the same name, the first one wins, and `status` prints one line about it. `include` and `exclude` pick skills from a source.
- `"update": "review"` holds a source's changes until you look at the diff with `skillfleet diff` and take them with `skillfleet update <source>`. Use it for repositories you don't own, since your agents run their skills with your permissions.
- `"path"` keeps a source in a clone you work in. skillfleet fast-forwards it with `git` and links the skills from there, so an agent that edits a skill edits your clone.
- `"timer": { "cron": "0 * * * *" }` sets when the timer syncs. It defaults to every 30 minutes, in the machine's time zone, and `skillfleet timer install` applies a change.
- `extends` adds a team manifest's sources. Fleet hosts, hooks and reports come only from your own manifest, so a team manifest can't run anything on your machines.
- `fleet` names SSH destinations: a host, `user@host`, an alias from `~/.ssh/config`, or `ssh://user@host:port` for another port. Each host needs Node.js and its own `skillfleet init`. `fleet upgrade` installs this machine's skillfleet version on every host.
- `hooks` run a command when files of a source change: `{ "run": "...", "on": ["mine:skills/**"] }`. `"report": { "run": "..." }` gets each run's report as JSON on stdin, and `hub` is a URL the report is posted to.

## Agents and systems

skillfleet links skills into Claude Code, Codex, Gemini CLI, OpenCode, Cursor, GitHub Copilot, and the rest of the agents in Vercel's [`skills`](https://github.com/vercel-labs/skills) package.

| System  | Timer                 | Skills are linked as |
| ------- | --------------------- | -------------------- |
| Linux   | a systemd user timer  | symlinks             |
| macOS   | a launchd agent       | symlinks             |
| Windows | a Task Scheduler task | junctions, or copies |

It needs Node.js 22.12 or newer, and git for git sources. CI runs on all three systems, with Node 22 and 24.

skillfleet fetches sources through Vercel's [`skills`](https://github.com/vercel-labs/skills) package and runs its timers with `@vite-hub/schedule/os`.

## Status

Early. Nothing is on npm yet, and 0.0.1 will be the first release. The commands and manifest fields above work as described, and they may still change before 1.0. The hub that would show a team's machines in one place isn't built: today `hub` only receives each run's report.

## License

[MIT](./LICENSE)
