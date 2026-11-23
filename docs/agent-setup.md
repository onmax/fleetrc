# Set up fleetrc with an agent

You are setting up fleetrc on every machine your user picks. fleetrc keeps one config in a git repository and links the user's skills, instruction files, subagents, commands, MCP servers and agent hooks into every agent on every machine.

You work from the machine you run on, the **controller**, and reach the others over SSH, by host name or as Tailscale `tag:<name>` peers. Steps 1 to 4 only read. Each later step changes only what the user approved, and a machine that fails a check is **left out**: you skip the rest of the steps for it and report why at the end.

For the manifest format, read the README's [Quick start](../README.md#quick-start) and the schema from step 1.

## 1. Pick the CLI

Check that the controller has Node.js 22.12 or newer and git. `gh` is optional; it helps find, create and clone the user's GitHub repository.

Use `npx fleetrc@<version>` from the latest npm release, and read `https://unpkg.com/fleetrc@<version>/schema.json` at that same version. Every machine runs that version.

The release must report `sync.files.replaced` and `sync.previewLimitations` in the JSON init preview, even when they are empty. If none does, ask the user before building from source: in a separate checkout of https://github.com/onmax/fleetrc that contains this guide, use the pnpm version in its `package.json`, run `pnpm install --frozen-lockfile --ignore-scripts` and `pnpm build`, and run `node <absolute-path-to-checkout>/dist/cli.mjs` wherever this guide says `npx fleetrc` on the controller. Read `schema.json` from that checkout. The other machines then need `FLEETRC_PACKAGE` set to a tarball URL the user approves and the hosts can reach; without one, set up only the controller.

Write only fields your schema defines.

**Done when** you have one CLI command and its matching schema.

## 2. Look at the controller and list the machines

- Run `npx fleetrc agents` to see the installed agents and the folders each one reads.
- List the skills in those folders (a skill is a folder with a `SKILL.md`), and note which are links and where they point.
- Find the user-level instruction files (such as `~/.claude/CLAUDE.md` and `~/.codex/AGENTS.md`), subagents (`~/.claude/agents`), commands (`~/.claude/commands`) and MCP servers (`~/.claude.json`, `~/.codex/config.toml`).
- If `gh` is signed in, list the user's GitHub repositories that hold skills, dotfiles or agent config.
- List candidate machines: hosts in `~/.ssh/config`, and peers and tags from `tailscale status` when Tailscale is installed.

**Done when** you have an inventory of the controller and a list of candidate machines.

## 3. Ask the user

Show the inventory, then ask everything you still need in one message:

- Which machines sync: SSH hosts, Tailscale tags, or both? Which are servers with no agent that need the timer?
- Which repository holds the config: one of theirs, or a new private one you create? Where does its working clone live on the controller?
- Which of their current skills, instruction files, subagents, commands and MCP servers go into it?
- Which other skills to add: a GitHub repository (all of its skills, or some), an npm package, or a site that serves `/.well-known/agent-skills/index.json`? Do their updates wait for review?
- Is there a team config to extend?
- Do all installed agents get them, or only some?

**Done when** the user has answered every question.

## 4. Look at the other machines

For each machine the user named (each peer, for a tag), over SSH:

- Confirm you connect without a password prompt, and that Node.js 22.12 or newer and `npx` are on the `PATH` an SSH command gets. A machine that fails is left out until the user fixes it.
- Run `npx fleetrc@<version> agents` and take the same inventory as in step 2.

Show the user what each machine has that the controller lacks, and ask which of it goes into the config.

**Done when** every named machine is reachable or left out, and the user has chosen what to add from each.

## 5. Write and push the config

In the working clone, write `.fleetrc/manifest.json`. Copy in only the selected hand-made skill folders, instruction files, subagents and commands, from whichever machine holds them. The originals stay where they are until step 7.

