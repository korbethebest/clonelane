import { randomUUID } from "node:crypto";
import { join } from "node:path";

import { fail } from "./errors.ts";
import { withLock } from "./files.ts";
import { git, gitSucceeds, moveRefLocked } from "./git.ts";
import { begin, finish, type Operation, readOperations } from "./journal.ts";
import { blocks, leasedMessage } from "./lease.ts";
import { busyElsewhere } from "./sync.ts";
import {
	assertIdentity,
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
	const operations = await readOperations(await assertIdentity(workspace));
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
	options: { dryRun?: boolean; as?: string } = {},
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
		// The ref comes from a file on disk: only a well-formed branch name reaches Git.
		if (!(await gitSucceeds(path, ["check-ref-format", operation.ref])))
			fail("INVALID_RECORD", `Operation ${id} has a malformed branch name.`);
		const current = await read(operation.ref);
		const refuse = (reason: string, message: string): RestoreResult => ({
			...base,
			from: current ?? "",
			result: "refused",
			reason,
			message,
		});
		if (state.lease && blocks(state.lease, options.as))
			return refuse("leased", leasedMessage(workspace.name, state.lease));
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
		if (left === undefined)
			return refuse(
				"outcome-unknown",
				`The rebase stopped before recording where it left the branch. Inspect the branch and, if you want the old commit back, use the backup ref ${operation.backup} with Git.`,
			);
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
		// Git holds the branch's ref lock from the tip check until the move, so a commit made
		// by another tool meanwhile fails loudly instead of being dropped.
		let treeMoved = false;
		try {
			// Not checked out: update-ref's own old-value check is already atomic.
			if (!checkedOutHere)
				await git(path, ["update-ref", operation.ref, operation.from, current]);
			else
				await moveRefLocked(
					path,
					operation.ref,
					{ oldTip: current, newTip: operation.from },
					async () => {
						// Two-tree read-tree is what reset --keep does: it refuses to drop local changes.
						await git(path, ["read-tree", "-m", "-u", current, operation.from]);
						treeMoved = true;
					},
				);
		} catch (error) {
			await finish(state.commonDir, restoreId, "failed");
			const now = await read(operation.ref);
			// The ref did not move but the files did: put the files back. If that fails too,
			// the original error is still the one reported.
			if (treeMoved && now === current)
				await git(path, [
					"read-tree",
					"-m",
					"-u",
					operation.from,
					current,
				]).catch(() => {});
			if (!treeMoved && now != null && now !== current)
				return refuse(
					"moved-since",
					"The branch moved while restoring. Nothing was changed.",
				);
			throw error;
		}
		await finish(state.commonDir, restoreId, "done", operation.from);
		return { ...base, from: current, result: "restored", backup };
	};
	return options.dryRun
		? run()
		: withLock(join(initial.commonDir, "clonelane.lock"), run);
}
