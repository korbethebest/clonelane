import { rm } from "node:fs/promises";
import { join } from "node:path";

import { fail } from "./errors.ts";
import { atomicWrite, readOptional, withLock } from "./files.ts";
import { checkIdentity, type Workspace } from "./workspaces.ts";

/**
 * A note that a workspace is in use: by whom, why and until when. Clonelane leaves a
 * workspace leased by someone else alone (sync skips it, env and restore refuse it) unless
 * the caller says it is that holder. A lease is advisory: Git and editors ignore it.
 */
export interface Lease {
	holder: string;
	note?: string;
	/** When the holder took it (ISO 8601); a renewal keeps it. */
	since: string;
	/** When it lapses on its own (ISO 8601), so a crashed holder never blocks forever. */
	until: string;
}

// Per checkout (worktrees each have their own), next to Git's own per-worktree state.
const FILE = "clonelane-lease.json";
const HOLDER = /^[A-Za-z0-9][A-Za-z0-9._@-]{0,63}$/;
export const DEFAULT_MINUTES = 120;
const MAX_MINUTES = 7 * 24 * 60;

function validLease(data: Partial<Lease> | null): data is Lease {
	return (
		data != null &&
		typeof data.holder === "string" &&
		HOLDER.test(data.holder) &&
		(data.note === undefined || typeof data.note === "string") &&
		typeof data.since === "string" &&
		typeof data.until === "string" &&
		!Number.isNaN(Date.parse(data.until))
	);
}

/**
 * The lease in a checkout's own .git directory, or null when there is none or it lapsed.
 * An unreadable lease file counts as held (by "unknown"), so nothing tramples on it;
 * releasing with force clears it.
 */
export async function readLease(
	gitDir: string,
	now = Date.now(),
): Promise<Lease | null> {
	const raw = await readOptional(join(gitDir, FILE));
	if (raw == null) return null;
	let data: Partial<Lease> | null = null;
	try {
		data = JSON.parse(raw);
	} catch {
		// Falls through to the unreadable case.
	}
	if (!validLease(data))
		return {
			holder: "unknown",
			note: "unreadable lease file",
			since: "",
			until: new Date(8.64e15).toISOString(),
		};
	return Date.parse(data.until) > now ? data : null;
}

/** True when a lease stops `as` (a holder name, or nobody) from changing the workspace. */
export const blocks = (lease: Lease | null | undefined, as?: string) =>
	lease != null && lease.holder !== as;

export function leasedMessage(name: string, lease: Lease): string {
	return `${name} is in use by ${lease.holder}${lease.note ? ` (${lease.note})` : ""} until ${lease.until}. Wait, or act as that holder.`;
}

/**
 * Takes or renews a lease. Another holder's live lease is refused; the same holder renews
 * it (keeping since, moving until). Taken under the clone's Clonelane lock.
 */
export async function takeLease(
	workspace: Workspace,
	input: { holder: string; note?: string; minutes?: number },
): Promise<Lease> {
	if (!HOLDER.test(input.holder))
		fail(
			"LEASE_HOLDER",
			"The holder name may contain only letters, digits, dots, underscores, @ and hyphens, up to 64 characters.",
		);
	const note = input.note?.trim() || undefined;
	if (note && (note.length > 200 || /\p{Cc}/u.test(note)))
		fail("LEASE_NOTE", "Keep the note to one line of at most 200 characters.");
	const minutes = input.minutes ?? DEFAULT_MINUTES;
	if (!Number.isInteger(minutes) || minutes < 1 || minutes > MAX_MINUTES)
		fail("LEASE_TIME", `Lease for 1 to ${MAX_MINUTES} minutes.`);
	const { commonDir, gitDir } = await checkIdentity(workspace);
	return withLock(join(commonDir, "clonelane.lock"), async () => {
		const now = Date.now();
		const current = await readLease(gitDir, now);
		if (current && current.holder !== input.holder)
			fail("LEASED", leasedMessage(workspace.name, current));
		const lease: Lease = {
			holder: input.holder,
			...(note ? { note } : {}),
			since: current?.since || new Date(now).toISOString(),
			until: new Date(now + minutes * 60_000).toISOString(),
		};
		await atomicWrite(join(gitDir, FILE), `${JSON.stringify(lease)}\n`);
		return lease;
	});
}

/**
 * Releases a lease. Only its holder may, unless `force` (for a holder that is gone).
 * A lapsed or missing lease is simply cleared. Returns the lease that was released.
 */
export async function releaseLease(
	workspace: Workspace,
	input: { holder?: string; force?: boolean } = {},
): Promise<Lease | null> {
	const { commonDir, gitDir } = await checkIdentity(workspace);
	return withLock(join(commonDir, "clonelane.lock"), async () => {
		const current = await readLease(gitDir);
		if (current && current.holder !== input.holder && !input.force)
			fail("LEASED", leasedMessage(workspace.name, current));
		await rm(join(gitDir, FILE), { force: true });
		return current;
	});
}

/** The live lease of a workspace, or null. */
export async function workspaceLease(
	workspace: Workspace,
): Promise<Lease | null> {
	return readLease((await checkIdentity(workspace)).gitDir);
}
