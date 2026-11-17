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
- **Your edits stay.** If a sync would change a file you edited, skillfleet keeps your copy, holds upstream's update to that skill, and says so in `status`.
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

No manifest yet? [Write one](#write-your-manifest) first. `<manifest>` is one of:

- a repository, such as `my-team/agents`, `github:my-team/agents`, `gitlab:group/agents` or a git URL ending in `.git`. skillfleet reads `skills.json` at its root.
- a file inside a repository, such as `github:my-team/agents//team/skills.json`.
- a file or a folder on this machine. A folder means the `skills.json` in it.

`init` copies skillfleet out of the npx cache into its state folder (`~/.local/state/skillfleet`, or `%LOCALAPPDATA%\skillfleet` on Windows), so the timer never points at a folder npm may delete. If `~/.local/bin` is on your PATH, `init` links `skillfleet` there; if not, it prints the folder to add to PATH. `--no-timer` skips the timer and still installs the command. The launcher and the timer run node through a path that outlives a Node.js upgrade, such as `/opt/homebrew/bin/node`; if node moves anyway, `skillfleet doctor` says so and `npx skillfleet@latest timer install` repairs both.

`add`, `remove`, `fleet add`, `fork` and `merge` of a fork change the manifest. When it lives in a repository, skillfleet reads a copy that the next sync fetches again, so they change a working clone of that repository instead (a source with a `path`, below) and ask you to push. Without one, they change nothing and print the JSON to add upstream.

### Commands

`skillfleet <command> --help` prints a command's options. Commands that read the manifest take `--manifest <m>` to use another one than the one `init` configured.

| Command                                 | What it does                                                                                                                                                                                                                                                                                                                                                                                     |
| --------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `sync [source]`                         | Fetches every source, or only `source`, and links the skills. Plain `skillfleet` runs it.                                                                                                                                                                                                                                                                                                        |
| `init [manifest]`                       | Configures the manifest, moves aside or adopts what the agent folders hold now, syncs, installs the command and the timer. `--no-timer` skips the timer, `--force` goes ahead when a skill name would be lost. Without a manifest, it uses the configured one again.                                                                                                                             |
| `status`                                | The last run, held and pending updates, edited skills, and Codex sessions to restart.                                                                                                                                                                                                                                                                                                            |
| `list`                                  | Linked skills and the source of each.                                                                                                                                                                                                                                                                                                                                                            |
| `agents`                                | Every agent id, which agents are installed here, and the folder each one's skills go to.                                                                                                                                                                                                                                                                                                         |
| `doctor`                                | Checks node, git access to each source, the timer and duplicate skills.                                                                                                                                                                                                                                                                                                                          |
| `add <source>`                          | Adds `owner/repo`, `github:` or `gitlab:` repositories, a git URL, a GitHub or GitLab link to a folder or a `SKILL.md` (its branch becomes `ref`, its folder the `skills` glob), an index URL, `npm:<package>` (or `npm:<package>@<version>`) or a path, then syncs. `--id`, `--skills <glob>`, `--include <name>`, `--exclude <name>` (both repeatable) and `--review` set the source's fields. |
| `remove <source\|skill>`                | Removes a source, or adds a skill to its source's `exclude`.                                                                                                                                                                                                                                                                                                                                     |
| `adopt <path>`                          | Moves a hand-made skill folder into your personal repository.                                                                                                                                                                                                                                                                                                                                    |
| `fork <skill>`                          | Moves a vendored skill into your personal repository to edit it, and records it under `forks`.                                                                                                                                                                                                                                                                                                   |
| `diff [skill]`                          | Shows one skill's update waiting for review, or its local edits. Without a skill, every update a source is holding.                                                                                                                                                                                                                                                                              |
| `merge <skill>`                         | Merges an upstream update into an edited skill or a fork.                                                                                                                                                                                                                                                                                                                                        |
| `update <source>`                       | Takes the updates a review-mode source is holding.                                                                                                                                                                                                                                                                                                                                               |
| `timer install\|remove\|status`         | Installs, removes or shows the timer.                                                                                                                                                                                                                                                                                                                                                            |
| `fleet sync\|status\|upgrade [host...]` | Runs on every host in `fleet`, or the hosts named. `--timeout <s>` waits that long for each (30 by default).                                                                                                                                                                                                                                                                                     |
| `fleet add [host...]`                   | Adds hosts to `fleet`. Without hosts, it lists the machines on your tailnet.                                                                                                                                                                                                                                                                                                                     |
| `hook prompt`                           | The Claude Code hook below.                                                                                                                                                                                                                                                                                                                                                                      |
| `self-install`                          | Copies this skillfleet into the state folder. `init` and `fleet upgrade` run it.                                                                                                                                                                                                                                                                                                                 |

These options work wherever they make sense, and a command refuses one it can't use:

- `--dry-run` prints what would change and writes nothing. `fleet sync --dry-run` runs `sync --dry-run` on each host. Commands that only read, and `fleet upgrade`, refuse it.
- `--json` prints one JSON document on stdout, and messages go to stderr. A failure prints `{ "ok": false, "error": "..." }`.
- `--offline` uses what is already fetched.
- `--copy` copies skill folders instead of linking them, for agents or file systems that don't follow links. `init`, `sync` and the other commands that sync remember it in skillfleet's `config.json`, so the timer's runs copy too, until `--no-copy`. An edit made in one agent's copy is an edit of the skill: the next sync moves it into the folder the copy came from, so every agent gets it, upstream changes wait for `diff` and `merge`, and `--no-copy` links the edited skill.

A mistake, such as a typo'd repository or agent id, prints one line that says what to fix. An error skillfleet did not expect prints its stack trace with `SKILLFLEET_DEBUG=1`.

### New skills in running sessions

Claude Code loads a skill that a sync links mid-session on the next turn. Codex reads its skills when a session starts, so `skillfleet status` lists the Codex sessions to restart.

`skillfleet hook prompt` also tells Claude Code's model when a skill arrived after its session started, once per skill. skillfleet doesn't edit your Claude Code settings, so add the hook yourself, in `~/.claude/settings.json` (or `$CLAUDE_CONFIG_DIR/settings.json`):

```json
{
  "hooks": {
    "UserPromptSubmit": [{ "hooks": [{ "type": "command", "command": "skillfleet hook prompt" }] }]
  }
}
```

If `skillfleet` isn't on the PATH that Claude Code runs hooks with, write the full path of the launcher `init` installed: `~/.local/state/skillfleet/bin/skillfleet`, or `%LOCALAPPDATA%\skillfleet\bin\skillfleet.cmd` on Windows.

## Manifest

### Write your manifest

A manifest is a `skills.json` file in git. A team keeps one with the sources everyone shares:

```json
{
  "sources": [
    { "id": "team", "git": "my-team/agents", "skills": "skills/*" },
    { "id": "nuxt", "git": "onmax/nuxt-skills", "include": ["nuxt", "nuxt-ui"] },
    { "id": "ag-grid", "git": "ag-grid/skills", "update": "review" },
    { "id": "drop", "index": "https://drop.vitehub.dev" }
  ]
}
```

Each person keeps their own manifest, in the repository of their own skills, that extends the team's:

```json
{
  "$schema": "https://unpkg.com/skillfleet/schema.json",
  "extends": ["my-team/agents"],
  "agents": "all",
  "sources": [
    {
      "id": "mine",
      "git": "me/skills",
      "path": "~/code/skills",
      "skills": "skills/*",
      "adopt": true
    }
  ],
  "fleet": ["laptop", "me@homelab", "ssh://me@vps.example.com:2222"]
}
```

Then `npx skillfleet init me/skills` on each machine. Your sources come first, so your skill wins over a team skill with the same name. Folders on your machine (`path` and `local`), fleet hosts, hooks and reports belong in your manifest: skillfleet ignores them in an extended one.

### Fields

- `$schema` points editors at the schema, for completion and checks.
- A source is one of `git`, `index` (a site serving `/.well-known/agent-skills/index.json`), `npm` (with an optional `registry`) or `local` (a folder on this machine). `skills` is a glob of skill folders inside it, and `ref` pins a git branch, tag or commit, written in full or as its first 7 or more characters. A `"path"` clone pinned to a commit stays on it, since there is nothing to fast-forward, until the manifest names another commit.
- An `index` site may serve the older v0.1 index at `/.well-known/skills/index.json` instead; skillfleet reads both.
- `agents` is `"all"` (the default) or a list of agent ids. `"all"` means every agent installed on the machine: one whose folder is in your home, such as `~/.claude` for Claude Code or `~/.codex` for Codex. `skillfleet agents` lists the ids and which agents it found. A sync that links into no folder says so.
- When two sources have a skill with the same name, the first one wins, and `status` prints one line about it. Names that differ only in case or Unicode form (`Foo` and `foo`, or `café` typed as one character and as `e` plus an accent) are one name, since macOS and Windows keep them in one folder: a source renaming `alpha` to `Alpha` renames the skill, and `include`, `exclude`, `forks` and the skill named in `diff`, `merge`, `fork` and `remove` find it in any of them. `include` and `exclude` pick skills from a source.
- A working clone with two such paths, such as `skills/Foo` and `skills/foo`, gets one folder for both on macOS and Windows. skillfleet keeps the first in byte order there (`Foo`), warns on every sync, and does not count the other as a local edit, so the clone keeps fast-forwarding.
- `"update": "review"` holds a source's changes until you look at the diff with `skillfleet diff` and take them with `skillfleet update <source>`. Use it for repositories you don't own, since your agents run their skills with your permissions. The first fetch links straight away, so read a source before you add it.
- `"path"` keeps a source in a clone you work in. skillfleet fast-forwards it with `git` and links the skills from there, so an agent that edits a skill edits your clone.
- `"adopt": true` marks the source (a git source with a `path`, or a `local` one) that `init`, `adopt` and `fork` move skills into. Without one, they use the first git source with a `path`.
- `forks` is what `skillfleet fork` records for each forked skill: the repository it came from, its folder there, and the upstream commit it was last merged with. `diff` and `merge` compare against that commit.
- `"timer": { "cron": "0 * * * *" }` sets when the timer syncs. It defaults to every 30 minutes, in the machine's time zone (`"timeZone": "local"`), even after a daylight saving change or a move to another zone, and `skillfleet timer install` applies a change.
- `"timeZone"` in `timer` takes an IANA name such as `Europe/Madrid` to run the cron in that zone. launchd and Task Scheduler run timers in the machine's time zone, so on macOS and Windows another zone works only when it gives the same times.
- `extends` adds a team manifest's sources. Fleet hosts, hooks and reports come only from your own manifest, so a team manifest can't run anything on your machines.
- `fleet` names SSH destinations: a host, `user@host`, an alias from `~/.ssh/config`, or `ssh://user@host:port` for another port. Each host needs Node.js and its own `skillfleet init`. `fleet upgrade` installs this machine's skillfleet version on every host.
- `hooks` run a command when files of a source change: `{ "run": "...", "on": ["mine:skills/**"] }`. A pattern is `<source>:<glob>`, and the path it matches starts at the root of the repository for a `git` source, with or without `"path"`, at the package root for `npm`, at the folder for `local`, and at `<skill>/` for an `index`. The hook gets the matched `<source>:<path>` lines in `SKILLFLEET_CHANGED`. A pattern that matches no file in its source gets a warning on each sync. `"report": { "run": "..." }` gets each run's report as JSON on stdin, and `hub` is a URL the report is posted to.
- A hook gets the sync report as JSON on stdin and its `name` (which defaults to `run`) in `SKILLFLEET_HOOK`. A hook still running after 5 minutes is stopped.

## Agents and systems

skillfleet links skills into Claude Code, Codex, Gemini CLI, OpenCode, Cursor, GitHub Copilot, and the rest of the agents in Vercel's [`skills`](https://github.com/vercel-labs/skills) package.

When one of your agents reads `~/.agents/skills`, as Codex does, the agents that read it too (Gemini CLI, OpenCode, Cursor, GitHub Copilot and the other ones `skills` calls universal) get their skills from there only, as with `npx skills add -g`. Linking their own folders as well would show each skill twice, and Gemini CLI warns about every one.

| System  | Timer                 | Skills are linked as |
| ------- | --------------------- | -------------------- |
| Linux   | a systemd user timer  | symlinks             |
| macOS   | a launchd agent       | symlinks             |
| Windows | a Task Scheduler task | junctions, or copies |

It needs Node.js 22.12 or newer, and git for git sources. On Linux without systemd (most containers, WSL1, systems that boot with OpenRC or runit), init links your skills but can't install a timer; it prints a crontab line that runs `skillfleet sync` instead, and `init --no-timer` stops it asking. CI runs on all three systems, with Node 22 and 24.

skillfleet fetches sources through Vercel's [`skills`](https://github.com/vercel-labs/skills) package and runs its timers with `@vite-hub/schedule/os`.

## Status

0.0.1 is the first release, so expect changes before 1.0. The commands and manifest fields above work as described. The hub that would show a team's machines in one place isn't built: today `hub` only receives each run's report.

## License

[MIT](./LICENSE)
