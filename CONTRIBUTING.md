# Contributing to Clonelane

Thanks for helping. Clonelane changes people's branches and copies their secrets, so the bar for safety is high. Please read this before opening a pull request.

## Setup

- Node.js 24 or later and pnpm (the version is pinned in `package.json`).
- `pnpm install`, then `pnpm dev --help` for the CLI or `pnpm app` for the desktop app.

## Before you open a pull request

Run all of these and make sure they pass:

```sh
pnpm format
pnpm lint
pnpm typecheck
pnpm test
pnpm build
```

## Ground rules

- Keep runtime dependencies at zero unless there is a concrete need.
- Keep the core importable without CLI side effects.
- Run Git with argument arrays only. Never build a shell command string.
- Never log environment values, secret hashes, raw child-process errors or remote URLs that may contain credentials.
- Preserve dirty checkouts and published branches. No push, destructive reset, automatic stash or unattended conflict resolution.
- Any new operation that changes files or branches needs a reviewable preview, conflict handling and a way to recover.
- Document real limits. POSIX permissions are not Windows ACLs, and Clonelane's lock does not stop other Git clients.

## Tests

- Use disposable local Git remotes and synthetic secrets only. Never point tests at real repositories or real `.env` files.
- Scratch files and Git fixtures belong in `*.local/` directories, which Git ignores.
- A bug fix should come with a test that fails without the fix.
- Keep `pnpm-lock.yaml` committed.

## Security issues

Do not report vulnerabilities in public issues. See [SECURITY.md](SECURITY.md).
