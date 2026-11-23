import { randomUUID } from "node:crypto";
import { join } from "node:path";

import { fail } from "./errors.ts";
import { withLock } from "./files.ts";
import { git, gitSucceeds } from "./git.ts";
import { blocks, leasedMessage } from "./lease.ts";
import { busyElsewhere } from "./sync.ts";
import {
	inspectWorkspace,
	type Workspace,
	type WorkspaceStatus,
} from "./workspaces.ts";

/**
 * Everyday branch work in one workspace: switch, create, rename and delete local
 * branches. Each runs under the clone's Clonelane lock, respects leases, and never
 * stashes, discards or force-moves anything; a deleted branch's tip is kept as a backup.
 */

type Options = { as?: string };

async function locked<T>(
	workspace: Workspace,
	options: Options,
	run: (state: WorkspaceStatus) => Promise<T>,
): Promise<T> {
	const first = await inspectWorkspace(workspace);
	return withLock(join(first.commonDir, "clonelane.lock"), async () => {
		const state = await inspectWorkspace(workspace);
		if (state.lease && blocks(state.lease, options.as))
			fail("LEASED", leasedMessage(workspace.name, state.lease));
		return run(state);
	});
}

// Names come from the user: only a well-formed branch name ever reaches Git.
async function checkName(path: string, name: unknown): Promise<string> {
	if (
		typeof name !== "string" ||
		!name ||
		name.startsWith("-") ||
		name.includes("@{") ||
		!(await gitSucceeds(path, ["check-ref-format", `refs/heads/${name}`]))
	)
		fail(
			"BRANCH_NAME",
			"Use a branch name without spaces or ~ ^ : ? * [ \\, not starting with - or ending with .lock.",
		);
	return name;
}

const exists = (path: string, ref: string) =>
	gitSucceeds(path, ["rev-parse", "--verify", "--quiet", ref]);

async function mustExist(path: string, name: string): Promise<string> {
	const ref = `refs/heads/${name}`;
	if (!(await exists(path, ref)))
		fail("BRANCH_MISSING", `There is no local branch "${name}".`);
	return ref;
}

// Checked out (or mid-rebase or bisect) in another worktree of this clone.
async function elsewhere(state: WorkspaceStatus, ref: string) {
	if (state.branch === ref.slice("refs/heads/".length)) return false;
	const listed = (
		await git(state.workspace.path, ["worktree", "list", "--porcelain"])
	)
		.split("\n")
		.includes(`branch ${ref}`);
	return listed || busyElsewhere(state.commonDir, ref);
}

function clean(state: WorkspaceStatus) {
	if (state.dirty || state.operation)
		fail(
			"WORKSPACE_BUSY",
			"Commit your changes or finish the Git operation in progress first. Clonelane never stashes.",
		);
}

/** Checks out another local branch. Refused with uncommitted changes. */
export async function switchBranch(
	workspace: Workspace,
	name: string,
	options: Options = {},
): Promise<{ branch: string; switched: boolean }> {
	return locked(workspace, options, async (state) => {
		const path = workspace.path;
		const ref = await mustExist(path, await checkName(path, name));
		if (state.branch === name) return { branch: name, switched: false };
		clean(state);
		if (await elsewhere(state, ref))
			fail(
				"BRANCH_CHECKED_OUT",
				`"${name}" is checked out in another worktree, or a rebase or bisect is using it. Switch there, or pick another branch.`,
			);
		await git(path, ["switch", "--no-guess", "--quiet", name]);
		return { branch: name, switched: true };
	});
}

/**
 * Creates a local branch at `from` (the current commit, a local branch or a
 * remote-tracking branch such as origin/main), optionally switching to it. Switching to
 * a branch made at the current commit keeps uncommitted changes as they are; from
 * anywhere else it needs a clean workspace, like any switch.
 */
