import { randomUUID } from "node:crypto";
import { join } from "node:path";

import { fail } from "./errors.ts";
import { withLock } from "./files.ts";
import { git } from "./git.ts";
import { begin, finish, type Operation, readOperations } from "./journal.ts";
import { busyElsewhere } from "./sync.ts";
import {
	assertIdentity,
	commonDirOf,
	inspectWorkspace,
	type Workspace,
} from "./workspaces.ts";

export interface RestoreResult {
	id: string;
	workspace: string;
	ref: string;
	/** Where the branch is now. */
	from: string;
	/** The backed-up commit it would return to. */
	to: string;
	result: "planned" | "restored" | "refused";
	reason?: string;
	message?: string;
	/** Backup of `from`, made before a restore moves the branch. */
	backup?: string;
}

/** Branch moves recorded for one workspace, newest first. Read-only. */
export async function listOperations(
	workspace: Workspace,
): Promise<Operation[]> {
	await assertIdentity(workspace);
	const operations = await readOperations(await commonDirOf(workspace.path));
	return operations.filter((item) => item.path === workspace.path);
}

/**
 * Moves a branch back to the commit a recorded operation backed up. It only does so when
 * the branch is still exactly where that operation left it, the workspace has no
 * uncommitted work or Git operation in progress, and the backup ref is intact. The current
 * tip is backed up first and the restore is itself journaled, so it can be undone too.
 */
export async function restoreOperation(
	workspace: Workspace,
	id: string,
	options: { dryRun?: boolean } = {},
): Promise<RestoreResult> {
	const initial = await inspectWorkspace(workspace);
	const run = async (): Promise<RestoreResult> => {
		const state = await inspectWorkspace(workspace);
		const path = workspace.path;
		const operation = (
			await readOperations(state.commonDir, !options.dryRun)
		).find((item) => item.id === id);
		if (!operation)
			fail(
				"NOT_FOUND",
				`No recorded operation ${id}. Run "clonelane history" to list them.`,
			);
		if (operation.path !== path)
			fail(
				"WRONG_WORKSPACE",
				`Operation ${id} was made in workspace "${operation.workspace}". Restore it from there.`,
			);
		const base = {
			id,
			workspace: workspace.name,
			ref: operation.ref,
			to: operation.from,
		};
		const read = (ref: string) =>
			git(path, ["rev-parse", "--verify", "--quiet", ref]).catch(() => null);
		const current = await read(operation.ref);
		const refuse = (reason: string, message: string): RestoreResult => ({
			...base,
			from: current ?? "",
			result: "refused",
			reason,
			message,
		});
		if (operation.state === "started")
			return refuse("in-progress", "This operation is still running.");
		if (operation.state === "failed")
			return refuse(
				"not-applied",
				"This operation failed, so it did not move the branch.",
			);
		if (!current)
			return refuse("branch-missing", "The branch no longer exists.");
		if ((await read(operation.backup)) !== operation.from)
			return refuse(
				"backup-missing",
				"The backup ref is missing or no longer points at the recorded commit.",
			);
		if (current === operation.from)
			return refuse(
				"already-restored",
				"The branch is already at the backed-up commit.",
			);
		// Where the operation left the branch. An interrupted rebase has no known tip.
		const left =
			operation.tip ?? (operation.kind === "rebase" ? undefined : operation.to);
		if (current !== left)
			return refuse(
				"moved-since",
				"The branch has moved since this operation (new commits or another update). Restore it by hand with Git if you still want to.",
			);
		const branch = operation.ref.replace(/^refs\/heads\//, "");
		const checkedOutHere = state.branch === branch;
		if (checkedOutHere && (state.dirty || state.operation))
			return refuse(
				"workspace-busy",
				"Commit your changes or finish the Git operation in progress first.",
			);
		const worktrees = await git(path, ["worktree", "list", "--porcelain"]);
		if (
			!checkedOutHere &&
			(worktrees.split("\n").includes(`branch ${operation.ref}`) ||
				(await busyElsewhere(state.commonDir, operation.ref)))
		)
			return refuse(
				"checked-out-elsewhere",
				"The branch is checked out in another worktree. Restore it from there.",
			);
		if (options.dryRun) return { ...base, from: current, result: "planned" };

		const backup = `refs/clonelane/backups/${randomUUID()}`;
		await git(path, ["update-ref", backup, current]);
		const restoreId = await begin(state.commonDir, {
			workspace: workspace.name,
			path,
			kind: "restore",
			ref: operation.ref,
			from: current,
			to: operation.from,
			backup,
		});
		// Another tool may have committed since the checks above; never drop that commit.
		if ((await read(operation.ref)) !== current) {
			await finish(state.commonDir, restoreId, "failed");
			return refuse(
				"moved-since",
				"The branch moved while restoring. Nothing was changed.",
			);
		}
		try {
			// --keep refuses to drop local changes; update-ref moves only if the tip is unchanged.
			if (checkedOutHere) await git(path, ["reset", "--keep", operation.from]);
			else
				await git(path, ["update-ref", operation.ref, operation.from, current]);
		} catch (error) {
			await finish(state.commonDir, restoreId, "failed");
			throw error;
		}
		await finish(state.commonDir, restoreId, "done", operation.from);
		return { ...base, from: current, result: "restored", backup };
	};
	return options.dryRun
		? run()
		: withLock(join(initial.commonDir, "clonelane.lock"), run);
}
