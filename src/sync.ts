import { randomUUID } from "node:crypto";
import { lstat, readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

import { ClonelaneError } from "./errors.ts";
import { withLock } from "./files.ts";
import { git, gitSucceeds } from "./git.ts";
import {
	assertIdentity,
	commonDirOf,
	inspectWorkspace,
	type Workspace,
	type WorkspaceStatus,
} from "./workspaces.ts";

export interface SyncPlan {
	name: string;
	action: "skip" | "up-to-date" | "fast-forward" | "rebase";
	reason: string;
	head: string;
	baseHead: string | null;
	branch: string | null;
}

export function planSync(status: WorkspaceStatus, rebase = false): SyncPlan {
	const plan: SyncPlan = {
		name: status.workspace.name,
		action: "skip",
		reason: "",
		head: status.head,
		baseHead: status.baseHead,
		branch: status.branch,
	};
	if (status.operation) return { ...plan, reason: "git-operation-in-progress" };
	if (status.dirty) return { ...plan, reason: "uncommitted-changes" };
	if (status.branch == null) return { ...plan, reason: "detached-head" };
	if (status.baseHead == null) return { ...plan, reason: "base-not-fetched" };
	if (status.branch === status.workspace.base) {
		if (status.baseAhead !== 0)
			return { ...plan, reason: "base-has-local-commits" };
		return {
			...plan,
			action: status.baseBehind === 0 ? "up-to-date" : "fast-forward",
			reason: "base-branch",
		};
	}
	if (!rebase) return { ...plan, reason: "rebase-not-enabled" };
	if (status.baseBehind === 0)
		return { ...plan, action: "up-to-date", reason: "contains-base" };
	return { ...plan, action: "rebase", reason: "explicit-rebase-request" };
}

export interface SyncResult extends SyncPlan {
	result: "planned" | "skipped" | "updated" | "unchanged" | "failed";
	backup?: string;
	error?: string;
	/** A fixed, human-readable next step for a failure; never Git's own output. */
	message?: string;
	baseUpdate?: BaseUpdate;
}

export interface FetchResult {
	name: string;
	result: "fetched" | "failed";
	error?: string;
	message?: string;
}

const failure = (error: unknown) =>
	error instanceof ClonelaneError
		? { error: error.code, message: error.message }
		: {
				error: "IO_ERROR",
				message:
					"A local file operation failed. Check that the folder is accessible.",
			};

export interface BaseUpdate {
	action: "skip" | "up-to-date" | "fast-forward";
	reason: string;
	result: "planned" | "skipped" | "unchanged" | "updated";
	backup?: string;
}

// Git overwrites ignored files (such as a .env this tool requires to be ignored) when the
// incoming tree adds that path. `dirty` does not see ignored files, so check the paths the
// base adds relative to HEAD against what is on disk.
async function localFilesInTheWay(state: WorkspaceStatus): Promise<boolean> {
	const added = await git(state.workspace.path, [
		"diff",
		"--name-only",
		"--no-renames",
		"--diff-filter=A",
		"-z",
		"HEAD",
		state.baseHead ?? "",
		"--",
	]);
	for (const file of added.split("\0").filter(Boolean)) {
		try {
			await lstat(join(state.workspace.path, file));
			return true;
		} catch (error) {
			// ENOTDIR: a local file sits where the incoming tree needs a directory.
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") return true;
		}
	}
	return false;
}

async function checkedPlan(
	state: WorkspaceStatus,
	rebase = false,
): Promise<SyncPlan> {
	const plan = planSync(state, rebase);
	if (plan.action !== "fast-forward" && plan.action !== "rebase") return plan;
	if (await localFilesInTheWay(state))
		return { ...plan, action: "skip", reason: "local-files-in-the-way" };
	if (plan.action !== "rebase") return plan;
	const path = state.workspace.path;
	const range = `${state.baseHead}..HEAD`;
	const [merges, published, own, unpushed, related] = await Promise.all([
		git(path, ["rev-list", "--merges", range, "--"]),
		git(path, [
			"for-each-ref",
			"--contains",
			state.head,
			"--format=%(refname)",
			"refs/remotes/",
		]),
		// A partly pushed branch: some of its own commits already sit on a remote ref
		// even though the tip does not.
		git(path, ["rev-list", "--count", range, "--"]),
		git(path, ["rev-list", "--count", range, "--not", "--remotes", "--"]),
		gitSucceeds(path, ["merge-base", "HEAD", state.baseHead ?? ""]),
	]);
	const upstream = state.branches.find((branch) => branch.current)?.upstream;
	if (merges || published || upstream || own !== unpushed)
		return { ...plan, action: "skip", reason: "published-or-merge-branch" };
	if (!related)
		return { ...plan, action: "skip", reason: "unrelated-histories" };
	return plan;
}

// A rebase or bisect detaches HEAD, so `worktree list` stops naming the branch it works
// on; the operation's own state files still do, in the main and every linked git dir.
async function busyElsewhere(commonDir: string, ref: string): Promise<boolean> {
	const linked = await readdir(join(commonDir, "worktrees")).catch(() => []);
	const dirs = [
		commonDir,
		...linked.map((name) => join(commonDir, "worktrees", name)),
	];
	const names = await Promise.all(
		dirs.flatMap((dir) =>
			["rebase-merge/head-name", "rebase-apply/head-name", "BISECT_START"].map(
				(file) =>
					readFile(join(dir, file), "utf8").then(
						(text) => text.trim(),
						() => "",
					),
			),
		),
	);
	return names.some((name) => name === ref || `refs/heads/${name}` === ref);
}

// Advance an unused local master/main without checking out another branch.
async function syncBaseRef(
	state: WorkspaceStatus,
	dryRun: boolean,
): Promise<BaseUpdate> {
	const workspace = state.workspace;
	const result = dryRun ? "planned" : "skipped";
	const skip = (reason: string): BaseUpdate => ({
		action: "skip",
		reason,
		result,
	});
	if (state.branch === workspace.base) return skip("handled-by-checkout");
	if (state.dirty || state.operation) return skip("workspace-busy");
	if (state.baseHead == null) return skip("base-not-fetched");
	const ref = `refs/heads/${workspace.base}`;
	const checkedElsewhere = async () =>
		(await git(workspace.path, ["worktree", "list", "--porcelain"]))
			.split("\n")
			.includes(`branch ${ref}`) || (await busyElsewhere(state.commonDir, ref));
	const [head, busy] = await Promise.all([
		git(workspace.path, ["rev-parse", "--verify", "--quiet", ref]).catch(
			() => null,
		),
		checkedElsewhere(),
	]);
	if (head == null) return skip("local-base-missing");
	if (busy) return skip("base-checked-out-in-another-worktree");
	if (head === state.baseHead)
		return {
			action: "up-to-date",
			reason: "local-base-current",
			result: dryRun ? "planned" : "unchanged",
		};
	if (
		!(await gitSucceeds(workspace.path, [
			"merge-base",
			"--is-ancestor",
			head,
			state.baseHead,
		]))
	)
		return skip("base-has-local-commits");
	if (dryRun)
		return {
			action: "fast-forward",
			reason: "unused-local-base",
			result: "planned",
		};
	const backup = `refs/clonelane/backups/${randomUUID()}`;
	await git(workspace.path, ["update-ref", backup, head]);
	if (await checkedElsewhere()) return skip("base-became-checked-out");
	await git(workspace.path, ["update-ref", ref, state.baseHead, head]);
	return {
		action: "fast-forward",
		reason: "unused-local-base",
		result: "updated",
		backup,
	};
}

// dryRun is read-only: it deliberately does NOT fetch. With `fetch`, a real sync fetches
// first and skips only the workspaces whose fetch failed.
export async function syncWorkspaces(
	workspaces: Workspace[],
	options: { dryRun?: boolean; rebase?: boolean; fetch?: boolean } = {},
): Promise<SyncResult[]> {
	// A preview only reads, so workspaces are inspected side by side.
	if (options.dryRun)
		return Promise.all(workspaces.map((item) => syncOne(item, options)));
	const fetched = options.fetch ? await fetchWorkspaces(workspaces) : [];
	const results: SyncResult[] = [];
	for (const [index, workspace] of workspaces.entries()) {
		// fetchWorkspaces answers in input order, so results pair by position, not name.
		const fetchFailure =
			fetched[index]?.result === "failed" ? fetched[index] : undefined;
		results.push(
			fetchFailure
				? {
						name: workspace.name,
						action: "skip",
						reason: "fetch-failed",
						head: "",
						baseHead: null,
						branch: null,
						result: "failed",
						error: fetchFailure.error,
						message: fetchFailure.message,
					}
				: await syncOne(workspace, options),
		);
	}
	return results;
}

async function syncOne(
	workspace: Workspace,
	options: { dryRun?: boolean; rebase?: boolean },
): Promise<SyncResult> {
	try {
		const initial = await inspectWorkspace(workspace);
		if (options.dryRun) {
			const [plan, baseUpdate] = await Promise.all([
				checkedPlan(initial, options.rebase),
				syncBaseRef(initial, true),
			]);
			return { ...plan, result: "planned", baseUpdate };
		}
		let baseUpdate: BaseUpdate | undefined;
		const result = await withLock(
			join(initial.commonDir, "clonelane.lock"),
			async (): Promise<SyncResult> => {
				const state = await inspectWorkspace(workspace);
				const plan = await checkedPlan(state, options.rebase);
				baseUpdate = await syncBaseRef(state, false);
				if (plan.action === "skip") return { ...plan, result: "skipped" };
				if (plan.action === "up-to-date")
					return { ...plan, result: "unchanged" };
				const backup = `refs/clonelane/backups/${randomUUID()}`;
				await git(workspace.path, ["update-ref", backup, state.head]);
				// Recheck immediately before changing checkout. External Git processes do not honor our lock.
				const current = await inspectWorkspace(workspace);
				if (
					current.head !== state.head ||
					current.branch !== state.branch ||
					current.dirty ||
					current.operation
				) {
					return {
						...plan,
						action: "skip",
						reason: "workspace-changed",
						result: "skipped",
						backup,
					};
				}
				try {
					if (plan.action === "fast-forward")
						await git(workspace.path, [
							"merge",
							"--ff-only",
							"--no-edit",
							"--",
							state.baseHead ?? "",
						]);
					else
						await git(workspace.path, [
							"-c",
							"rebase.updateRefs=false",
							"-c",
							"rebase.autoStash=false",
							"-c",
							"commit.gpgSign=false",
							"rebase",
							"--no-autostash",
							"--no-update-refs",
							"--no-verify",
							state.baseHead ?? "",
						]);
					return { ...plan, result: "updated", backup };
				} catch (error) {
					if (plan.action !== "rebase")
						return { ...plan, result: "failed", backup, ...failure(error) };
					const aborted = await gitSucceeds(workspace.path, [
						"rebase",
						"--abort",
					]);
					return {
						...plan,
						result: "failed",
						backup,
						...(aborted
							? {
									error: "rebase-failed-restored",
									message:
										"The rebase stopped, usually on a conflict, and was undone: the branch is as it was. Rebase it by hand to resolve the conflict.",
								}
							: {
									error: "rebase-failed-manual-recovery-required",
									message: `The rebase stopped and could not be undone automatically. Run "git rebase --abort" in this workspace; the previous branch tip is kept at ${backup}.`,
								}),
					};
				}
			},
		);
		return { ...result, baseUpdate };
	} catch (error) {
		return {
			name: workspace.name,
			action: "skip",
			reason: "inspection-or-lock-failed",
			head: "",
			baseHead: null,
			branch: null,
			result: "failed",
			...failure(error),
		};
	}
}

// Linked worktrees share one object store and one lock: their fetches run one after
// another under it. Separate clones run side by side. A failure is reported for the
// workspaces it affects; the others are still fetched.
export async function fetchWorkspaces(
	workspaces: Workspace[],
): Promise<FetchResult[]> {
	// Keyed by the workspace object, so results never mix even if names repeat.
	const results = new Map<Workspace, FetchResult>();
	const record = (
		members: Workspace[],
		outcome: Omit<FetchResult, "name">,
		onlyMissing = false,
	) => {
		for (const member of members)
			if (!onlyMissing || !results.has(member))
				results.set(member, { name: member.name, ...outcome });
	};
	// commonDir -> (remote + base) -> workspaces sharing that one fetch
	const clones = new Map<string, Map<string, Workspace[]>>();
	await Promise.all(
		workspaces.map(async (workspace) => {
			try {
				await assertIdentity(workspace);
				const commonDir = await commonDirOf(workspace.path);
				const targets = clones.get(commonDir) ?? new Map();
				clones.set(commonDir, targets);
				const key = `${workspace.remote}\0${workspace.base}`;
				targets.set(key, [...(targets.get(key) ?? []), workspace]);
			} catch (error) {
				record([workspace], { result: "failed", ...failure(error) });
			}
		}),
	);
	await Promise.all(
		[...clones].map(([commonDir, targets]) =>
			withLock(join(commonDir, "clonelane.lock"), async () => {
				for (const members of targets.values()) {
					const [workspace] = members as [Workspace];
					try {
						await git(workspace.path, [
							"fetch",
							"--no-tags",
							"--no-recurse-submodules",
							workspace.remote,
							`refs/heads/${workspace.base}:refs/remotes/${workspace.remote}/${workspace.base}`,
						]);
						record(members, { result: "fetched" });
					} catch (error) {
						record(members, { result: "failed", ...failure(error) });
					}
				}
			}).catch((error) =>
				// A lock that could not be taken (or released) must not undo fetches that
				// already succeeded under it.
				record(
					[...targets.values()].flat(),
					{ result: "failed", ...failure(error) },
					true,
				),
			),
		),
	);
	return workspaces.map(
		(workspace) =>
			results.get(workspace) ?? {
				name: workspace.name,
				result: "failed",
				error: "IO_ERROR",
				message: "This workspace was not fetched.",
			},
	);
}
