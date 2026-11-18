# Changelog

All notable changes to this project are documented here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses [Semantic Versioning](https://semver.org/). Until 1.0, minor versions may change the CLI and library API.

## [0.1.0] - Unreleased

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
