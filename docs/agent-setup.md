# Set up fleetrc with an agent

This guide is for a coding agent setting up fleetrc across its user's machines. fleetrc keeps one config in a git repository and links the user's skills, instruction files, subagents, commands, MCP servers and agent hooks into every agent they use, on every machine. The [README](../README.md) describes the config format and commands.

You work from the machine you run on, the controller, and reach the other machines over SSH: by host name, or as Tailscale `tag:<name>` peers. Change nothing on any machine until step 5, and push nothing the user hasn't seen.

## 1. Pick the CLI

Check that Node.js is 22.12 or newer and that git is installed. `gh` is optional; it helps find, create and clone the user's GitHub repository.

If the official `fleetrc` npm package and its schema are available, use `npx fleetrc@<version>` and read `https://unpkg.com/fleetrc@<version>/schema.json` with that same version. Use a CLI that reports both `sync.files.replaced` and `sync.previewLimitations` in the JSON init preview, even when they are empty. Use the same version on every machine.

If there's no usable release, ask before building from source: in a separate checkout of https://github.com/onmax/fleetrc that contains this guide, use the pnpm version in its `package.json`, run `pnpm install --frozen-lockfile --ignore-scripts` and `pnpm build`, and use `node <absolute-path-to-checkout>/dist/cli.mjs` wherever this guide says `npx fleetrc` on the controller. Read `schema.json` from that same checkout. Other machines need an installable package too: set `FLEETRC_PACKAGE` to a tarball URL the user approves and the hosts can reach, or set up only the controller until a release is available.

Use only the fields your schema defines.

## 2. Look at the controller and find the machines

Read only; change nothing yet.

- Run `npx fleetrc agents` to see the installed agents and the folders each one reads.
- List the skills in those folders (a skill is a folder with a `SKILL.md`), and note which are links and where they point.
- Find the user-level instruction files (such as `~/.claude/CLAUDE.md` and `~/.codex/AGENTS.md`), subagents (`~/.claude/agents`), commands (`~/.claude/commands`) and MCP servers (`~/.claude.json`, `~/.codex/config.toml`).
- If `gh` is available and signed in, list the user's GitHub repositories that hold skills, dotfiles or agent config.
- List the machines the user might mean: hosts in `~/.ssh/config`, and peers and tags from `tailscale status` if Tailscale is installed.

## 3. Ask the user

Show what you found, then ask everything you still need in one message:

- Which machines should sync: SSH hosts, Tailscale tags, or both? Which of them are servers with no agent that need the timer?
- Which repository holds the config: one of theirs, or a new private one you create? Where should its working clone live on the controller?
- Which of their current skills, instruction files, subagents, commands and MCP servers go into it?
- Which other skills to add: any GitHub repository (all of its skills, or only some), an npm package, or a site that serves `/.well-known/agent-skills/index.json`? Should their updates wait for review?
- Is there a team config to extend?
- Should every installed agent get them, or only some?

Wait for the answers.

## 4. Look at the other machines

For each machine the user named (each peer, for a tag), over SSH and read only:

- Check that you can connect without a password prompt, and that Node.js 22.12 or newer and `npx` are on the `PATH` an SSH command gets.
- Run `npx fleetrc@<version> agents`, and list the skills, instruction files, subagents, commands and MCP servers there as in step 2.

Show the user what each machine has that the controller doesn't, and ask whether any of it goes into the config. Note machines you can't reach or that lack Node.js; leave them out until the user fixes them.

## 5. Write and push the config

In the working clone, write `.fleetrc/manifest.json` and copy only the selected hand-made skill folders, instruction files, subagents and commands, from whichever machine holds them. Keep the originals in place for now.

- Use a git source for those files, with `path` pointing to the working clone (prefer a portable `~/…` path) and globs or per-agent mappings for the selected files. Leave `adopt` off: it can move unselected skills even if you set `include`.
- For the selected MCP servers, write a separate file for the source's `mcp` field and use `${VAR}` placeholders, never secret values. Do not copy whole agent config files.
- Leave `fleet` out; `fleet init` adds the machines in step 8.
- Show the user the exact files and destination repository before pushing. Check the staged diff for secrets and unrelated changes, then commit and push only the approved files.
- Make sure the manifest and files are reachable from the repository ref you'll pass to `init`.

