import { realpath } from "node:fs/promises";
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
	validName(input.name, "workspace name");
	validName(input.group, "group name");
	const cwd = resolve(input.path);
	const base = input.base ?? "master";
	// Independent reads run together: every Git process costs real time on Windows.
	const [top, listing] = await Promise.all([
		git(cwd, ["rev-parse", "--show-toplevel"]),
		git(cwd, ["remote", "-v"]),
		validBranch(cwd, base),
	]);
	const root = await realpath(top);
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
		name: input.name,
		path: root,
		group: input.group,
		repository,
		remote,
		base,
	};
}

/** The shared .git directory; linked worktrees of one clone have the same one. */
export async function commonDirOf(path: string): Promise<string> {
	return realpath(
		await git(path, [
			"rev-parse",
			"--path-format=absolute",
			"--git-common-dir",
		]),
	);
}

export async function assertIdentity(workspace: Workspace): Promise<void> {
	const actual = await registerWorkspace(workspace);
	if (
		actual.path !== workspace.path ||
		actual.repository !== workspace.repository
	) {
		fail(
			"IDENTITY_CHANGED",
			"Workspace path or remote identity changed. Register it again before syncing.",
		);
	}
}

async function counts(
	path: string,
	left: string,
	right: string,
): Promise<[number, number]> {
	const result = await git(path, [
		"rev-list",
		"--left-right",
		"--count",
		`${left}...${right}`,
		"--",
	]);
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
	await assertIdentity(workspace);
	const path = workspace.path;
	const baseRef = `refs/remotes/${workspace.remote}/${workspace.base}`;
	const [dirs, status, subject, rows, baseHead] = await Promise.all([
		// One process for: common dir, this worktree's git dir, HEAD and its branch.
		git(path, [
			"rev-parse",
			"--path-format=absolute",
			"--git-common-dir",
			"--absolute-git-dir",
			"HEAD",
			"--symbolic-full-name",
			"HEAD",
		]),
		git(path, [
			"status",
			"--porcelain=v1",
			"--untracked-files=normal",
			"--ignore-submodules=none",
		]),
		// "--": a file named HEAD in the worktree must not make the revision ambiguous.
		git(path, ["log", "-1", "--no-color", "--format=%s", "HEAD", "--"]),
		// upstream:track gives each branch's ahead/behind without a process per branch.
		git(path, [
			"for-each-ref",
			"--format=%(refname:short)%00%(upstream)%00%(HEAD)%00%(upstream:track,nobracket)",
			"refs/heads/",
		]),
		git(path, ["rev-parse", "--verify", "--quiet", baseRef]).catch(() => null),
	]);
	const [rawCommonDir, gitDir, head, symbolic] = dirs.split("\n");
	if (!rawCommonDir || !gitDir || !head || symbolic == null)
		fail("GIT_PARSE", "Could not read Git state.");
	const branch = symbolic.startsWith("refs/heads/") ? symbolic.slice(11) : null;
	const [commonDir, operation, [baseAhead, baseBehind], operations] =
		await Promise.all([
			realpath(rawCommonDir),
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
			baseHead == null ? ([null, null] as const) : counts(path, head, baseHead),
			readOperations(rawCommonDir),
		]);
	// Moves this workspace started but never finished: the process stopped midway.
	// A later move of the same branch means the user has moved on, so the warning clears.
	const moved = new Set<string>();
	let interrupted = 0;
	for (const item of operations) {
		if (item.path !== workspace.path) continue;
		if (item.state === "interrupted" && !moved.has(item.ref)) interrupted++;
		moved.add(item.ref);
	}
	const branches: BranchInfo[] = [];
	for (const row of rows.split("\n").filter(Boolean)) {
		const [name, upstream, current, track = ""] = row.split("\0");
		if (!name) continue;
		// "gone" means the upstream is configured but its ref no longer exists.
		const tracked = Boolean(upstream) && track !== "gone";
		const count = (word: string) =>
			Number(new RegExp(`${word} (\\d+)`).exec(track)?.[1] ?? 0);
		branches.push({
			name,
			current: current === "*",
			upstream: upstream || null,
			ahead: tracked ? count("ahead") : null,
			behind: tracked ? count("behind") : null,
		});
	}
	const dirty = Boolean(status);
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
