# Changelog

All notable changes to this project are documented here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses [Semantic Versioning](https://semver.org/). Until 1.0, minor versions may change the CLI and library API.

## [Unreleased]

## [0.6.0] - 2026-11-23

### Added

- `clonelane claim`: leases a free workspace in a group (no lease, nothing uncommitted, no Git operation) for a holder and prints its path, so parallel agents each get a checkout of their own. A holder's existing lease is renewed instead of taking a second workspace.
- `clonelane here` prints the workspace the current folder is in, with its lease; `lease take` and `lease release` without a workspace name use it.
- `CLONELANE_HOLDER` sets the default `--holder` and `--as`.
- `clonelane agent install [--claude] [--agents] [--project]` installs a Clonelane Agent Skill for Claude Code (`.claude/skills`) and for Codex, Gemini CLI and other tools that read `.agents/skills`.
- **Renew** on a leased card in the desktop app adds two hours as the same holder.
- Library: `claimWorkspace()` and `workspaceAt()`.
- `clonelane mcp`: an MCP server over stdio (no new dependencies) with `here`, `status`, `claim`, `lease_take`, `lease_release`, `lease_list`, `fetch`, `sync`, `env_profiles`, `env_sync`, `history` and `restore`. Changing tools preview unless called with `dry_run: false`. Checked with Claude Code and Codex.

### Changed

- Renewing a lease never shortens it: the later of its current end and the new one is kept.
- `claim` tries the current folder's workspace first when it is free.

## [0.5.0] - 2026-11-23

### Added

- Workspace leases: `clonelane lease take <workspace> --holder <name> [--note] [--minutes]`, `lease release [--holder] [--force]` and `lease list`. While another holder's lease is live, `sync` skips the workspace (`leased`) and `env` and `restore` refuse it (`LEASED`); `--as <holder>` acts as the holder. Leases lapse after their time (default 120 minutes), live per checkout in its `.git` directory, and are advisory. `status` shows the holder (`WorkspaceStatus.lease`); the library adds `takeLease()`, `releaseLease()`, `readLease()` and `workspaceLease()`.
- Leases in the desktop app: **Lease…** on a card takes one (holder, remembered for next time; 1 hour to 1 day; an optional note), and a leased workspace's card says who has it, why and until when, with **Release…** (a confirmed release of that holder's lease; an unreadable lease file is cleared). Sync previews list it under no change, and the Environment tab marks leased targets and skips them with a note instead of an error.

### Changed

- The desktop app's buttons share a minimum width (88px, 64px for small ones), so side-by-side actions such as Preview and Apply match; every disabled button looks the same whatever its variant; tabs are 36px like other controls, and every field uses 14px text. Only the content area scrolls: the header and status bar stay in place at full width, and the content keeps its scrollbar's space on every tab, so switching tabs no longer shifts anything.

## [0.4.0] - 2026-11-20

### Added

- Env profiles: `clonelane env profile save|list|remove` saves a named share (source workspace, file, keys, public-key acknowledgement) in the registry, key names only. `clonelane env sync <profile> [--dry-run] [--overwrite]` plans or writes every other workspace in the source's group, one at a time; a failing target is reported without stopping the others.
- The desktop app's Environment tab shares with the whole group by default: pick a source, and every other workspace of its group is ticked as a target (untick to share with only some), each with its own **Keep local** keys. One preview covers all targets; **Apply** writes them one at a time, and differing values or removals still need **Replace differing values and remove keys**. **Save profile** stores the form; **Open** on a saved profile fills it in and previews it.
- `env profile save --targets b,c` limits a profile to some workspaces of the group (`EnvProfile.targets`); without it a profile follows the group as it changes. `syncEnvProfile()` also accepts an unsaved profile.
- Removal sync: `--prune` (with `--all-keys`) on `env plan|apply` and `env profile save` also removes target keys the source lacks, except kept ones, and refuses an empty source (`ENV_SOURCE_EMPTY`) rather than emptying every target. Plans show them as `remove`; applying them needs `--overwrite`, like a conflict. In the desktop app: **Also remove keys the source doesn't have**.
- Layered overrides: `--keep <workspace>:KEY,…` keeps keys local in that target. Kept keys are never added or overwritten and show as `kept` in plans. The library adds `EnvOptions.keep`, `saveProfile()`, `removeProfile()` and `syncEnvProfile()`.

### Changed

- Renaming a workspace updates the env profiles that name it; removing a workspace that is a profile's source, or moving it to another group, is refused (`PROFILE_SOURCE`). A workspace that leaves a profile's group loses its kept keys there.
- The desktop app uses one control scale: buttons and fields are 36px, actions inside a row or card head are a 28px small size, and the underlined text button is gone. Env previews fold unchanged keys into one line and list only what changes.
- Help text in the desktop app moved from paragraphs into popovers behind a **?** button: hover to read, click to keep it open.
- With several groups, the desktop app's env source list is sectioned by group and follows the header's group filter.

## [0.3.0] - 2026-11-20

### Added

