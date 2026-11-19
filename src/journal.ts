import { randomBytes } from "node:crypto";
import { appendFile, stat } from "node:fs/promises";
import { join } from "node:path";

import { atomicWrite, exists, readOptional } from "./files.ts";

/**
 * One branch move made by Clonelane. The journal lives in the shared Git directory, so every
 * linked worktree of a clone sees the same history, and it is never committed.
 */
export interface Operation {
	id: string;
	/** When the move started (ISO 8601). */
	time: string;
	workspace: string;
	path: string;
	kind: "fast-forward" | "rebase" | "base-fast-forward" | "restore";
	/** The branch that moved, as a full ref such as refs/heads/main. */
	ref: string;
	/** Tip before the move; the backup ref points here. */
	from: string;
	/** Commit the move aimed at (the base, or the restored commit). */
	to: string;
	backup: string;
	/** Tip after a finished move. */
	tip?: string;
	/**
	 * started: in progress. interrupted: started, but no Clonelane holds the lock any more, so
	 * the process stopped before recording the outcome.
	 */
	state: "started" | "done" | "failed" | "interrupted";
	finished?: string;
}

type Start = Omit<Operation, "id" | "time" | "state" | "tip" | "finished">;

const file = (commonDir: string) => join(commonDir, "clonelane-journal.jsonl");
// Keep the journal small: past this size only the most recent entries are kept.
const MAX_BYTES = 512 * 1024;
const KEEP_LINES = 1000;

async function append(commonDir: string, record: object): Promise<void> {
	const path = file(commonDir);
	if ((await exists(path)) && (await stat(path)).size > MAX_BYTES) {
		const lines = ((await readOptional(path)) ?? "")
			.split("\n")
			.filter(Boolean);
		await atomicWrite(path, `${lines.slice(-KEEP_LINES).join("\n")}\n`);
	}
	await appendFile(path, `${JSON.stringify(record)}\n`, { mode: 0o600 });
}

/** Records the start of a move and returns its id. Call it under the clone's lock. */
export async function begin(commonDir: string, start: Start): Promise<string> {
	const id = randomBytes(4).toString("hex");
	await append(commonDir, {
		id,
		time: new Date().toISOString(),
		state: "started",
		...start,
	});
	return id;
}

/**
 * Records the outcome. It never throws: the move has already happened (or failed), and an
 * unrecorded outcome later reads as "interrupted", which is the safe direction.
 */
export async function finish(
	commonDir: string,
	id: string,
	state: "done" | "failed",
	tip?: string,
): Promise<void> {
	await append(commonDir, {
		id,
		state,
		tip,
		finished: new Date().toISOString(),
	}).catch(() => {});
}

/**
 * All recorded moves of a clone, newest first. Pass `holdingLock` when the caller holds the
 * clone's lock itself, so a leftover "started" entry still reads as interrupted.
 */
export async function readOperations(
	commonDir: string,
	holdingLock = false,
): Promise<Operation[]> {
	const raw = await readOptional(file(commonDir)).catch(() => null);
	const operations = new Map<string, Operation>();
	for (const line of (raw ?? "").split("\n")) {
		if (!line.trim()) continue;
		let record: Partial<Operation>;
		try {
			record = JSON.parse(line);
		} catch {
			continue; // A torn last line from a hard stop is ignored.
		}
		if (typeof record.id !== "string") continue;
		const known = operations.get(record.id);
		if (record.state === "started" && !known)
			operations.set(record.id, record as Operation);
		else if (known) Object.assign(known, record);
	}
	const running =
		!holdingLock && (await exists(join(commonDir, "clonelane.lock")));
	return [...operations.values()]
		.map((operation) =>
			operation.state === "started" && !running
				? { ...operation, state: "interrupted" as const }
				: operation,
		)
		.reverse();
}
