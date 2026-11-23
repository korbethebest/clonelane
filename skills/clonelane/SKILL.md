---
name: clonelane
description: Coordinate work across several local clones or worktrees of one Git repository with the clonelane CLI. Use when a repository has more than one checkout registered in Clonelane, when you need a checkout of your own to work in without disturbing other agents or people, when you must bring checkouts up to date with their base branch, or when you must copy .env keys between checkouts.
---

# Clonelane

Clonelane keeps several clones and worktrees of one repository in step: it shows their state, fast-forwards them to their base branch, copies `.env` keys between them, and lets one agent or person lease a checkout so the others leave it alone. It never pushes, never stashes and never resets.

If the `clonelane` MCP tools are available (`here`, `claim`, `lease_take`, `lease_release`, `status`, `sync`, `env_sync`, ...), you may call them instead of the commands below; they take the same options, and the changing ones preview unless you pass `dry_run: false`.

Every command prints JSON. On failure it prints `{"error": CODE, "message": ...}` to stderr and exits with 1; read the code and the message, and do not retry blindly.

## Who you are

Use one holder name for the whole task: letters, digits, `.`, `_`, `@` and `-`, such as `claude`, `codex-2` or `gemini@fix-login`. Set it once:

```sh
export CLONELANE_HOLDER=codex-2        # PowerShell: $env:CLONELANE_HOLDER = "codex-2"
```

It is then the default for `--holder` and `--as`. Pass `--holder` / `--as` instead if you cannot set environment variables.

## Start of a task

1. Find out where you are: `clonelane here`. It prints the workspace name, group, path, base branch and any lease. `NOT_A_WORKSPACE` means the folder is not registered: ask the user before registering anything.
2. If you are already in the checkout the user gave you, lease it: `clonelane lease take --note "<task in a few words>"`.
3. If you need a checkout of your own (the user asked for parallel work, or the current one is leased by someone else), claim one: `clonelane claim --note "<task>"` (add `--group <group>` outside a workspace). It leases a workspace with no lease and nothing uncommitted, and prints its `path`. Work only in that path. `NO_FREE_WORKSPACE` means every checkout is busy: tell the user instead of taking one that is in use.

Leases last 120 minutes by default (`--minutes` up to 7 days). For a long task, renew before it lapses by running `clonelane lease take` again with the same holder: the note is kept.

## While working

- State of every checkout in the group: `clonelane status --group <group> --json`. It reads cached remote refs and does not fetch.
- Bring checkouts up to their base branch: preview with `clonelane sync --group <group> --dry-run`, then `clonelane sync --group <group>`. Sync only fast-forwards; it skips dirty checkouts, Git operations in progress and checkouts leased by others (`"reason": "leased"`), and reports them instead of failing. `--rebase` rebases only an unpublished, linear current feature branch; use it only when the user asked for a rebase.
- Copy `.env` keys: preview with `clonelane env sync <profile> --dry-run` (profiles: `clonelane env profile list`), then run it without `--dry-run`. Output shows key names and states, never values. Changing or removing an existing key needs `--overwrite`: ask the user first.
- Undo a branch move Clonelane made: `clonelane history --json` lists them; `clonelane restore <id> --dry-run`, then without `--dry-run`.

## End of a task

Release what you leased: `clonelane lease release` (in that checkout) or `clonelane lease release <workspace>`. Leave your commits and branches in place; Clonelane does not push, and neither should you unless the user asked.

## Rules

- A lease held by someone else means someone is working there. Do not edit files in that checkout, do not pass `--force` to `lease release`, and do not pass their name to `--as`.
- `LEASED` from env or restore means the target is in use: report it, do not work around it.
- Never print, log or copy `.env` values yourself; let `clonelane env` move them.
- Do not register, rename or remove workspaces, or save env profiles, unless the user asked.
