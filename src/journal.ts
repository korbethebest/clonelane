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
	/** The Clonelane process that made the move. */
	pid?: number;
}

type Start = Omit<
	Operation,
	"id" | "time" | "state" | "tip" | "finished" | "pid"
>;

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
	const id = randomBytes(8).toString("hex");
	await append(commonDir, {
		id,
		time: new Date().toISOString(),
		state: "started",
		pid: process.pid,
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

const sha = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
// A damaged or edited line is skipped like a torn one, so readers and restore can trust it.
const complete = (record: Partial<Operation>) =>
	["time", "workspace", "path", "kind"].every(
		(field) => typeof record[field as keyof Operation] === "string",
	) &&
	typeof record.ref === "string" &&
	record.ref.startsWith("refs/heads/") &&
	typeof record.backup === "string" &&
	record.backup.startsWith("refs/clonelane/backups/") &&
	sha.test(String(record.from)) &&
	sha.test(String(record.to));

// The pid in the lock, "unknown" while its holder is still writing it, or null when no
// live process holds it (a lock left by a killed process does not count).
async function lockHolder(
	commonDir: string,
): Promise<number | "unknown" | null> {
	const text = await readOptional(join(commonDir, "clonelane.lock")).catch(
		() => "",
	);
	if (text == null) return null;
	const pid = Number(text.trim());
	if (!Number.isInteger(pid) || pid <= 0) return "unknown";
	try {
		process.kill(pid, 0);
		return pid;
	} catch (error) {
		return (error as NodeJS.ErrnoException).code === "EPERM" ? pid : null;
	}
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
		if (record.state === "started") {
			// A repeated id never replaces the operation recorded first.
			if (!known && complete(record))
				operations.set(record.id, record as Operation);
		} else if (
			known?.state === "started" &&
			(record.state === "done" || record.state === "failed")
		) {
			// An outcome only sets the outcome fields.
			known.state = record.state;
			if (typeof record.tip === "string" && sha.test(record.tip))
				known.tip = record.tip;
			if (typeof record.finished === "string") known.finished = record.finished;
		}
	}
	const holder = holdingLock ? null : await lockHolder(commonDir);
	// Still running only if the live lock holder is the process that started it. Entries from
	// before pids were recorded fall back to any live holder.
	const running = (operation: Operation) =>
		holder === "unknown" ||
		(holder != null && (operation.pid == null || operation.pid === holder));
	return [...operations.values()]
		.map((operation) =>
			operation.state === "started" && !running(operation)
				? { ...operation, state: "interrupted" as const }
				: operation,
		)
		.reverse();
}