## 6. Preview every machine

On the controller, and over SSH on each other machine, run `npx fleetrc init <repository> --dry-run --json`. Keep the same link or copy mode for every preview and for the real `init` on that machine.

A preview passes only if it exits successfully, has `sync.ok: true`, and has empty `sync.errors` and `sync.previewLimitations` lists. If `sync.previewLimitations` is missing or nonempty, the destination lists are not enough for approval: an incoming skill update can refresh copies, and an edit taken from one copy can propagate to the source and other agents. Explain why the preview is incomplete and leave that machine out. If this is its second preview, first undo the manual changes there as described in step 7.

Check migrations, warnings and changes in `sync.skills`, `sync.files` and `sync.entries`. Show the user the changes and conflicts by machine and destination, without displaying secrets. Leave a machine out if you can't establish that unselected items there will be left alone.

- **Skills.** For each `sync.targets` entry, use its `dir` and the names in `created`, `replaced` and `removed` to show which destinations will change, even if the overall skill list stays the same.
- **Files.** Check `sync.files.replaced` for relinks, copy overwrites and changes between copies and links. Cross-check each destination in `sync.files.links` against the manifest and source mapping: compare existing link targets or copy contents with the actual planned source, not a stale cached copy. For a managed copy, `npx fleetrc list --json` reports its recorded source under `files[].target`; a different planned source path can trigger a rewrite even if both files have identical bytes. Show the old and planned source paths and whether `init` will link or copy each changed file. Leave the machine out if the replacement report is missing or you can't determine the planned source or destination change.
- **Manual steps.** Include them in the approval plan: clearing occupied destinations for selected files, and removing selected same-name MCP entries listed in `sync.entries.foreign` or `sync.entries.held`. Neither status proves a replacement is available. Before removing anything, confirm the intended source definition can be translated for that agent and that its variables resolve in the agent's launch environment on that machine. Leave the original in place if source or translation warnings prevent the replacement, or if you can't confirm it. Name each machine, original path, the MCP entry name where applicable, and a private local backup path on that machine outside the repository and agent folders.

Wait for the user's approval.

## 7. Clear conflicts

On each approved machine:

1. Move only the approved file conflicts to their backups. Back up affected MCP configs privately, then remove only the approved conflicting server entries in place, preserving all other servers and settings.
2. Rerun the JSON preview and repeat every check from step 6, including per-target skill changes, file link and copy comparisons, and the expected additions at cleared destinations. If a check fails, an expected addition is missing, or the plan differs from what the user approved, undo the manual changes on that machine and leave it out. Restore only the entries you removed, not whole config files, and do not overwrite newer changes.

## 8. Apply

1. On the controller, run the same `init` command as its preview without `--dry-run`, keeping `--json`. Check the exit status and the applied `sync` report for errors, warnings and skipped writes (`sync.entries.skipped`).
2. From the controller, run `npx fleetrc fleet init <host-or-tag>...` for the approved machines, with the same copy mode as their previews and `--timer` only where the user asked for it. It runs `init` on each host and adds the hosts to `fleet` in the working clone. Commit and push that change, then run `npx fleetrc sync` and `npx fleetrc fleet status`.
3. On every machine, verify each selected skill and file is managed at its destination, and each selected MCP server matches the intended definition in the live agent config, without printing secrets. Use `npx fleetrc list` to check ownership, not as proof of a live entry.
4. Keep the backups. Report failed, skipped or missing replacements as incomplete, restore missing originals from the backups without overwriting unrelated settings or newer changes, and ask before continuing.

## 9. Finish

- Run `npx fleetrc doctor` on the controller and `npx fleetrc fleet status`, and tell the user the results by machine.
- List the machines you left out and why.
- If they use Codex, tell them to open `/hooks` once on each machine to approve the hook.
