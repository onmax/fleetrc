<h1>
  <img src="https://raw.githubusercontent.com/onmax/skillfleet/main/.github/assets/banner-light.png" alt="skillfleet: the same skills on every agent and every machine, synced when an agent session starts" width="100%">
</h1>

[![npm version](https://comark-ui.onmax.me/badge.svg?source=npm-version&package=skillfleet&icon=npm)](https://www.npmjs.com/package/skillfleet)
[![npm downloads](https://comark-ui.onmax.me/badge.svg?source=npm-downloads&package=skillfleet&period=month&icon=npm)](https://www.npmjs.com/package/skillfleet)
[![Release status](https://comark-ui.onmax.me/badge.svg?source=github-actions&repository=onmax%2Fskillfleet&workflow=release.yaml&icon=github)](https://github.com/onmax/skillfleet/actions/workflows/release.yaml)
[![status: early](https://comark-ui.onmax.me/badge.svg?label=status&value=early)](#status)
[![license: MIT](https://comark-ui.onmax.me/badge.svg?label=license&value=MIT)](./LICENSE)

One manifest for your agent skills across Claude Code, Codex, Gemini CLI, OpenCode, Cursor and Copilot, synced on every machine when an agent session starts.

[![Download the 90-second explainer (MP4)](https://raw.githubusercontent.com/onmax/skillfleet/main/.github/assets/explainer-poster.png)](https://raw.githubusercontent.com/onmax/skillfleet/main/.github/assets/explainer.mp4)

```sh
npx skillfleet init my-team/agents
```

[Problems it solves](#problems-it-solves) · [Usage](#usage) · [Manifest](#manifest) · [Agents and systems](#agents-and-systems) · [Build on skillfleet](#build-on-skillfleet) · [Status](#status) · [GitHub](https://github.com/onmax/skillfleet)

## Problems it solves

- **Every agent looks in a different folder.** skillfleet keeps one copy of each skill and links it into the folder of every agent installed on the machine.
- **Skills come from everywhere, and nobody wrote down the list.** One `.skillfleet/manifest.json` in git lists your git, npm, index and local sources.
- **Your laptop, desktop and servers drift apart.** Each machine syncs in the background when an agent session starts, and `skillfleet fleet sync` reaches the rest over SSH or Tailscale.
- **An update overwrites your local fix.** skillfleet keeps your copy and holds upstream's change until you `diff` and `merge` it.
- **Third-party skills run with your shell and credentials.** `"update": "review"` holds a source's changes until you read them.
- **Your team shares skills, and you keep your own.** Your manifest `extends` the team's, and your skill wins when the names clash.
- **You want skill edits in your own checkout.** A `"path"` source links from the clone you work in, so an agent's edit is ready to commit.
- **Your agent folders already hold skills.** `init` backs up the ones a source provides, adopts the rest into your repository, and `--dry-run` shows the plan first.

## Usage

```sh
npx skillfleet init <manifest>   # install, link your agents and add the session hooks
skillfleet                       # sync now
skillfleet status                # last run, held updates, edited skills, sessions to restart
skillfleet doctor                # check node, git access, the hooks or timer, duplicate skills
skillfleet fleet sync            # sync every machine in the manifest over SSH
```

No manifest yet? [Write one](#write-your-manifest) first. `<manifest>` is one of:

- a repository, such as `my-team/agents`, `github:my-team/agents`, `gitlab:group/agents`, a git URL ending in `.git`, or its GitHub or GitLab page. skillfleet reads its `.skillfleet/manifest.json`.
- a file inside a repository, such as `github:my-team/agents//team.json`, when the manifest is anywhere else.
- a file or a folder on this machine. A folder means its `.skillfleet/manifest.json`, so `init .` works in a clone.

`init` copies skillfleet out of the npx cache into its state folder (`~/.local/state/skillfleet`, or `%LOCALAPPDATA%\skillfleet` on Windows), so the hooks and the timer never point at a folder npm may delete. If `~/.local/bin` is on your PATH, `init` links `skillfleet` there; if not, it prints the folder to add to PATH. `--no-hooks` skips the session hooks and still installs the command; `--timer` adds the timer. The launcher and the timer run node through a path that outlives a Node.js upgrade, such as `/opt/homebrew/bin/node`; if node moves anyway, `skillfleet doctor` says so and `npx skillfleet@latest self-install` repairs both.

`add`, `remove`, `fleet add`, `fleet init`, `fork` and `merge` of a fork change the manifest. When it lives in a repository, skillfleet reads a copy that the next sync fetches again, so they change a working clone of that repository instead (a source with a `path`, below) and ask you to push. Without one, they change nothing and print the JSON to add upstream.

### Add a machine

From a machine that is already set up, name the new one:

```sh
skillfleet fleet init vps2
```

skillfleet connects over SSH and runs `npx skillfleet init` there with the same manifest, so the new machine gets its own copy of skillfleet, the session hooks and a first sync. Then it adds `vps2` to `fleet`, unless that `init` failed there (its first sync, the hooks or the timer), which leaves `vps2` out and makes the command exit 1. On a server where no agent runs, add `--timer`. The manifest has to be in a repository, since the new machine can't read files on this one, and the new machine needs Node.js 22.12 or newer.

With Tailscale, tag the server and run `skillfleet fleet init tag:servers`: every machine with the tag gets set up, and `fleet` gets `tag:servers`, so the next server you tag is in the fleet too. A machine that already has the manifest only syncs, unless you pass an option for its `init`, such as `--timer`. One that has another manifest, or the same repository spelled in a way skillfleet can't be sure of, is left alone unless you pass `--force`. Hosts install the version of skillfleet you run; to set them up with a preview build, set `SKILLFLEET_PACKAGE` to what npx should install, such as a pkg.pr.new URL or a tarball path on the host. Prefix a relative path inside the SSH login directory with `./`, for example `./dist/preview.tgz`, to distinguish it from GitHub shorthand.

If setup failed, run the same command again after fixing the cause. If SSH timed out after the host answered, check whether setup is still running there before retrying. With `--json`, successful enrollment returns the host result array; if editing the manifest fails after setup, the command exits 1 and returns an object with `hosts` and `error`.

### Or take the manifest from your tailnet

On Tailscale, your tailnet policy can name the manifest once for all your machines. Add this to the policy in the admin console:

```jsonc
"nodeAttrs": [
  { "target": ["*"], "app": { "github.com/onmax/skillfleet": [{ "manifest": "me/skills" }] } },
],
```

**Only follow the policy if you trust its editors.** They choose the root manifest, whose `hooks` and `report.run` can run commands as your local user, including during background syncs. To choose a repository yourself on a new machine, run `npx skillfleet init github:me/skills` instead. On a machine already following policy, initializing with a different manifest stops following it; naming the same one keeps following enabled.

Then a bare `npx skillfleet init` on a new machine, or on one already following the tailnet, uses the policy manifest. Normal syncs ask Tailscale again and save a replacement only after it loads. If Tailscale can't answer, the machine keeps its last manifest and the sync says why. The policy value must name a repository, such as `me/skills` or `github:me/skills//<file>`. Git still delivers the manifest; Tailscale tells skillfleet where to find it.

### Commands

`skillfleet <command> --help` prints a command's options. Commands that read the manifest take `--manifest <m>` to use another one than the one `init` configured.

| Command                                 | What it does                                                                                                                                                                                                                                                                                                                                                                                     |
| --------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `sync [source]`                         | Fetches every source, or only `source`, and links the skills. Plain `skillfleet` runs it.                                                                                                                                                                                                                                                                                                        |
| `init [manifest]`                       | Configures the manifest (a repo or folder's `.skillfleet/manifest.json`), moves aside or adopts what the agent folders hold now, syncs, installs the command and the session hooks. `--no-hooks` skips the hooks, `--timer` installs the timer too, `--force` goes ahead when a skill name would be lost. A machine that has the timer keeps it. Without one, it reuses the configured manifest. |
| `status`                                | The last run, held and pending updates, edited skills, what starts the syncs, and Codex sessions to restart.                                                                                                                                                                                                                                                                                     |
| `list`                                  | Linked skills and the source of each. With `--json`, the document in [Build on skillfleet](#build-on-skillfleet).                                                                                                                                                                                                                                                                                |
| `agents`                                | Every agent id, which agents are installed here, and the folder each one's skills go to.                                                                                                                                                                                                                                                                                                         |
| `doctor`                                | Checks node, git access to each source, the hooks or the timer, and duplicate skills. It warns when nothing starts a sync.                                                                                                                                                                                                                                                                       |
| `add <source>`                          | Adds `owner/repo`, `github:` or `gitlab:` repositories, a git URL, a GitHub or GitLab link to a folder or a `SKILL.md` (its branch becomes `ref`, its folder the `skills` glob), an index URL, `npm:<package>` (or `npm:<package>@<version>`) or a path, then syncs. `--id`, `--skills <glob>`, `--include <name>`, `--exclude <name>` (both repeatable) and `--review` set the source's fields. |
| `remove <source\|skill>`                | Removes a source, or adds a skill to its source's `exclude`. A team manifest's skill or source is left out in your `extends` entry.                                                                                                                                                                                                                                                              |
| `adopt <path>`                          | Moves a hand-made skill folder into your personal repository.                                                                                                                                                                                                                                                                                                                                    |
| `fork <skill>`                          | Moves a skill of a git source into your personal repository to edit it, and records it under `forks`.                                                                                                                                                                                                                                                                                            |
| `diff [skill]`                          | Shows one skill's update waiting for review, or its local edits. Without a skill, every update a source is holding.                                                                                                                                                                                                                                                                              |
| `merge <skill>`                         | Merges an upstream update into an edited skill or a fork.                                                                                                                                                                                                                                                                                                                                        |
| `update <source>`                       | Takes the updates a review-mode source is holding.                                                                                                                                                                                                                                                                                                                                               |
| `timer install\|remove\|status`         | Installs, removes or shows the timer, for a machine where no agent runs.                                                                                                                                                                                                                                                                                                                         |
| `fleet sync\|status\|upgrade [host...]` | Runs on every host in `fleet`, or the hosts named, which may be `tag:<name>`. `--timeout <s>` waits that long for each (30 by default).                                                                                                                                                                                                                                                          |
| `fleet init <host...>`                  | Sets up new machines from this one: on each host, over SSH, `npx skillfleet init` with this machine's manifest, then adds the hosts to `fleet`. A host may be `tag:<name>`. `--copy`, `--no-copy`, `--timer`, `--no-hooks` and `--force` go to each host's `init`. `--timeout <s>` is 120 by default.                                                                                            |
| `fleet add [host...]`                   | Adds hosts or `tag:<name>` entries to `fleet`. Without hosts, it lists the machines and tags on your tailnet.                                                                                                                                                                                                                                                                                    |
| `hook install\|remove [agent]`          | Adds or removes the session hooks in Claude Code and Codex, or only in `claude-code` or `codex`. Without an agent, it acts on each one whose folder exists.                                                                                                                                                                                                                                      |
| `self-install`                          | Copies this skillfleet into the state folder. `init` and `fleet upgrade` run it.                                                                                                                                                                                                                                                                                                                 |

These options work wherever they make sense, and a command refuses one it can't use:

- `--dry-run` prints what would change and writes nothing. `fleet sync --dry-run` lists the machines each `tag:` entry stands for and runs `sync --dry-run` on each host. Commands that only read, and `fleet upgrade`, refuse it.
- `--json` prints one JSON document on stdout, and messages go to stderr. A failure prints `{ "ok": false, "error": "..." }`.
- `--offline` uses what is already fetched.
- `--copy` copies skill folders instead of linking them, for agents or file systems that don't follow links. `init`, `sync` and the other commands that sync remember it in skillfleet's `config.json`, so later syncs copy too, until `--no-copy`. An edit made in one agent's copy is an edit of the skill: the next sync moves it into the folder the copy came from, so every agent gets it, upstream changes wait for `diff` and `merge`, and `--no-copy` links the edited skill.

A mistake, such as a typo'd repository or agent id, prints one line that says what to fix. An error skillfleet did not expect prints its stack trace with `SKILLFLEET_DEBUG=1`.

### Syncs from session hooks

`init` adds a hook to Claude Code (`~/.claude/settings.json`, or `$CLAUDE_CONFIG_DIR/settings.json`) and to Codex (`~/.codex/hooks.json`, or `$CODEX_HOME/hooks.json`), for each one whose folder exists. It runs `skillfleet hook run <agent>`, through the launcher's full path, when a session starts, and prompts never start a sync. On Windows, Claude Code's entry names node and skillfleet's installed copy instead of the `.cmd` launcher, which Claude Code would hand to Git Bash or PowerShell. If the last sync started over 15 minutes ago and none is running, the hook starts one in the background and returns at once; the sync writes to `logs/skillfleet-sync.log` in the state folder, like the timer. The hook makes no network call and prints nothing about the sync, so the agent never waits on it.

`skillfleet hook install` and `skillfleet hook remove` add or take out skillfleet's entry and leave your other hooks alone. `hook install` and `init` also remove legacy prompt hooks. Codex ties each hook's approval to its place in `hooks.json`, so in Codex skillfleet never moves your hooks: a new entry takes the place of its older one, and where taking an entry out would move a hook of yours, `hook install`, `init` and `hook remove` leave a no-op in its slot. Codex runs a new hook only after you trust it: open `/hooks` in Codex and approve it.

### New skills in running sessions

A sync starts when a Claude Code or Codex session starts and the last sync is over 15 minutes old. Claude Code detects new skills in existing skills directories during a session; if the sync created a top-level skills directory after the session started, run `/reload-skills`. Codex can refresh skills automatically; if a new skill does not appear, restart the session. On a machine where no agent runs, `skillfleet init <manifest> --no-hooks --timer` syncs on a schedule instead.

## Manifest

### Write your manifest

A manifest is a JSON file in git. A repository keeps its manifest in `.skillfleet/manifest.json`. A team keeps one with the sources everyone shares:

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

Each person keeps their own manifest, in `.skillfleet/manifest.json` of the repository of their own skills, that extends the team's:

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
- Relative paths (`path`, `local`, `extends`) resolve against the manifest's own folder, `.skillfleet/`. To use the repository itself as a local source, add `{ "id": "mine", "local": ".." }` to `sources`.
- A source is one of `git`, `index` (a site serving `/.well-known/agent-skills/index.json`), `npm` (with an optional `registry`) or `local` (a folder on this machine). `skills` is a glob of skill folders inside it, and `ref` pins a git branch, tag or commit, written in full or as its first 7 or more characters. A `"path"` clone pinned to a commit stays on it, since there is nothing to fast-forward, until the manifest names another commit.
- Source and hook globs are limited to 8,192 UTF-16 code units. If matching a glob against many paths exceeds its work limit, skillfleet reports an error instead of skipping the remaining matches. Narrow the glob, for example by adding a fixed folder prefix.
- An `index` site may serve the older v0.1 index at `/.well-known/skills/index.json` instead; skillfleet reads both.
- `agents` is `"all"` (the default) or a list of agent ids. `"all"` means every agent installed on the machine: one whose folder is in your home, such as `~/.claude` for Claude Code or `~/.codex` for Codex. `skillfleet agents` lists the ids and which agents it found. A sync that links into no folder says so.
- When two sources have a skill with the same name, the first one wins, and `status` prints one line about it. Names that differ only in case or Unicode form (`Foo` and `foo`, or `café` typed as one character and as `e` plus an accent) are one name, since macOS and Windows keep them in one folder: a source renaming `alpha` to `Alpha` renames the skill, and `include`, `exclude`, `forks` and the skill named in `diff`, `merge`, `fork` and `remove` find it in any of them. `include` and `exclude` pick skills from a source.
- A working clone with two such paths, such as `skills/Foo` and `skills/foo`, gets one folder for both on macOS and Windows. skillfleet keeps the first in byte order there (`Foo`), warns on every sync, and does not count the other as a local edit, so the clone keeps fast-forwarding.
- `"update": "review"` holds a source's changes until you look at the diff with `skillfleet diff` and take them with `skillfleet update <source>`. Use it for repositories you don't own, since your agents run their skills with your permissions. The first fetch links straight away, so read a source before you add it.
- `"path"` keeps a source in a clone you work in. skillfleet fast-forwards it with `git` and links the skills from there, so an agent that edits a skill edits your clone.
- `"followLinks": true` on a source with a `"path"` follows links that lead out of the clone, such as a dotfiles repository whose `skills/x` links into another repository of yours. Without it skillfleet doesn't read them, since a cloned repository's links come from whoever pushes to it, and each sync names the link and this setting. Only your own manifest can set it: a team manifest's is ignored, with a warning.
- `"adopt": true` marks the source (a git source with a `path`, or a `local` one) that `init`, `adopt` and `fork` move skills into. Without one, they use the first git source with a `path`.
- `forks` is what `skillfleet fork` records for each forked skill: the repository it came from, its folder there, and the upstream commit it was last merged with. `diff` and `merge` compare against that commit.
- `"timer": { "cron": "0 * * * *" }` sets when the timer syncs. It defaults to every 30 minutes, in the machine's time zone (`"timeZone": "local"`), even after a daylight saving change or a move to another zone. `skillfleet timer install` fetches the manifest and applies a change; until you run it, the next sync on each machine says once that the timer runs on the old schedule.
- `"timeZone"` in `timer` takes an IANA name such as `Europe/Madrid` to run the cron in that zone. launchd and Task Scheduler run timers in the machine's time zone, so on macOS and Windows another zone works only when it gives the same times.
- `extends` adds a team manifest's sources. Fleet hosts, hooks and reports come only from your own manifest, so a team manifest can't run anything on your machines. Its git sources must be on another machine (`http`, `https`, `git`, `ssh`, `user@host:path` or `owner/repo`), after your git config's `insteadOf` rewrites them, so a team manifest can't reach a repository on yours. To leave part of a team manifest out, write its entry as `{ "manifest": "my-team/agents", "exclude": ["nuxt-ui"], "excludeSources": ["ag-grid"] }`: `exclude` names skills and `excludeSources` names its sources. `skillfleet remove <skill|source>` writes this for a team skill or source. Exclusions add up: a team manifest's own exclusions of what it extends hold for you too, and when two of your entries bring in the same manifest, what either one leaves out is left out.
- A file whose name Windows can't write, such as `notes~1.md` or `faq: part 1.md`, is left out on Windows and kept on Linux and macOS, in git sources and working clones alike; each sync names it and warns that your Windows machines lack it.
- `fleet` names SSH destinations: a host, `user@host`, an alias from `~/.ssh/config`, or `ssh://user@host:port` for another port. Each host needs Node.js and its own `skillfleet init`, which `fleet init` runs for you. `fleet upgrade` installs this machine's skillfleet version on every host and prints each host's change, such as `laptop: 0.0.1 → 0.0.2`. To upgrade one machine, run `npx skillfleet@latest self-install` on it: the launcher, the hooks and the timer run the copy it replaces, so the next sync uses the new version.
- A `fleet` entry `tag:<name>`, such as `"fleet": ["tag:servers", "laptop"]`, stands for every machine on your tailnet with that Tailscale tag. skillfleet asks `tailscale status` each time a `fleet` command runs, so a server you tag joins the fleet without a manifest change. It skips this machine and uses each peer's MagicDNS name when available, falling back to a Tailscale IP when MagicDNS is off or the name does not resolve to the peer locally. A machine Tailscale has offline gets "offline in Tailscale" instead of a wait on ssh, and makes the command exit 1, as an unreachable host does. A named host takes precedence over a tag match when both identify the same peer. A short alias that doesn't resolve to the peer does not replace the tagged IP. Explicit entries that identify the same destination with the same user and port run once, including IPv6 addresses written two ways. If Tailscale is missing or logged out, the other hosts still run and the tag's line says why. Tagging a device in Tailscale makes the tag its owner instead of the user who added it, which suits servers more than your own laptop.
- `hooks` run a command when files of a source change: `{ "run": "...", "on": ["mine:skills/**"] }`. A pattern is `<source>:<glob>`, and the path it matches starts at the root of the repository for a `git` source, with or without `"path"`, at the package root for `npm`, at the folder for `local`, and at `<skill>/` for an `index`. The hook gets the matched `<source>:<path>` lines in `SKILLFLEET_CHANGED`. A pattern that matches no file in its source gets a warning on each sync. `"report": { "run": "..." }` gets each run's report as JSON on stdin, and `hub` is a URL the report is posted to.
- A hook gets the sync report as JSON on stdin and its `name` (which defaults to `run`) in `SKILLFLEET_HOOK`. A hook still running after 5 minutes is stopped.

## Agents and systems

skillfleet links skills into Claude Code, Codex, Gemini CLI, OpenCode, Cursor, GitHub Copilot, and the rest of the agents in Vercel's [`skills`](https://github.com/vercel-labs/skills) package.

When one of your agents reads `~/.agents/skills`, as Codex does, the agents that read it too (Gemini CLI, OpenCode, Cursor, GitHub Copilot and the other ones `skills` calls universal) get their skills from there only, as with `npx skills add -g`. Linking their own folders as well would show each skill twice, and Gemini CLI warns about every one.

| System  | Timer (`timer install`) | Skills are linked as |
| ------- | ----------------------- | -------------------- |
| Linux   | a systemd user timer    | symlinks             |
| macOS   | a launchd agent         | symlinks             |
| Windows | a Task Scheduler task   | junctions, or copies |

It needs Node.js 22.12 or newer, and git for git sources. On Linux without systemd (most containers, WSL1, systems that boot with OpenRC or runit), `timer install` can't install a timer; it prints a crontab line that runs `skillfleet sync` instead. The session hooks work there as anywhere. CI runs on all three systems, with Node 22 and 24.

skillfleet fetches sources through Vercel's [`skills`](https://github.com/vercel-labs/skills) package and runs its timers with `@vite-hub/schedule/os`.

## Build on skillfleet

Other runtimes, such as ViteHub agents or a script of yours, can use the skills skillfleet keeps on a machine without running a sync themselves.

- **Ask skillfleet once.** Run `skillfleet list --json` when your runtime starts. It reads this machine's state only, with no manifest and no network, and prints the skills sorted by name:

  ```json
  {
    "version": 1,
    "lastChange": "2026-11-19T08:00:00.000Z",
    "skills": [
      {
        "name": "deploy",
        "source": "team",
        "dir": "/home/me/code/team-skills/skills/deploy",
        "changedAt": "2026-11-18T17:20:00.000Z"
      }
    ]
  }
  ```

  `dir` is the skill's recorded folder, whether or not any agent folder links it. When reading `<dir>/SKILL.md`, handle a missing or unreadable file. `changedAt` is recorded by sync and can advance for unchanged skills when their local or clone source changes. `lastChange` is `null` before the first sync. Later versions only add fields.

- **Or read the folder, with no dependency.** `~/.agents/skills` holds one folder per skill, each with its `SKILL.md`, when the manifest's agents include one that reads it, such as Codex.
- **Share the config.** The manifest is `.skillfleet/manifest.json` in a repository, and the published [`schema.json`](https://unpkg.com/skillfleet/schema.json) describes it, so a runtime can read the same file to pick the same sources.
- **Get your own folder linked.** skillfleet links into the agents of Vercel's [`skills`](https://github.com/vercel-labs/skills) package. A runtime that joins that package's agent list gets its folder linked on every machine, through `"agents": "all"` or its id.

## Status

0.0.1 is the first release, so expect changes before 1.0. The commands and manifest fields above work as described. The hub that would show a team's machines in one place isn't built: today `hub` only receives each run's report.

## License

[MIT](./LICENSE)
