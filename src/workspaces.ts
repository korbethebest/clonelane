import { realpath, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

import { fail } from "./errors.ts";
import { exists } from "./files.ts";
import { git, repositoryIdentity, validBranch, validName } from "./git.ts";
import { readOperations } from "./journal.ts";
import { type Lease, readLease } from "./lease.ts";

export interface Workspace {
	name: string;
	path: string;
	group: string;
	repository: string;
	remote: string;
	base: string;
}

export interface BranchInfo {
	name: string;
	current: boolean;
	upstream: string | null;
	ahead: number | null;
	behind: number | null;
}

export interface WorkspaceStatus {
	workspace: Workspace;
	commonDir: string;
	branch: string | null;
	head: string;
	subject: string;
	baseHead: string | null;
	dirty: boolean;
	operation: boolean;
	baseAhead: number | null;
	baseBehind: number | null;
	branches: BranchInfo[];
	/** Clonelane moves in this workspace that started but never recorded an outcome. */
	interrupted: number;
	/** Who is using this workspace, if anyone (see takeLease). */
	lease: Lease | null;
}

export async function registerWorkspace(input: {
	name: string;
	path: string;
	group: string;
	remote?: string;
	base?: string;
}): Promise<Workspace> {
	return (await identify(input)).workspace;
}

// Resolves a folder to its workspace identity and shared .git directory in as few Git
// processes as possible: each one costs real time on Windows.
async function identify(input: {
	name: string;
	path: string;
	group: string;
	remote?: string;
	base?: string;
}): Promise<{ workspace: Workspace; commonDir: string; gitDir: string }> {
	validName(input.name, "workspace name");
	validName(input.group, "group name");
	const cwd = resolve(input.path);
	const base = input.base ?? "master";
	// Independent reads run together: every Git process costs real time on Windows.
	const [dirs, listing] = await Promise.all([
		git(cwd, [
			"rev-parse",
			"--path-format=absolute",
			"--show-toplevel",
			"--git-common-dir",
			"--absolute-git-dir",
		]),
		git(cwd, ["remote", "-v"]),
		validBranch(cwd, base),
	]);
	const [top, rawCommonDir, gitDir, ...extra] = dirs.split("\n");
	if (!top || !rawCommonDir || !gitDir || extra.length)
		fail("GIT_PARSE", "Could not read the repository's folders from Git.");
	const [root, commonDir] = await Promise.all([
		realpath(top),
		realpath(rawCommonDir),
	]);
	const urls = new Map<string, string>();
	for (const line of listing.split("\n")) {
		const match = /^(\S+)\t(.*) \(fetch\)$/.exec(line);
		if (match?.[1] && match[2] != null) urls.set(match[1], match[2]);
	}
	const remotes = [...urls.keys()];
	// Default to origin; a repository with one differently named remote uses that one.
	const remote =
		input.remote ??
		(remotes.length === 1 && !remotes.includes("origin")
			? (remotes[0] as string)
			: "origin");
	validName(remote, "remote name");
	if (!remotes.includes(remote))
		fail(
			"REMOTE_MISSING",
			remotes.length === 0
				? "This repository has no remote. Add one with git remote add."
				: `Remote "${remote}" does not exist. Available remotes: ${remotes.join(", ")}.`,
		);
	const repository = repositoryIdentity(urls.get(remote) ?? "", root);
	return {
		workspace: {
			name: input.name,
			path: root,
			group: input.group,
			repository,
			remote,
			base,
		},
		commonDir,
		gitDir,
	};
}

/** Confirms the folder is still the registered repository; returns its .git dirs. */
export async function checkIdentity(
	workspace: Workspace,
): Promise<{ commonDir: string; gitDir: string }> {
	const { workspace: actual, commonDir, gitDir } = await identify(workspace);
	if (
		actual.path !== workspace.path ||
		actual.repository !== workspace.repository
	) {
		fail(
			"IDENTITY_CHANGED",
			"Workspace path or remote identity changed. Register it again before syncing.",
		);
	}
	return { commonDir, gitDir };
}

/** Confirms the folder is still the registered repository; returns its shared .git dir. */
export async function assertIdentity(workspace: Workspace): Promise<string> {
	return (await checkIdentity(workspace)).commonDir;
}

// Read-only status views (opt in with reuseIdentity) reuse a passed identity check while
// nothing it depends on changed: the .git entry is the same one (not a replaced folder),
// and the repository's and the user's Git config files (remote URLs, insteadOf rewrites)
// are untouched. Anything that changes a branch or a file always checks in full.
const IDENTITY_TTL = 5 * 60_000;
const identities = new Map<
	string,
	{
		key: string | null;
		at: number;
		dirs: { commonDir: string; gitDir: string };
	}
>();
const missing = { ino: -1n, mtimeNs: -1n, size: -1n };
async function fingerprint(
	workspace: Workspace,
	dirs: { commonDir: string; gitDir: string },
): Promise<string | null> {
	const home = homedir();
	const xdg = process.env.XDG_CONFIG_HOME || join(home, ".config");
	try {
		const dotGit = await stat(join(workspace.path, ".git"), { bigint: true });
		// Without a real file id a replaced .git folder could look the same: never cache.
		if (dotGit.ino === 0n) return null;
		const files = await Promise.all(
			[
				join(dirs.commonDir, "config"),
				join(dirs.gitDir, "config.worktree"),
				join(home, ".gitconfig"),
				join(xdg, "git", "config"),
			].map((file) => stat(file, { bigint: true }).catch(() => missing)),
		);
		return JSON.stringify([
			workspace,
			String(dotGit.ino),
			dotGit.isFile() ? String(dotGit.mtimeNs) : "",
			...files.map((file) => [
				String(file.ino),
				String(file.mtimeNs),
				String(file.size),
			]),
		]);
	} catch {
		return null;
	}
}
async function cachedIdentity(
	workspace: Workspace,
): Promise<{ commonDir: string; gitDir: string }> {
	const known = identities.get(workspace.path);
	// Taken before the check, so a config change during the check is never stamped valid.
	const before = known ? await fingerprint(workspace, known.dirs) : null;
	if (
		known?.key &&
		before === known.key &&
		Date.now() - known.at < IDENTITY_TTL
	)
		return known.dirs;
	const dirs = await checkIdentity(workspace);
	const same =
		known?.dirs.commonDir === dirs.commonDir &&
		known.dirs.gitDir === dirs.gitDir;
	// The first check only learns where the config lives; the next one can be cached.
	identities.set(workspace.path, {
		key: same ? before : null,
		at: Date.now(),
		dirs,
	});
	return dirs;
}

// Ahead/behind between two commits does not change while the history is complete, so it is
// computed once per pair and clone. A shallow clone can gain history, so it is not cached.
const countCache = new Map<string, [number, number]>();

function counts(result: string): [number, number] {
	const [ahead, behind] = result.split(/\s+/).map(Number);
	if (
		ahead == null ||
		behind == null ||
		!Number.isFinite(ahead) ||
		!Number.isFinite(behind)
	)
		fail("GIT_PARSE", "Could not read Git counts.");
	return [ahead, behind];
}

/**
 * Reads a workspace's state. `reuseIdentity` lets a read-only status view reuse a recent
 * identity check (see above); callers that go on to change anything must leave it off.
 */
export async function inspectWorkspace(
	workspace: Workspace,
	{ reuseIdentity = false }: { reuseIdentity?: boolean } = {},
): Promise<WorkspaceStatus> {
	const path = workspace.path;
	const baseRef = `refs/remotes/${workspace.remote}/${workspace.base}`;
	// Two Git processes cover the state below; each one costs real time on Windows. Both
	// are read-only, so they run alongside the identity check, whose error wins.
	const identity = reuseIdentity
		? cachedIdentity(workspace)
		: checkIdentity(workspace);
	const reads = Promise.all([
		// HEAD's commit and whether anything is uncommitted.
		git(path, [
			"status",
			"--porcelain=v2",
			"--branch",
			"--untracked-files=normal",
			"--ignore-submodules=none",
		]),
		// Every local branch with its tip, upstream counts and subject, plus the remote base.
		// upstream:track gives each branch's ahead/behind without a process per branch.
		git(path, [
			"for-each-ref",
			"--format=%(refname)%00%(objectname)%00%(upstream)%00%(HEAD)%00%(upstream:track,nobracket)%00%(contents:subject)",
			"refs/heads/",
			baseRef,
		]),
	]);
	reads.catch(() => {}); // Reported through the identity check, or awaited below.
	const { commonDir, gitDir } = await identity;
	const [status, refs] = await reads;
	let head: string | undefined;
	let dirty = false;
	for (const line of status.split("\n")) {
		if (line.startsWith("# branch.oid ")) head = line.slice(13);
		else if (line && !line.startsWith("# ")) dirty = true;
	}
	if (!head || !/^[0-9a-f]{40,64}$/.test(head))
		fail("GIT_PARSE", "Could not read Git state.");
	const rows = refs
		.split("\n")
		.filter(Boolean)
		.map((row) => row.split("\0"));
	const baseHead = rows.find(([ref]) => ref === baseRef)?.[1] ?? null;
	const current = rows.find(
		([ref, , , marker]) => ref?.startsWith("refs/heads/") && marker === "*",
	);
	const branch = current?.[0]?.slice(11) ?? null;
	const tip = head;
	const [subject, [baseAhead, baseBehind]] = await Promise.all([
		// A detached HEAD (or a branch that moved between the two reads) needs its own read.
		current?.[1] === tip
			? (current[5] ?? "")
			: git(path, ["log", "-1", "--no-color", "--format=%s", tip, "--"]),
		(async () => {
			if (baseHead == null) return [null, null] as const;
			const range = `${tip}...${baseHead}`;
			const key = `${commonDir}\n${range}`;
			const known = countCache.get(key);
			if (known) return known;
			const [result, shallow] = await Promise.all([
				git(path, ["rev-list", "--left-right", "--count", range, "--"]).then(
					counts,
				),
				exists(join(commonDir, "shallow")),
			]);
			if (!shallow) {
				if (countCache.size > 1000) countCache.clear();
				countCache.set(key, result);
			}
			return result;
		})(),
	]);
	const [operation, operations, lease] = await Promise.all([
		Promise.all(
			[
				"MERGE_HEAD",
				"CHERRY_PICK_HEAD",
				"REVERT_HEAD",
				"rebase-merge",
				"rebase-apply",
				"sequencer",
				"BISECT_LOG",
			].map((marker) => exists(join(gitDir, marker))),
		).then((found) => found.some(Boolean)),
		readOperations(commonDir),
		readLease(gitDir),
	]);
	// Moves this workspace started but never finished: the process stopped midway.
	// A later successful move of the same branch (from any worktree of this clone) means the
	// branch is in a known state again, so the warning clears.
	const moved = new Set<string>();
	let interrupted = 0;
	for (const item of operations) {
		if (
			item.state === "interrupted" &&
			item.path === workspace.path &&
			!moved.has(item.ref)
		)
			interrupted++;
		if (item.state === "done") moved.add(item.ref);
	}
	const branches: BranchInfo[] = [];
	for (const [ref, , upstream, marker, track = ""] of rows) {
		if (!ref?.startsWith("refs/heads/")) continue;
		const name = ref.slice(11);
		// "gone" means the upstream is configured but its ref no longer exists.
		const tracked = Boolean(upstream) && track !== "gone";
		const count = (word: string) =>
			Number(new RegExp(`${word} (\\d+)`).exec(track)?.[1] ?? 0);
		branches.push({
			name,
			current: marker === "*",
			upstream: upstream || null,
			ahead: tracked ? count("ahead") : null,
			behind: tracked ? count("behind") : null,
		});
	}
	return {
		workspace,
		commonDir,
		branch,
		head,
		subject,
		baseHead,
		dirty,
		operation,
		baseAhead,
		baseBehind,
		branches,
		interrupted,
		lease,
	};
}

export interface GraphRef {
	name: string;
	kind: "head" | "branch" | "remote" | "tag";
}

export interface GraphCommit {
	hash: string;
	parents: string[];
	refs: GraphRef[];
	author: string;
	time: number;
	subject: string;
}

// Decorations from --decorate=full; other namespaces (backups, stash) are left out.
function parseRefs(text: string): GraphRef[] {
	const refs: GraphRef[] = [];
	for (const item of text.split(", ").filter(Boolean)) {
		const head = item.startsWith("HEAD -> ");
		const ref = item.replace(/^HEAD -> |^tag: /, "");
		if (ref === "HEAD") refs.push({ name: "HEAD", kind: "head" });
		else if (ref.startsWith("refs/heads/"))
			refs.push({ name: ref.slice(11), kind: head ? "head" : "branch" });
		else if (ref.startsWith("refs/tags/"))
			refs.push({ name: ref.slice(10), kind: "tag" });
		else if (ref.startsWith("refs/remotes/") && !ref.endsWith("/HEAD"))
			refs.push({ name: ref.slice(13), kind: "remote" });
	}
	return refs;
}

// Read-only history of HEAD, local branches and the remote base, newest first.
export async function historyGraph(
	workspace: Workspace,
	limit = 60,
): Promise<GraphCommit[]> {
	// Like every other registry-driven Git call, confirm the folder is still that repository.
	await assertIdentity(workspace);
	const out = await git(workspace.path, [
		"log",
		// The remote base may not be fetched yet; skip it instead of asking first.
		"--ignore-missing",
		"--date-order",
		"--no-color",
		"--decorate=full",
		`--max-count=${limit}`,
		"--format=%H%x00%P%x00%D%x00%an%x00%ct%x00%s",
		"HEAD",
		"--branches",
		`refs/remotes/${workspace.remote}/${workspace.base}`,
		"--",
	]);
	return out
		.split("\n")
		.filter(Boolean)
		.map((line) => {
			const [hash = "", parents = "", refs = "", author = "", time, subject] =
				line.split("\0");
			return {
				hash,
				parents: parents.split(" ").filter(Boolean),
				refs: parseRefs(refs),
				author,
				time: Number(time) * 1000,
				subject: subject ?? "",
			};
		});
}
