# Clonelane

**Keep your Git workspaces in the same lane.**

Clonelane (클론레인) manages multiple clones and linked worktrees of one repository. See every local branch, advance your base branches without discarding local work, and share selected local environment variables.

Version 0.5.0, an early release: the CLI and library API may still change before 1.0. See [CHANGELOG.md](CHANGELOG.md).

## Install

Requires **Node.js 24+** and **Git 2.38+**.

```sh
npm install --global clonelane
clonelane --help
# or run it without installing:
npx clonelane --help
```

No runtime dependencies. Both an importable TypeScript library and a CLI are provided. The desktop app runs from source; see [Desktop app](#desktop-app).

## Register workspaces

Registration reads Git metadata and writes a local registry. It never reads `.env` values.

```sh
clonelane register /code/project-a --name a --group project --base master
clonelane register /code/project-b --name b --group project --base master
clonelane status --group project
```

The default registry is `~/.config/clonelane/registry.json`. Use `--config /path/to/registry.json` on any command to choose another. Store it outside Git: it contains machine-specific paths. Remote credentials and environment values are not stored there. SSH and HTTPS URLs for the same host/path are grouped together; custom SSH aliases must currently match explicitly. Repository moves or remote changes require registration to be revisited.

Clone paths are canonicalized. Names and paths must be unique. Every member of a group must have the same repository identity and base branch. The default remote is `origin`, or the only remote when a repository has exactly one; choose another with `--remote`. A missing remote is reported with the available remote names.

`status` displays each workspace's current branch, dirty state, ongoing Git operations and ahead/behind counts against the cached remote base. It also lists **all local branches and their upstream counts**, including branches that are not currently checked out. `--json` exposes the same information to other tools.

## Preview and sync

```sh
clonelane fetch --group project
clonelane sync --group project --dry-run
clonelane sync --group project
clonelane sync --group project --dry-run --rebase
clonelane sync --group project --rebase
```

`status` and `sync --dry-run` are read-only and do not contact remotes. Their view can be stale: `fetch` first when you want a fresh preview. `sync` without `--dry-run` fetches the selected base branch before applying changes. A newly advanced remote can make execution differ from a previous preview.

Separate clones of the same repository contact the remote only once per fetch: the first clone fetches, and the others copy its fresh base branch over the local disk, which skips the network and the credential helper. The result says which clone each copy came from (`source`). If a copy fails, that clone fetches from its own remote.

Each workspace is fetched and synced on its own: one failure (an unreachable remote, rejected credentials, a missing base branch, a stale `.lock` file) is reported for that workspace with a short next step, and the others continue. `fetch`, `sync` and `status` exit with code 1 when any workspace failed. Git's own output is never printed, because it can contain credentials; failures are matched to known kinds instead (`GIT_AUTH`, `GIT_NETWORK`, `GIT_REMOTE_REF`, `GIT_REMOTE_MISSING`, `GIT_LOCKED`, `GIT_LOCAL_CHANGES`, `GIT_CONFLICT`, `GIT_TIMEOUT`, `GIT_OUTPUT_TOO_LARGE`, `GIT_NO_FOLDER`, `GIT_NOT_REPO`), with `GIT_FAILED` for anything else.

| Workspace state | Behavior |
| --- | --- |
| Clean, on `master`/configured base | Fast-forward only |
| Local base has unique commits | Skip; no reset or merge commit |
| Clean, on a feature branch | Advance unused local base without switching branches |
| Base checked out in another linked worktree | Leave its ref to that worktree; register its owner too |
| Feature branch, no `--rebase` | Keep feature checkout unchanged |
| Feature branch with `--rebase` | Rebase current unpublished, linear branch onto fetched base |
| Feature has an upstream, appears in remote refs, or contains merge commits | Skip rebase |
| Dirty or active merge/rebase/cherry-pick/revert/bisect | Skip checkout mutations |
| Detached HEAD | Skip checkout mutations |
| The base adds a path that already exists locally (for example an ignored `.env`) | Skip, so Git never overwrites it |

Only the **current feature branch** of each registered directory is rebased. Unchecked feature branches are listed but not rewritten. `baseUpdate` in the JSON result reports updates to an unused local base independently from the feature checkout result. No command stashes changes, pushes, force-pushes, resolves conflicts automatically, or switches your current branch.

Before a branch update, Clonelane creates a recovery ref under `refs/clonelane/backups/`. The JSON result includes that ref. After a failed rebase it attempts `git rebase --abort`; a failure to abort is reported as requiring manual recovery. Create a rescue branch from the reported backup with ordinary Git, after inspecting the workspace. Backups are retained until you deliberately remove them.

Every branch move is also recorded in a journal inside the clone's shared `.git` directory (`clonelane-journal.jsonl`, never committed):

```bash
clonelane history --group project          # moves, their backups and outcomes
clonelane restore 1a2b3c4d5e6f7a8b --dry-run  # what a restore would do
clonelane restore 1a2b3c4d5e6f7a8b            # move the branch back to its backup
```

`restore` moves a branch back only when it is still exactly where that move left it, the workspace has no uncommitted changes or Git operation in progress, and the backup ref is intact. Otherwise it refuses and says why. Git holds the branch's ref lock from that check until the move, so a commit made by another tool at the same moment fails instead of being dropped. It backs up the current tip first and is journaled itself, so a restore can be undone the same way. A move that started but never recorded an outcome (the process was killed) shows as **interrupted** in `status`, `history` and the desktop app.

Clonelane serializes its own writes with a lock in the shared Git directory. Other Git clients and AI agents do **not** honor that lock. Stop concurrent writers before syncing. The tool rechecks the checkout before mutation, but cannot guarantee protection against a different process changing it at exactly the same time. A crash can leave a stale lock: inspect running processes before removing it.

## Leases: mark a workspace as in use

When a person, a script or an agent is working in a clone, lease it so Clonelane leaves it alone:

```sh
clonelane lease take b --holder agent-1 --note "feat/login" --minutes 120
clonelane lease list
clonelane lease release b --holder agent-1
```

- While someone else holds a lease, `sync` skips that workspace entirely (`leased`: not fetched, base ref untouched), and `env` and `restore` refuse it (`LEASED`). Pass `--as agent-1` to act as the holder on your own leased workspace.
- The same holder taking it again renews it (the note stays unless a new one is given). A lease lapses on its own after `--minutes` (default 120, at most 7 days), so a holder that crashed never blocks forever. `lease release --force` clears someone else's.
- A lease is per checkout (each worktree has its own), stored as `clonelane-lease.json` in that checkout's `.git` directory. It is advisory: Git, editors and other tools ignore it, and holder names are not authenticated. Worktrees of one clone share its remote-tracking refs, so fetching an unleased sibling worktree still moves them. An unreadable lease file counts as held until `--force`.
- `status` shows the holder; the library adds `takeLease()`, `releaseLease()`, `readLease()`, `workspaceLease()`, `claimWorkspace()`, `workspaceAt()` and `WorkspaceStatus.lease`.
- In the desktop app, **Lease…** on a card takes one, **Renew** adds two hours, and **Release…** gives it back.

## Coding agents

Give each agent (Claude Code, Codex, Gemini CLI or any tool that reads Agent Skills) a checkout of its own and a skill that tells it how to use Clonelane:

```sh
clonelane agent install            # ~/.claude/skills and ~/.agents/skills; --project for the current folder
export CLONELANE_HOLDER=codex-1    # the agent's name: default --holder and --as
clonelane claim --note "fix login" # lease a free workspace in this group and print its path
clonelane here                     # which workspace this folder is, and its lease
clonelane lease release            # done: give back the one this folder is in
```

- `claim` picks a workspace in the group (by default the current folder's) with no lease, nothing uncommitted, no Git operation and no interrupted update, and leases it. A holder that already has one gets it back, renewed, so a retried claim never takes two. Concurrent claims are settled under the clone's lock. `NO_FREE_WORKSPACE` means every one is busy.
- `lease take` and `lease release` without a workspace name use the one the current folder is in.
- The skill (`skills/clonelane/SKILL.md` in the package) tells an agent to lease before working, to stay out of checkouts others hold, to preview before syncing, and to ask before overwriting `.env` keys. Run `agent install` again after upgrading; it replaces the installed copy.
- `CLONELANE_HOLDER`, like any holder name, is not authenticated: it keeps cooperating agents apart, it does not stop one that ignores it.

## Share `.env` keys

```sh
# Every key the source file defines (the desktop app's default):
clonelane env plan --source a --target b --all-keys
clonelane env apply --source a --target b --all-keys
# Or only selected keys:
clonelane env plan --source a --target b --keys API_URL,API_TOKEN
clonelane env apply --source a --target b --keys API_URL,API_TOKEN
# Only after reviewing conflicting key names:
clonelane env apply --source a --target b --keys API_URL,API_TOKEN --overwrite
```

Both workspaces must be registered in the same group. The selected filename defaults to `.env`; `--file .env.development` is supported. Directory components and arbitrary filenames are rejected.

- Choose `--all-keys` or `--keys` explicitly; a missing selection is an error, never an implicit "all".
- Keys that exist only in the target (or are not selected) remain local, such as `PORT` or a test account. Nothing is deleted unless you ask for `--prune` (below).
- Preview shows names and `add` / `same` / `conflict`, never values or value hashes.
- Different existing values block application unless `--overwrite` is explicit.
- Missing source keys fail the whole operation for that target; no implicit deletion.
- Both source and target must be Git-ignored and untracked, even if the target file does not yet exist.
- Symlinks, hard-linked files and nonregular files are rejected.
- Writes use an exclusive temporary file, flush and rename; source and target are compared again before replacement.
- Applying normalizes ordering and quoting. **Comments, duplicate definitions and formatting are not retained.** Review this before adopting the writer for hand-maintained files.
- Parsing follows Node's dotenv grammar. Values are never evaluated by a shell. Serialization verifies a lossless value round trip and refuses unsupported values.

With `--keys`, names starting with `VITE_`, `NEXT_PUBLIC_` or `PUBLIC_` require an explicit acknowledgement. `--all-keys` mirrors the source file, which already exposes those keys, so it needs none; the desktop preview marks them as browser-exposed.

```sh
clonelane env plan --source a --target b --keys VITE_API_URL --public-keys VITE_API_URL
```

This is an acknowledgement that the value may be exposed to browsers, **not** a detector that can prove a value is safe. Never select server credentials as public variables. Do not put secret values in command-line arguments.

### Profiles: one source, the whole group, local overrides

A profile saves a share by name so a group of clones can be kept in step with one command. It stores key names only, in the registry, never values.

```sh
# Copy every key from a to the rest of its group, but b keeps its own PORT and DB_NAME:
clonelane env profile save dev --source a --all-keys --keep b:PORT,DB_NAME
clonelane env sync dev --dry-run    # one key-only plan per target
clonelane env sync dev              # write each target; --overwrite after reviewing conflicts
clonelane env profile list
clonelane env profile remove dev
```

- Targets are every other workspace in the source's group, at the time you run `env sync`, or only those named with `--targets b,c`. A named target that leaves the group is dropped from the list; a list left empty fails rather than widening to the whole group.
- Layers, highest first: a target's kept keys (`--keep <workspace>:KEY,…`, repeat per workspace) → the source's values → keys only the target has. Kept keys are never added or overwritten and show as `kept`.
- `--prune` (with `--all-keys`, on `env plan|apply` or saved in a profile) also removes target keys the source does not define, so the targets mirror the source. They show as `remove`, and like conflicts they are only applied with `--overwrite`. Kept keys are never removed, and an empty source file is refused rather than emptying the targets.
- Each target is planned and written on its own, with all the rules above. A conflict or error in one target is reported in its result and does not stop the others; the exit code is 1 if any target failed.
- `--keys`, `--public-keys` and `--file` work as for `env plan`, and are checked when the profile is saved. Browser-exposed keys need `--public-keys` even if some targets keep them, because the other targets (and workspaces that join the group later) receive them. With `--keys`, kept keys must be among them.
- `env sync --dry-run` takes no `--overwrite` and, like `env plan`, exits 0 when it finds conflicts.
- Renaming a workspace updates its profiles. Removing a profile's source, or moving it to another group, is refused until the profile is removed. A target that leaves the source's group loses its kept keys.

There is **no central plaintext secret database**: this version reads an explicitly chosen existing source `.env` and writes the target. It does not provide an encrypted vault, keychain integration or network secret sharing yet. The source and destination remain plaintext and readable to processes with filesystem access. POSIX files use mode `0600`; on Windows, inherited directory ACLs apply and must be appropriate. See [SECURITY.md](SECURITY.md).

## Desktop app

The app is not in the npm package yet. Run it from a clone of this repository (requires pnpm 10.32.1):

```sh
git clone https://github.com/korbethebest/clonelane.git
cd clonelane
pnpm install --frozen-lockfile
pnpm app
pnpm app --config=/path/to/registry.json
```

An Electron window over the same core: a first-run guide (reopen it from **Guide**), workspace overview with every local branch and a commit graph, leases (**Lease…** on a card takes one: holder, how long, an optional note; a leased card says who has it and until when, with **Release…**; Sync lists it under no change and env previews skip it), **Branch moves** per workspace (the recovery journal, with **Restore…**: a dry-run check, a confirmation, then the same restore as `clonelane restore`), register (folder picker), rename / regroup / remove (registry only; folders are never touched), **Reload local** (re-read Git state on disk, no network), **Fetch remote** (download the base branch), **Auto-fetch** (on by default: fetch remote every 15 minutes while the app is open, without locking the window; actions started meanwhile wait for it), sync preview → apply, and .env sharing: pick a source and the rest of its group is ticked as targets (untick any to share with only some), each with its own **Keep local** keys, then preview and apply them together. **Save profile** stores the form; **Open** on a saved profile fills it in and previews it. It uses the CLI's registry by default and follows the same rules: **Apply** is enabled only after a preview with identical options, applying sync fetches first, and env screens show key names and states only. Errors are sanitized like the CLI.

The interface is English only. Sync reasons from the core are shown through `app/labels.js`; `tests/labels.spec.ts` fails when the core adds a reason without a label.

The renderer runs sandboxed with context isolation and no Node access; it can only call the fixed actions in `app/handlers.js`.

The app lives in `app/` and is not part of the published package; Electron is a development dependency, so the library keeps zero runtime dependencies. `pnpm app` downloads the Electron binary on first run and verifies it against the checksums pinned in the locked `electron` package. Setting `electron_use_remote_checksums` (or its `npm_config_` form) makes the installer trust checksums fetched from the same mirror as the binary, which removes that independent check; avoid it, especially together with `ELECTRON_MIRROR`. Installers and code signing are not provided yet.

## Library

```ts
import {
  registerWorkspace,
  inspectWorkspace,
  fetchWorkspaces,
  syncWorkspaces,
} from "clonelane";

const workspace = await registerWorkspace({
  name: "api",
  group: "product",
  path: "/code/product-api",
  base: "main",
});

const status = await inspectWorkspace(workspace);
await fetchWorkspaces([workspace]);
const preview = await syncWorkspaces([workspace], { dryRun: true });
// Core sync never fetches implicitly; callers control network access.
const results = await syncWorkspaces([workspace]);
```

`planSync(status)` is a pure **checkout policy** helper. `syncWorkspaces(..., {dryRun: true})` additionally checks publication/topology and unused base refs; use that for a complete execution preview. Library consumers should log only safe result objects. Native filesystem errors can contain local paths; the CLI emits sanitized errors.

## Development

```sh
pnpm format
pnpm lint
pnpm typecheck
pnpm test
pnpm build
```

Integration tests create local bare repositories, clones and linked worktrees under `tests.local/`, with synthetic environment values. They use no Git hosting accounts or production repositories. Cleanup is restricted to each generated fixture. CI runs on Windows and Linux. See [CONTRIBUTING.md](CONTRIBUTING.md) before opening a pull request.

## Next milestones

1. Support for intentionally stacked feature branches.
2. Reviewed, persisted sync policies and a background worker. No unattended rebase in this release.
3. TUI overview and optional editor integration.

MIT licensed. No telemetry and no automatic package publication.
