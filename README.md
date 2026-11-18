# Clonelane

**Keep your Git workspaces in the same lane.**

Clonelane (클론레인) manages multiple clones and linked worktrees of one repository. See every local branch, advance your base branches without discarding local work, and share selected local environment variables.

Version 0.1.0, an early release: the CLI and library API may still change before 1.0. See [CHANGELOG.md](CHANGELOG.md).

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

Clonelane serializes its own writes with a lock in the shared Git directory. Other Git clients and AI agents do **not** honor that lock. Stop concurrent writers before syncing. The tool rechecks the checkout before mutation, but cannot guarantee protection against a different process changing it at exactly the same time. A crash can leave a stale lock: inspect running processes before removing it.

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
- Keys that exist only in the target (or are not selected) remain local, such as `PORT` or a test account. Nothing is deleted.
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

An Electron window over the same core: workspace overview with every local branch and a commit graph, register (folder picker), rename / regroup / remove (registry only; folders are never touched), fetch, sync preview → apply, and env plan → apply. It uses the CLI's registry by default and follows the same rules: **Apply** is enabled only after a preview with identical options, applying sync fetches first, and env screens show key names and states only. Errors are sanitized like the CLI.

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

1. Explicit workspace leases for cooperating tools, a recovery journal and better per-workspace failure reporting.
2. Reviewed, persisted sync policies and a background worker. No unattended rebase in this release.
3. Environment profiles, layered overrides and a provider interface for an existing encrypted secret manager / OS keychain. No custom cryptography.
4. TUI overview, optional editor integration and support for intentionally stacked feature branches.

MIT licensed. No telemetry and no automatic package publication.
