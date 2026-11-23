# Set up fleetrc with an agent

This guide is for a coding agent setting up fleetrc for its user. fleetrc keeps one config in a git repository and links the user's skills, instruction files, subagents, commands, MCP servers and agent hooks into every agent they use, on every machine. The [README](../README.md) describes the config format and commands.

Change nothing until step 4, and push nothing the user hasn't seen.

## 1. Pick the CLI

Check that Node.js is 22.12 or newer and that git is installed. `gh` is optional; it helps find, create and clone the user's GitHub repository.

If the official `fleetrc` npm package and its schema are available, use `npx fleetrc@<version>` and read `https://unpkg.com/fleetrc@<version>/schema.json` with that same version. Use a CLI that reports both `sync.files.replaced` and `sync.previewLimitations` in the JSON init preview, even when they are empty.

If there's no usable release, ask before building from source: in a separate checkout of https://github.com/onmax/fleetrc that contains this guide, use the pnpm version in its `package.json`, run `pnpm install --frozen-lockfile --ignore-scripts` and `pnpm build`, and use `node <absolute-path-to-checkout>/dist/cli.mjs` wherever this guide says `npx fleetrc`. Read `schema.json` from that same checkout.

Use only the fields your schema defines.

## 2. Look at the current setup

Read only; change nothing yet.

- Run `npx fleetrc agents` to see the installed agents and the folders each one reads.
- List the skills in those folders (a skill is a folder with a `SKILL.md`), and note which are links and where they point.
- Find the user-level instruction files (such as `~/.claude/CLAUDE.md` and `~/.codex/AGENTS.md`), subagents (`~/.claude/agents`), commands (`~/.claude/commands`) and MCP servers (`~/.claude.json`, `~/.codex/config.toml`).
- If `gh` is available and signed in, list the user's GitHub repositories that hold skills, dotfiles or agent config.

## 3. Ask the user

Show what you found, then ask everything you still need in one message:

- Which repository holds the config: one of theirs, or a new private one you create? Where should its working clone live on this machine?
- Which of their current skills, instruction files, subagents, commands and MCP servers go into it?
- Which other skills to add: any GitHub repository (all of its skills, or only some), an npm package, or a site that serves `/.well-known/agent-skills/index.json`? Should their updates wait for review?
- Is there a team config to extend?
- Should every installed agent get them, or only some?
- Should other machines sync too, as SSH hosts or Tailscale tags? Which servers have no agent and need the timer?

Wait for the answers.

## 4. Write and push the config

In the working clone, write `.fleetrc/manifest.json` and copy only the selected hand-made skill folders, instruction files, subagents and commands. Keep the originals in place for now.

- Use a git source for those files, with `path` pointing to the working clone (prefer a portable `~/…` path) and globs or per-agent mappings for the selected files. Leave `adopt` off: it can move unselected skills even if you set `include`.
- For the selected MCP servers, write a separate file for the source's `mcp` field and use `${VAR}` placeholders, never secret values. Do not copy whole agent config files.
- Show the user the exact files and destination repository before pushing. Check the staged diff for secrets and unrelated changes, then commit and push only the approved files.
- Make sure the manifest and files are reachable from the repository ref you'll pass to `init`.

## 5. Preview

Run `npx fleetrc init <repository> --dry-run --json`. Keep the same link or copy mode for every preview and for the real `init`.

A preview passes only if it exits successfully, has `sync.ok: true`, and has empty `sync.errors` and `sync.previewLimitations` lists. If `sync.previewLimitations` is missing or nonempty, the destination lists are not enough for approval: an incoming skill update can refresh copies, and an edit taken from one copy can propagate to the source and other agents. Explain why the preview is incomplete and stop. If this is the second preview, first undo the manual changes as described in step 6.

Check migrations, warnings and changes in `sync.skills`, `sync.files` and `sync.entries`. Show the user the changes and conflicts by destination, without displaying secrets. Stop if you can't establish that unselected items will be left alone.

- **Skills.** For each `sync.targets` entry, use its `dir` and the names in `created`, `replaced` and `removed` to show which destinations will change, even if the overall skill list stays the same.
- **Files.** Check `sync.files.replaced` for relinks, copy overwrites and changes between copies and links. Cross-check each destination in `sync.files.links` against the manifest and source mapping: compare existing link targets or copy contents with the actual planned source, not a stale cached copy. For a managed copy, `npx fleetrc list --json` reports its recorded source under `files[].target`; a different planned source path can trigger a rewrite even if both files have identical bytes. Show the old and planned source paths and whether `init` will link or copy each changed file. Stop if the replacement report is missing or you can't determine the planned source or destination change.
- **Manual steps.** Include them in the approval plan: clearing occupied destinations for selected files, and removing selected same-name MCP entries listed in `sync.entries.foreign` or `sync.entries.held`. Neither status proves a replacement is available. Before removing anything, confirm the intended source definition can be translated for that agent and that its variables resolve in the agent's launch environment. Leave the original in place if source or translation warnings prevent the replacement, or if you can't confirm it. Name each original path, the MCP entry name where applicable, and a private local backup path outside the repository and agent folders.

Wait for the user's approval.

## 6. Apply

1. Move only the approved file conflicts to their backups. Back up affected MCP configs privately, then remove only the approved conflicting server entries in place, preserving all other servers and settings.
2. Rerun the JSON preview and repeat every check from step 5, including per-target skill changes, file link and copy comparisons, and the expected additions at cleared destinations. If a check fails, an expected addition is missing, or the plan differs from what the user approved, undo the manual changes and stop. Restore only the entries you removed, not whole config files, and do not overwrite newer changes.
3. Otherwise run the same `init` command without `--dry-run`, keeping `--json`. Check the exit status and the applied `sync` report for errors, warnings and skipped writes (`sync.entries.skipped`). Keep the backups.
4. Verify each selected skill and file is managed at its destination, and each selected MCP server matches the intended definition in the live agent config, without printing secrets. Use `npx fleetrc list` to check ownership, not as proof of a live entry.
5. Report failed, skipped or missing replacements as incomplete, restore missing originals from the backups without overwriting unrelated settings or newer changes, and ask before continuing.

## 7. Finish

- Run `npx fleetrc doctor` and tell the user the result.
- If they use Codex, tell them to open `/hooks` once to approve the hook.
- If they named other machines, offer to run `npx fleetrc fleet init <host-or-tag>` for each, adding `--timer` only where they asked for it. With a source build, remote enrollment also needs an installable package: set `FLEETRC_PACKAGE` to an approved tarball URL the hosts can reach, or defer remote enrollment until a release is available.
