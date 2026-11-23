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

1. **Pin the CLI.** Before writing config, test a pinned npm package (`fleetrc@<version>`) with a scratch manifest in isolation. Its JSON preview must report `sync.files.replaced` and `sync.previewLimitations` as arrays. Use that version's packaged schema. If no release qualifies, get consent to build from a pinned source revision (`pnpm install --frozen-lockfile --ignore-scripts && pnpm build`); use that checkout's `schema.json` and `node <checkout>/dist/cli.mjs`, and run the same check. Use the selected build throughout. For SSH commands use `npx -y --package '<package>' -- fleetrc`, and set `FLEETRC_PACKAGE` to that exact package for `fleet init`: either the pinned release or an approved, fixed tarball URL for the same source build. Skip remote setup if the matching package is unavailable there.
2. **Approve publication.** Change no user configuration until the user answers. Copy only selected items, leave the originals in place, and leave `adopt` off unless the user wants all hand-made skills moved. Use `${VAR}` placeholders in MCP definitions, never secret values. Check the staged diff for secrets and unrelated changes before showing it. Get explicit approval of the exact files, diff, and destination repository/ref before committing and pushing. Use the approved manifest and source contents for preview and apply; if they change, re-preview and get approval again.
3. **Approve a passing preview per machine.** Run `init <repo> --dry-run --json` locally and directly over SSH (from `/`, like `fleet init`). Use explicit `--copy` or `--no-copy` on every preview and apply: this makes remote apply run `init` instead of the installed launcher's `sync`. Keep the other flags identical, including `--timer` where requested.

   Require exit `0`, `sync.ok: true`, a `sync.files.replaced` array, and present, empty `sync.errors` and `sync.previewLimitations` arrays. For a requested timer, also require a top-level `timer` plan without an error. If any check fails, skip the machine or get approval for a revised, passing plan.

   Review migrations, warnings and exact changes by destination in `sync.targets`, `sync.files` and `sync.entries`, including expected replacements after clearing conflicts. Hide secrets and stop if you can't show what will change or that unselected items will be left alone. Get explicit approval per machine, including manual changes and backup paths.
4. **Clear conflicts just before applying.** Back up only the approved files or config entries you move or remove, privately on that machine outside the repository and agent directories. For MCP, confirm the replacement translates for the target agent and its variables resolve in that agent's launch environment before removing an entry. After clearing conflicts, repeat the same preview. Require it to pass and show the expected replacements with no unapproved changes; otherwise restore only your manual changes and stop on that machine.
5. **Apply and verify.** On the controller, run its approved `init` without `--dry-run`. Check the command result and full `--json` sync report for errors, warnings and skipped writes. Verify the live skills, files and MCP definitions, and check any requested timer with `timer status`. Confirm the controller's saved config names the approved repository/ref. If the controller is skipped or incomplete, stop before clearing any remote conflicts or running `fleet init`.

   Use `fleet init <approved-ssh-destination> --json` with that host's previewed flags, one host at a time, never a `tag:` (it expands again at apply time). Before applying, record the host's existing `last-run.json` and avoid concurrent syncs. Check the per-host result, then read the full report from that host's fleetrc state directory and confirm it comes from this invocation. Check the report, live items and requested timer as on the controller.

   Keep backups; restore originals for failed replacements only once apply has stopped and you've rechecked the live destinations. After an SSH timeout or disconnect, mark the host incomplete and do not restore or retry until you confirm the remote apply stopped and inspect again.
6. **Publish only verified enrollments.** `fleet init` can add a host to the working manifest before verification. Exclude newly added entries for incomplete hosts without touching existing enrollments or unrelated edits. Apply the same diff, secret check and publication approval as above to the enrollment update.

## Finish

Run `fleetrc doctor` and `fleetrc fleet status`, check that each selected item is live in each agent, and report by machine what synced, what didn't and why. Codex users open `/hooks` once per machine to approve the hook.
