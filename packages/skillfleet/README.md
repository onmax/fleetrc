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
npx skillfleet init onmax/skills
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
skillfleet status                # what changed, what's held, and which agents are behind
skillfleet fleet sync            # sync every machine in the manifest over SSH
```

`<manifest>` is a GitHub repository, such as `onmax/skills`, or a manifest file inside one, such as `github:my-team/agents//skills.json`. `init` copies skillfleet out of the npx cache, so the timer never points at a folder npm may delete.

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
  "fleet": ["laptop", "desktop", "me@homelab"]
}
```

- When two sources have a skill with the same name, the first one wins, and `status` prints one line about it. `include` and `exclude` pick skills from a source.
- `"update": "review"` holds a source's changes until you look at the diff. Use it for repositories you don't own, since your agents run their skills with your permissions.
- `"path"` keeps a source in a clone you work in. skillfleet fast-forwards it with `git` and links the skills from there, so an agent that edits a skill edits your clone.
- `"timer": { "cron": "0 * * * *" }` sets when the timer syncs. It defaults to every 30 minutes, in the machine's time zone, and `skillfleet timer install` applies a change.
- `extends` adds a team manifest's sources. Fleet hosts come only from your own manifest, so a team manifest can't run anything on your machines.

## Agents and systems

skillfleet links skills into Claude Code, Codex, Gemini CLI, OpenCode, Cursor, GitHub Copilot, and the rest of the agents in Vercel's [`skills`](https://github.com/vercel-labs/skills) package. A custom folder works too.

| System  | Timer                 | Skills are linked as |
| ------- | --------------------- | -------------------- |
| Linux   | a systemd user timer  | symlinks             |
| macOS   | a launchd agent       | symlinks             |
| Windows | a Task Scheduler task | junctions, or copies |

CI runs on all three, with Node 22 and 24.

An optional hub, a [ViteHub](https://vitehub.dev) app, shows your team which machines synced, what's held and what failed, and tells machines about a push within minutes instead of waiting for the timer. Skill files never go through it.

skillfleet fetches sources through Vercel's [`skills`](https://github.com/vercel-labs/skills) package and runs its timers with `@vite-hub/schedule/os`.

## Status

Early, and not usable yet. The first version on npm, `0.0.0`, only claims the name and prints this status. The commands and the manifest above are the plan, and they may change before the first release.

## License

[MIT](./LICENSE)