- Add one git source for those files: `path` points to the working clone (prefer a portable `~/…` path), with globs or per-agent mappings for the selected files. Keep `adopt` unset, because it can move unselected skills into the clone, even with `include`.
- Put the selected MCP servers in a separate file for the source's `mcp` field, one entry per server, with `${VAR}` placeholders where the originals hold secrets.
- Keep `fleet` empty; step 8 fills it.
- Show the user the exact files and the destination repository. Check the staged diff for secrets and unrelated changes, then commit and push only the approved files.

**Done when** the pushed ref you'll pass to `init` contains the manifest and every selected file.

## 6. Preview every machine

On the controller, and over SSH on each other machine, run `npx fleetrc init <repository> --dry-run --json`. A machine uses the same link or copy mode for every preview and its real `init`.

A preview **passes** when it exits 0 with `sync.ok: true` and empty `sync.errors` and `sync.previewLimitations`. A missing or nonempty `sync.previewLimitations` means the destination lists don't show everything that will change: an incoming update can refresh copies, and an edit taken from one copy can spread to the source and other agents. Tell the user why and leave that machine out.

For a passing preview, check migrations, warnings and changes in `sync.skills`, `sync.files` and `sync.entries`, and show the user the changes and conflicts by machine and destination, with secrets hidden:

- **Skills.** For each `sync.targets` entry, list its `dir` and the names in `created`, `replaced` and `removed`, even when the overall skill list stays the same.
- **Files.** Check `sync.files.replaced` for relinks, copy overwrites and switches between copy and link. For each destination in `sync.files.links`, compare the current link target or copy contents with the planned source from the manifest, not a cached copy. For a managed copy, `npx fleetrc list --json` gives its recorded source under `files[].target`; a new source path rewrites the copy even when the bytes match. Show the old and planned source and whether `init` will link or copy.
- **Manual steps.** Plan two kinds: moving files out of occupied destinations, and removing selected same-name MCP entries listed in `sync.entries.foreign` or `sync.entries.held`. Neither status proves a replacement exists. Plan a removal only after you confirm the source definition translates for that agent and its variables resolve in that agent's launch environment on that machine. For each step, name the machine, the original path, the MCP entry where applicable, and a private backup path on that machine outside the repository and agent folders.

Leave a machine out when you can't show that its unselected items stay untouched, or can't tell what each changed destination will point to.

**Done when** the user has approved one plan that covers every machine still in.

## 7. Clear conflicts

On each machine with manual steps:

1. Move the approved file conflicts to their backups. Back up each affected MCP config, then remove only the approved server entries in place.
2. Rerun the preview and every check from step 6, and confirm the cleared destinations now show the expected additions.

If a check fails or the plan differs from the approved one, **roll back** that machine and leave it out. Rolling back restores only the files and entries you moved or removed, and keeps any newer change to those configs.

**Done when** every machine still in has a passing preview that matches the approved plan.

## 8. Apply

1. On the controller, run its `init` command without `--dry-run`, keeping `--json`.
2. From the controller, run `npx fleetrc fleet init <host-or-tag>...` for the other machines still in, with the mode from their previews and `--timer` only where the user asked for it. It runs `init` on each and adds them to `fleet` in the working clone. Commit and push that change, then run `npx fleetrc sync`.
3. For every machine, check the exit status and the applied `sync` report for errors, warnings and skipped writes (`sync.entries.skipped`). Confirm each selected skill and file is managed at its destination, and each selected MCP server in the live agent config matches its definition, without printing secrets. `npx fleetrc list` shows ownership; the live agent config shows the entry.
4. On a machine with a failed, skipped or missing replacement, roll back the originals it lost, report it as incomplete, and ask before continuing there.

Keep the backups.

**Done when** each machine is verified or reported as incomplete.

## 9. Report

Run `npx fleetrc doctor` and `npx fleetrc fleet status` on the controller. Tell the user, by machine, what synced, what is incomplete, and what was left out and why. If they use Codex, tell them to open `/hooks` once on each machine to approve the hook.