- **Auto-fetch** in the desktop app, on by default: while the app is open, it fetches remote once the shown workspaces were last fetched 15 or more minutes ago, then re-reads their status. The window stays usable; an action started meanwhile waits for the fetch to finish. New remote commits clear an unapplied sync preview, as **Fetch remote** does. Turn it off with the **Auto-fetch** checkbox in the header.
- **Branch moves** on each workspace card in the desktop app: the recovery journal (`clonelane history`) with a **Restore…** button on each branch's latest move. It checks first without changing anything, asks for confirmation, then restores with the same safeguards as `clonelane restore`; a refusal shows its reason. The interrupted-update warning now points there.

## [0.2.0] - 2026-11-20

### Added

- A first-run guide in the desktop app: three real steps (add a workspace, add another clone of the same repository, fetch and preview a sync) that check themselves off from what you actually did. It opens for new users only, can be hidden, and reopens from **Guide** in the header.

- Faster `fetch`: separate clones of one repository contact the remote once. The other clones copy the fresh base from that clone on disk (no network, no credential helper) and fall back to their own remote if that fails. `FetchResult.source` names the clone a copy came from. Checking a workspace before a fetch also starts one Git process fewer.
- Faster `status`: reading a workspace starts two Git processes instead of six. `status` in the CLI and the desktop app opt in (`inspectWorkspace(workspace, { reuseIdentity: true })`) to reuse a recent identity check while the `.git` entry and the repository and user Git config files are unchanged, for at most five minutes. Everything that changes a branch or a file checks in full. Ahead/behind counts are cached per commit pair, except in shallow clones. The desktop app shows the last known state at start while it reads the current one, with its controls disabled until then.
- A recovery journal. Every branch move `sync` makes is recorded with its backup ref and outcome in the clone's `.git` directory. `clonelane history` lists them, and `clonelane restore <id> [--dry-run]` moves a branch back to its backup when nothing has changed since; otherwise it refuses with a reason. Restores are backed up and journaled too.
- `status`, the desktop app and the library (`WorkspaceStatus.interrupted`) flag moves that started but never finished. The library exports `listOperations()` and `restoreOperation()`.

### Changed

- The desktop app's **Refresh** and **Fetch** buttons are now **Reload local** and **Fetch remote**, with tooltips that say which one uses the network.
- Failures say what went wrong and what to do next. Git's output is still never shown; it is matched to known kinds such as rejected credentials, an unreachable remote, a missing base branch or a stale `.lock` file, each with a fixed message.
- `fetch` reports each workspace separately, and one failure no longer stops the others. A real `sync` skips only the workspaces whose fetch failed (`fetch-failed`).
- `status` in the CLI shows an unreadable workspace (for example a deleted folder) and still lists the others.
- `fetch`, `sync` and `status` exit with code 1 when any workspace failed. `fetch` now prints a result per workspace instead of a list of names.
- The desktop app names the workspaces whose fetch failed, and sync failures show a sentence instead of a code.
- **Breaking (library):** `fetchWorkspaces()` no longer throws when a fetch fails. It resolves to a `FetchResult[]` in input order; check `result === "failed"` on each entry. Code that relied on the rejection would otherwise continue with stale remote refs. `syncWorkspaces()` accepts `{ fetch: true }` to fetch first and skip only the workspaces whose fetch failed, and `SyncResult` gains a `message`.

## [0.1.0] - 2026-11-19

First public release.

### Added

- Register clones and linked worktrees of one repository into groups, then rename, regroup or remove them. Removing only forgets the workspace; folders are never touched.
- `status`: current branch, dirty state, ongoing Git operations, and ahead/behind counts against the cached remote base for every local branch.
- `fetch` and `sync`: fast-forward base branches across every workspace, with an opt-in rebase of unpublished feature branches. Every moved branch gets a backup ref, and a read-only preview (`--dry-run`) never fetches.
- `env plan` / `env apply`: copy every `.env` key from one workspace to another in the same group (`--all-keys`) or only selected keys (`--keys`). Previews show key names and states only, never values.
- Desktop app (run from source with `pnpm app`): workspace cards with the current commit, branch table, commit history graph, sync preview and apply, environment sync, and workspace editing. Light and dark themes follow the system.

### Security

- Git always runs from an argument array with hooks, fsmonitor and automatic maintenance disabled. On Windows, hooks are disabled with a private empty directory instead of `/dev/null`, which would resolve under the drive root.
- Sync skips a workspace when the incoming base adds a path that already exists locally, so an ignored `.env` is never overwritten.
- `.env` files must be untracked and ignored; a tracked case variant such as `.ENV` is refused.
- Git is launched by absolute path from absolute `PATH` entries only, so a `git.exe` in a working tree never runs in place of Git, even when `PATH` contains an empty or relative entry.
- Credentials in remote URLs, including remote-helper URLs (`<transport>::<address>`), are never stored or printed.

[Unreleased]: https://github.com/korbethebest/clonelane/compare/v0.6.0...HEAD
[0.6.0]: https://github.com/korbethebest/clonelane/compare/v0.5.0...v0.6.0
[0.5.0]: https://github.com/korbethebest/clonelane/compare/v0.4.0...v0.5.0
[0.4.0]: https://github.com/korbethebest/clonelane/compare/v0.3.0...v0.4.0
[0.3.0]: https://github.com/korbethebest/clonelane/compare/v0.2.0...v0.3.0
[0.2.0]: https://github.com/korbethebest/clonelane/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/korbethebest/clonelane/releases/tag/v0.1.0
