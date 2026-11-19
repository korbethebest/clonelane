import { realpath, stat } from "node:fs/promises";
import { join, resolve } from "node:path";

import { fail } from "./errors.ts";
import { exists } from "./files.ts";
import { git, repositoryIdentity, validBranch, validName } from "./git.ts";
import { readOperations } from "./journal.ts";

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

async function checkIdentity(
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

// Read-only views reuse a passed identity check while nothing it depends on changed: the
// .git entry is the same one (not a replaced folder) and the repository's config (which
// holds the remote URL) is untouched. Anything that changes a branch checks in full.
const IDENTITY_TTL = 5 * 60_000;
const identities = new Map<
	string,
	{ key: string; at: number; dirs: { commonDir: string; gitDir: string } }
>();
async function fingerprint(
	workspace: Workspace,
	commonDir: string,
): Promise<string | null> {
	try {
		const [dotGit, config] = await Promise.all([
			stat(join(workspace.path, ".git"), { bigint: true }),
			stat(join(commonDir, "config"), { bigint: true }),
		]);
		return JSON.stringify([
			workspace,
			String(dotGit.ino),
			dotGit.isFile() ? String(dotGit.mtimeNs) : "",
			String(config.ino),
			String(config.mtimeNs),
			String(config.size),
		]);
	} catch {
		return null;
	}
}
async function cachedIdentity(
	workspace: Workspace,
): Promise<{ commonDir: string; gitDir: string }> {
	const known = identities.get(workspace.path);
	if (known && Date.now() - known.at < IDENTITY_TTL) {
		const key = await fingerprint(workspace, known.dirs.commonDir);
		if (key === known.key) return known.dirs;
	}
	identities.delete(workspace.path);
	const dirs = await checkIdentity(workspace);
	const key = await fingerprint(workspace, dirs.commonDir);
	if (key) identities.set(workspace.path, { key, at: Date.now(), dirs });
	return dirs;
}

// Ahead/behind between two commits never changes, so it is computed once per pair.
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

export async function inspectWorkspace(
	workspace: Workspace,
): Promise<WorkspaceStatus> {
	const path = workspace.path;
	const baseRef = `refs/remotes/${workspace.remote}/${workspace.base}`;
	// Two Git processes cover the state below; each one costs real time on Windows. Both
	// are read-only, so they run alongside the identity check, whose error wins.
	const identity = cachedIdentity(workspace);
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
			const key = `${tip}...${baseHead}`;
			const known = countCache.get(key);
			if (known) return known;
			const result = counts(
				await git(path, ["rev-list", "--left-right", "--count", key, "--"]),
			);
			if (countCache.size > 1000) countCache.clear();
			countCache.set(key, result);
			return result;
		})(),
	]);
	const [operation, operations] = await Promise.all([
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
