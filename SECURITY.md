# Security model

Clonelane is a local developer tool for **trusted repositories and trusted local directories**. It is not a sandbox against a malicious repository owner, another process running as your user, or a hostile administrator.

## Git boundary

Git runs through an argument array without a shell. The workspace root and remote identity are checked before operations. Hooks, fsmonitor and automatic maintenance are disabled for Clonelane's Git calls. Hooks are disabled by pointing `core.hooksPath` at `/dev/null` on POSIX and at an empty directory private to the process (created under the user's temp directory) on Windows, where `/dev/null/<hook>` would resolve under the drive root (`C:\dev\null\<hook>`), a folder other local users can create. Git is launched by absolute path, found in the absolute entries of `PATH` only. Empty, `.` and other relative `PATH` entries point at the current directory, the working tree, so a `git.exe` committed to a repository would otherwise run in place of Git; a regression test guards this. Repository transport configuration, credential helpers, Git filters and the Git binary itself remain trusted executable configuration. Review a repository before registering it. Git authentication uses your existing credential mechanisms; Clonelane does not collect credentials.

Inherited `GIT_DIR`, `GIT_WORK_TREE`, `GIT_COMMON_DIR`, `GIT_INDEX_FILE`, `GIT_OBJECT_DIRECTORY` and `GIT_ALTERNATE_OBJECT_DIRECTORIES` are stripped to prevent accidental redirection to another checkout. Git output and exception details are never forwarded by the CLI, because they can contain URLs, tokens or source text. Processes are bounded by a timeout and output size limit. A timed-out child or interrupted operation can still require manual inspection.

Only fast-forward base updates and explicitly requested rebases are supported. A backup ref is created before updating a branch, and the move is recorded in `clonelane-journal.jsonl` in the shared `.git` directory (commit hashes, ref names, workspace names and paths only; never file contents or environment values). `restore` moves a branch only when its tip is unchanged since the recorded move and the workspace is clean, and backs up the current tip first. Remote-tracking refs are a local cache: publication checks cannot prove that a branch was never shared elsewhere. Do not request rebase on a shared branch. No pushing is implemented. Git overwrites ignored files (such as `.env`) when an incoming commit adds the same path, so a sync is skipped (`local-files-in-the-way`) whenever the base adds a path that already exists locally.

Locks coordinate Clonelane instances sharing a Git common directory. They cannot coordinate arbitrary editors, shells or other agents. Stop those writers before applying Git or `.env` changes. An atomic rename prevents partial-file publication but is not a filesystem compare-and-swap against a hostile concurrent writer. Parent directories must be trusted and access-controlled.

## Environment values

The local registry contains metadata and paths only. Selected values live transiently in process memory and in the source/target plaintext `.env` files. Environment values are not included in previews, hashes, normal logs, crash detail output or registry metadata. The program does not evaluate environment files, interpolate commands, upload values, or synchronize arbitrary paths. Source and target files must be ignored and untracked by Git. Because Windows and macOS volumes are usually case-insensitive, the tracked check ignores letter case, and a file whose name differs from the selected one only by case (`.ENV` next to `.env`) is refused. Remote URLs in the remote-helper form `<transport>::<address>` are identified by their address, so embedded credentials are not stored.

`--all-keys` (the desktop app's default) copies every key the source file defines, including browser-exposed prefixes, without a per-key selection; keys that exist only in the target are kept. Review the key list in the preview before applying, and use `--keys` when only some values should travel. Synchronization is limited to workspaces registered in the same group (one repository).

Environment variable **names** are shown in previews and may themselves be sensitive; treat screenshots and logs accordingly. A public-variable prefix acknowledgement cannot classify whether a value is secret. Plaintext file backups are not created automatically. Replacement drops comments and formatting; independently back up important hand-maintained files using your own secure process.

Exclusive temporary files use POSIX mode `0600`. Windows uses inherited ACLs; a restrictive numeric mode does not establish a Windows ACL. Keep your workspace directory private to your account and trusted tools. The tool rejects file symlinks/hard links but does not claim race-safe filesystem isolation or security against reparse-point races. There is no encrypted storage or keychain backend in this prototype.

## Reporting

Report vulnerabilities privately through GitHub: open the repository's **Security** tab and choose **Report a vulnerability**. Please do not open a public issue for a security problem.

Do not put live credentials, `.env` contents, private remote URLs or customer data in any report. Reproduce with a disposable local repository and synthetic values. You can expect an acknowledgement within a week; fixes are released as a new version with a note in the changelog.

Only the latest released version receives security fixes. The code has been through an internal security review, but not an independent third-party audit.
