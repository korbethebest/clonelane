import { randomUUID } from "node:crypto";
import { lstat, readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

import { ClonelaneError } from "./errors.ts";
import { withLock } from "./files.ts";
import { git, gitSucceeds } from "./git.ts";
import { begin, finish } from "./journal.ts";
import { blocks, workspaceLease } from "./lease.ts";
import {
	assertIdentity,
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
	/**
	 * Local branches stacked under the current one (their tips are in base..HEAD), which a
	 * rebase moves along with it so the stack stays stacked.
	 */
	stack?: string[];
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
	/**
	 * Set when this clone copied the base from another registered clone of the same
	 * repository on disk, which had just fetched it, instead of using the network.
	 */
	source?: string;
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
	// Branches stacked under this one move with it (git rebase --update-refs); each must be
	// as safe to rewrite as the current branch, and free to move.
	const stack = (
		await git(path, [
			"for-each-ref",
			"--merged",
			"HEAD",
			"--no-merged",
			state.baseHead ?? "",
			"--format=%(refname)",
			"refs/heads/",
		])
	)
		.split("\n")
		.filter(
			(ref) =>
				ref &&
				ref !== `refs/heads/${state.branch}` &&
				ref !== `refs/heads/${state.workspace.base}`,
		);
	if (!stack.length) return plan;
	const names = stack.map((ref) => ref.slice("refs/heads/".length));
	if (
		names.some(
			(name) => state.branches.find((item) => item.name === name)?.upstream,
		)
	)
		return { ...plan, action: "skip", reason: "published-or-merge-branch" };
	const checkedOut = (
		await git(path, ["worktree", "list", "--porcelain"])
	).split("\n");
	for (const ref of stack)
		if (
			checkedOut.includes(`branch ${ref}`) ||
			(await busyElsewhere(state.commonDir, ref))
		)
			return {
				...plan,
				action: "skip",
				reason: "stacked-branch-checked-out-elsewhere",
			};
	if (!(await updateRefsSupported(path)))
		return { ...plan, action: "skip", reason: "git-too-old-for-stacks" };
	return { ...plan, stack: names };
}

// git rebase --update-refs arrived in Git 2.38.
async function updateRefsSupported(path: string): Promise<boolean> {
	const match = /(\d+)\.(\d+)/.exec(await git(path, ["version"]));
	const [major, minor] = [Number(match?.[1]), Number(match?.[2])];
	return major > 2 || (major === 2 && minor >= 38);
}

// A rebase or bisect detaches HEAD, so `worktree list` stops naming the branch it works
// on; the operation's own state files still do, in the main and every linked git dir.
export async function busyElsewhere(
	commonDir: string,
	ref: string,
): Promise<boolean> {
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
	const id = await begin(state.commonDir, {
		workspace: workspace.name,
		path: workspace.path,
		kind: "base-fast-forward",
		ref,
		from: head,
		to: state.baseHead,
		backup,
	});
	try {
		await git(workspace.path, ["update-ref", ref, state.baseHead, head]);
	} catch (error) {
		await finish(state.commonDir, id, "failed");
		throw error;
	}
	await finish(state.commonDir, id, "done", state.baseHead);
	return {
		action: "fast-forward",
		reason: "unused-local-base",
		result: "updated",
		backup,
	};
}

/**
 * Fast-forwards (and, with `rebase`, rebases) every workspace, one at a time.
 *
 * - `dryRun`: read-only preview from the cached remote refs. It never fetches, and
 *   `fetch` is ignored; call `fetchWorkspaces()` first for a fresh preview.
 * - `fetch`: fetch first, then skip only the workspaces whose fetch failed
 *   (`reason: "fetch-failed"`).
 */
export async function syncWorkspaces(
	workspaces: Workspace[],
	options: {
		dryRun?: boolean;
		rebase?: boolean;
		fetch?: boolean;
		/** Act as this lease holder: its own leased workspaces are synced, not skipped. */
		as?: string;
	} = {},
): Promise<SyncResult[]> {
	// A preview only reads, so workspaces are inspected side by side.
	if (options.dryRun)
		return Promise.all(workspaces.map((item) => syncOne(item, options)));
	// A workspace leased by someone else is not fetched either: that would move its
	// remote-tracking refs under the holder. An unreadable lease is left to syncOne to report.
	const free = options.fetch
		? await Promise.all(
				workspaces.map((item) =>
					workspaceLease(item).then(
						(lease) => !blocks(lease, options.as),
						() => true,
					),
				),
			)
		: [];
	const fetchedFree = options.fetch
		? await fetchWorkspaces(workspaces.filter((_, index) => free[index]))
		: [];
	let next = 0;
	const fetched = workspaces.map((_, index) =>
		free[index] ? fetchedFree[next++] : undefined,
	);
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

// A workspace leased by someone else is left alone entirely, base ref included.
const leased = (state: WorkspaceStatus): SyncResult => ({
	name: state.workspace.name,
	action: "skip",
	reason: "leased",
	head: state.head,
	baseHead: state.baseHead,
	branch: state.branch,
	result: "skipped",
});

async function syncOne(
	workspace: Workspace,
	options: { dryRun?: boolean; rebase?: boolean; as?: string },
): Promise<SyncResult> {
	try {
		const initial = await inspectWorkspace(workspace);
		if (blocks(initial.lease, options.as)) return leased(initial);
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
				if (blocks(state.lease, options.as)) return leased(state);
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
				const id = await begin(state.commonDir, {
					workspace: workspace.name,
					path: workspace.path,
					kind: plan.action,
					ref: `refs/heads/${state.branch}`,
					from: state.head,
					to: state.baseHead ?? "",
					backup,
				});
				// Each stacked branch gets its own backup and journal entry, so each can be
				// restored on its own.
				const stacked: { ref: string; id: string }[] = [];
				for (const name of plan.stack ?? []) {
					const ref = `refs/heads/${name}`;
					const tip = await git(workspace.path, ["rev-parse", "--verify", ref]);
					const saved = `refs/clonelane/backups/${randomUUID()}`;
					await git(workspace.path, ["update-ref", saved, tip]);
					stacked.push({
						ref,
						id: await begin(state.commonDir, {
							workspace: workspace.name,
							path: workspace.path,
							kind: "rebase",
							ref,
							from: tip,
							to: state.baseHead ?? "",
							backup: saved,
						}),
					});
				}
				const updateRefs = stacked.length > 0;
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
							`rebase.updateRefs=${updateRefs}`,
							"-c",
							"rebase.autoStash=false",
							"-c",
							"commit.gpgSign=false",
							"rebase",
							"--no-autostash",
							updateRefs ? "--update-refs" : "--no-update-refs",
							"--no-verify",
							state.baseHead ?? "",
						]);
					const tip = await git(workspace.path, ["rev-parse", "HEAD"]).catch(
						() => undefined,
					);
					await finish(state.commonDir, id, "done", tip);
					for (const item of stacked)
						await finish(
							state.commonDir,
							item.id,
							"done",
							await git(workspace.path, ["rev-parse", item.ref]).catch(
								() => undefined,
							),
						);
					return { ...plan, result: "updated", backup };
				} catch (error) {
					await finish(state.commonDir, id, "failed");
					// A stopped rebase never moved the stacked refs: --update-refs moves them last.
					for (const item of stacked)
						await finish(state.commonDir, item.id, "failed");
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
// another under it. Separate clones of the same repository fetch from the network once:
// the first clone fetches, then the others copy its fresh base over the local disk, which
// skips the network and the credential helper. If that copy fails, they fetch normally.
// A failure is reported for the workspaces it affects; the others are still fetched.
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
	// Identify in parallel, then group in input order, so the clone that fetches from the
	// network is always the first one listed, whatever order the checks finish in.
	const commonDirs = await Promise.all(
		workspaces.map((workspace) =>
			assertIdentity(workspace).catch((error: unknown) => {
				record([workspace], { result: "failed", ...failure(error) });
				return null;
			}),
		),
	);
	// commonDir -> (remote + base) -> workspaces sharing that one fetch
	const clones = new Map<string, Map<string, Workspace[]>>();
	for (const [index, workspace] of workspaces.entries()) {
		const commonDir = commonDirs[index];
		if (commonDir == null) continue;
		const targets = clones.get(commonDir) ?? new Map<string, Workspace[]>();
		clones.set(commonDir, targets);
		const key = `${workspace.remote}\0${workspace.base}`;
		targets.set(key, [...(targets.get(key) ?? []), workspace]);
	}
	// One network fetch per repository and base branch: the first clone listed for it.
	const same = (a: Workspace, b: Workspace) =>
		a.repository === b.repository && a.base === b.base;
	// Leads are picked in input order. Only the first workspace of each target fetches
	// (worktrees sharing a target share its fetch), so only those can lead.
	const firsts = new Set(
		[...clones.values()].flatMap((targets) =>
			[...targets.values()].map(([workspace]) => workspace),
		),
	);
	const leads: Workspace[] = [];
	for (const workspace of workspaces)
		if (firsts.has(workspace) && !leads.some((lead) => same(lead, workspace)))
			leads.push(workspace);
	const fetchClone = (
		commonDir: string,
		targets: Map<string, Workspace[]>,
		phase: "network" | "copy",
	) => {
		const due = [...targets.values()].filter(
			([workspace]) =>
				leads.includes(workspace as Workspace) === (phase === "network"),
		);
		if (due.length === 0) return;
		return withLock(join(commonDir, "clonelane.lock"), async () => {
			for (const members of due) {
				const [workspace] = members as [Workspace];
				const gitFetch = (from: string, ref: string) =>
					git(workspace.path, [
						"fetch",
						"--no-tags",
						"--no-recurse-submodules",
						from,
						`${ref}:refs/remotes/${workspace.remote}/${workspace.base}`,
					]);
				const source =
					phase === "copy"
						? leads.find(
								(lead) =>
									same(lead, workspace) &&
									results.get(lead)?.result === "fetched",
							)
						: undefined;
				if (source) {
					try {
						await gitFetch(
							source.path,
							`refs/remotes/${source.remote}/${source.base}`,
						);
						record(members, { result: "fetched", source: source.name });
						continue;
					} catch {
						// The same fetch from the network below reports any real problem.
					}
				}
				try {
					await gitFetch(workspace.remote, `refs/heads/${workspace.base}`);
					record(members, { result: "fetched" });
				} catch (error) {
					record(members, { result: "failed", ...failure(error) });
				}
			}
		}).catch((error) =>
			// A lock that could not be taken (or released) must not undo fetches that
			// already succeeded under it.
			record(due.flat(), { result: "failed", ...failure(error) }, true),
		);
	};
	// Leads fetch from the network side by side, then every other clone copies from its lead.
	await Promise.all(
		[...clones].map(([dir, targets]) => fetchClone(dir, targets, "network")),
	);
	await Promise.all(
		[...clones].map(([dir, targets]) => fetchClone(dir, targets, "copy")),
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

/**
 * One unattended pass: for each automatic-sync group (or only `groups`), fetch and
 * fast-forward as `clonelane sync` would, without rebase. Dirty, leased and busy
 * workspaces are skipped as always. A group left without workspaces is skipped.
 */
export interface AutoSyncRun {
	group: string;
	results: SyncResult[];
	/** Set when the group could not be synced at all; results is then empty. */
	error?: { code: string; message: string };
}

export async function runAutoSync(
	registry: { workspaces: Workspace[]; autoSync?: string[] },
	groups?: string[],
	onRun?: (run: AutoSyncRun) => void,
): Promise<AutoSyncRun[]> {
	const runs: AutoSyncRun[] = [];
	for (const group of registry.autoSync ?? []) {
		if (groups && !groups.includes(group)) continue;
		const workspaces = registry.workspaces.filter(
			(item) => item.group === group,
		);
		if (!workspaces.length) continue;
		let run: AutoSyncRun;
		try {
			run = {
				group,
				results: await syncWorkspaces(workspaces, { fetch: true }),
			};
		} catch (error) {
			// One group that cannot run must not stop the others.
			run = {
				group,
				results: [],
				error:
					error instanceof ClonelaneError
						? { code: error.code, message: error.message }
						: { code: "FAILED", message: "This group could not be synced." },
			};
		}
		runs.push(run);
		onRun?.(run);
	}
	return runs;
}
