# Set up fleetrc with an agent

You are setting up fleetrc on the machines your user picks. Learn the primitives below, ask the user the questions in the next section, then build the config. For anything this page leaves out, read the linked code and [`schema.json`](https://github.com/onmax/fleetrc/blob/main/schema.json).

## Primitives

- **Manifest**: `.fleetrc/manifest.json` in a git repository, usually the user's own skills repo. Every machine points at it with `fleetrc init <repo>`. Fields: [`schema.json`](https://github.com/onmax/fleetrc/blob/main/schema.json); loading and `extends`: [`manifest.ts`](https://github.com/onmax/fleetrc/blob/main/src/manifest.ts).
- **Source**: where items come from: `git`, `npm`, `index` (`/.well-known/agent-skills/index.json`) or `local`. A source carries skills (`skills`, `include`, `exclude`, `update: "review"`) and can also carry user-level `instructions`, `subagents` and `commands` (linked as they are), an `mcp` file in Claude Code format that is translated into each agent's config, and `agentHooks`. See [`sources.ts`](https://github.com/onmax/fleetrc/blob/main/src/sources.ts), [`files.ts`](https://github.com/onmax/fleetrc/blob/main/src/files.ts) and [`mcp.ts`](https://github.com/onmax/fleetrc/blob/main/src/mcp.ts).
- **Working clone**: a git source's `path`, the user's own checkout. Edits there are the source. `adopt: true` moves hand-made skills found in agent folders into it.
- **Extends**: a team manifest whose sources are inherited. It can't run commands on the machine.
- **Agents**: every installed agent, or a list of ids. `fleetrc agents` prints each agent's folders ([`agents.ts`](https://github.com/onmax/fleetrc/blob/main/src/agents.ts)).
- **Controller and fleet**: you run on the controller. `fleet` lists SSH hosts and Tailscale `tag:<name>` peers; `fleetrc fleet init <host>` runs `init` on each over SSH and adds it to `fleet` ([`fleet.ts`](https://github.com/onmax/fleetrc/blob/main/src/fleet.ts)).
- **Sync**: `init` installs session-start hooks in Claude Code and Codex. Machines with no agent use `--timer` instead.
- **Preview**: `fleetrc init <repo> --dry-run --json` reports what that machine would gain, replace and migrate (`sync.skills`, `sync.files`, `sync.entries`, `sync.previewLimitations`). See [`init.ts`](https://github.com/onmax/fleetrc/blob/main/src/init.ts) and [`report.ts`](https://github.com/onmax/fleetrc/blob/main/src/report.ts).

## Questions for the user

First look at the controller: installed agents, their skills, user-level instruction files, subagents, commands and MCP servers, the machines in `~/.ssh/config` and `tailscale status`, and (with `gh`) the user's repositories that hold skills or agent config. Then ask, in one message:

1. **Machines.** Which hosts or Tailscale tags sync? Which have no agent and need the timer?
2. **Repository.** Which repository holds the manifest: an existing one or a new private one? Where does its working clone live?
3. **Own items.** Which current skills, instruction files, subagents, commands and MCP servers go in? Once you can reach the other machines, show what they have that the controller lacks and ask again.
4. **Outside skills.** Which GitHub repos, npm packages or skill indexes to add, all of their skills or only some? Should updates wait for review?
5. **Team.** Is there a team manifest to extend?
6. **Agents.** Every installed agent, or only some?
7. **Secrets.** Which environment variables do the MCP servers need, and are they set where each agent starts on every machine?
8. **Conflicts.** When a destination is already taken, back it up and replace it, or keep it?

## Rules

- Change nothing until the user has answered.
- Put secrets in the `mcp` file as `${VAR}`. Before you push, show the user the files and the staged diff.
- Before `init` on any machine, run its preview and show the user what changes there, machine by machine. Apply only what they approve, with the same manifest and flags as the preview, and back up anything you move or remove.
- Apply on the controller first and verify it. Then run `fleet init` one approved host per call, never a `tag:` (a tag resolves again when it runs). Its `--json` summary leaves out warnings, so read each host's `last-run.json` too.
- Trust a preview only when `sync.previewLimitations` is present and empty. Otherwise copies may change in ways it doesn't list: tell the user and skip that machine. If the npm release doesn't report that field, ask before building from source (`pnpm install --frozen-lockfile --ignore-scripts && pnpm build`, then `node dist/cli.mjs`); other machines then need `FLEETRC_PACKAGE` set to a package they can install.
- Leave `adopt` off unless the user wants every hand-made skill moved into the working clone.

## Finish

Run `fleetrc doctor` and `fleetrc fleet status`, check that each selected item is live in each agent, and report by machine what synced, what didn't and why. Codex users open `/hooks` once per machine to approve the hook.