export async function createBranch(
	workspace: Workspace,
	input: { name: string; from?: string; switch?: boolean },
	options: Options = {},
): Promise<{ branch: string; head: string; switched: boolean }> {
	return locked(workspace, options, async (state) => {
		const path = workspace.path;
		const name = await checkName(path, input.name);
		if (await exists(path, `refs/heads/${name}`))
			fail("BRANCH_EXISTS", `A branch named "${name}" already exists.`);
		let start = "HEAD";
		if (input.from) {
			const local = `refs/heads/${input.from}`;
			const remote = `refs/remotes/${input.from}`;
			if (
				input.from.startsWith("-") ||
				!(await gitSucceeds(path, ["check-ref-format", local]))
			)
				fail("BRANCH_MISSING", "Start from a local or remote branch.");
			start = (await exists(path, local))
				? local
				: (await exists(path, remote))
					? remote
					: fail("BRANCH_MISSING", `There is no branch "${input.from}".`);
		}
		const head = await git(path, [
			"rev-parse",
			"--verify",
			`${start}^{commit}`,
		]);
		if (!input.switch) {
			await git(path, ["branch", "--no-track", name, head]);
			return { branch: name, head, switched: false };
		}
		if (state.operation || (state.dirty && head !== state.head)) clean(state);
		await git(path, ["switch", "--no-track", "--quiet", "-c", name, head]);
		return { branch: name, head, switched: true };
	});
}

/** Renames a local branch (its upstream setting moves with it). Not the base branch. */
export async function renameBranch(
	workspace: Workspace,
	input: { from: string; to: string },
	options: Options = {},
): Promise<{ from: string; to: string }> {
	return locked(workspace, options, async (state) => {
		const path = workspace.path;
		const ref = await mustExist(path, await checkName(path, input.from));
		const to = await checkName(path, input.to);
		if (input.from === workspace.base)
			fail(
				"BRANCH_BASE",
				`"${input.from}" is this workspace's base branch; Clonelane syncs it by that name.`,
			);
		if (to === input.from) return { from: input.from, to };
		if (await exists(path, `refs/heads/${to}`))
			fail("BRANCH_EXISTS", `A branch named "${to}" already exists.`);
		if (await busyElsewhere(state.commonDir, ref))
			fail(
				"BRANCH_CHECKED_OUT",
				`"${input.from}" is in use by a rebase or bisect. Finish or abort it first.`,
			);
		await git(path, ["branch", "-m", input.from, to]);
		return { from: input.from, to };
	});
}

export interface DeleteResult {
	branch: string;
	tip: string;
	/** Commits on no other branch, remote-tracking branch or tag: what deleting would hide. */
	unique: number;
	result: "planned" | "deleted";
	/** Where the tip is kept; recreate the branch with `git branch <name> <backup>`. */
	backup?: string;
}

/**
 * Deletes a local branch that is neither checked out (here or in another worktree) nor
 * the base branch. Its tip is backed up first, so nothing is lost. dryRun reports what
 * the branch holds that no other branch does, for the confirmation.
 */
export async function deleteBranch(
	workspace: Workspace,
	name: string,
	options: Options & { dryRun?: boolean } = {},
): Promise<DeleteResult> {
	const run = async (state: WorkspaceStatus): Promise<DeleteResult> => {
		const path = workspace.path;
		const ref = await mustExist(path, await checkName(path, name));
		if (state.branch === name)
			fail(
				"BRANCH_CURRENT",
				`"${name}" is checked out. Switch to another branch first.`,
			);
		if (name === workspace.base)
			fail(
				"BRANCH_BASE",
				`"${name}" is this workspace's base branch; Clonelane syncs it.`,
			);
		if (await elsewhere(state, ref))
			fail(
				"BRANCH_CHECKED_OUT",
				`"${name}" is checked out in another worktree, or a rebase or bisect is using it.`,
			);
		const tip = await git(path, ["rev-parse", "--verify", ref]);
		const unique = Number(
			await git(path, [
				"rev-list",
				"--count",
				ref,
				"--not",
				// --exclude matches names as --branches lists them (no refs/heads/); names hold no globs.
				`--exclude=${name}`,
				"--branches",
				"--remotes",
				"--tags",
				"--",
			]),
		);
		if (options.dryRun) return { branch: name, tip, unique, result: "planned" };
		const backup = `refs/clonelane/backups/${randomUUID()}`;
		await git(path, ["update-ref", backup, tip]);
		// Only the tip that was backed up: a commit made meanwhile fails this instead.
		await git(path, ["update-ref", "-d", ref, tip]);
		await git(path, ["config", "--remove-section", `branch.${name}`]).catch(
			() => {},
		);
		return { branch: name, tip, unique, result: "deleted", backup };
	};
	if (options.dryRun) {
		const state = await inspectWorkspace(workspace);
		if (state.lease && blocks(state.lease, options.as))
			fail("LEASED", leasedMessage(workspace.name, state.lease));
		return run(state);
	}
	return locked(workspace, options, run);
}
