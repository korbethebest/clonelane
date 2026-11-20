import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { parseEnv } from "node:util";

import { ClonelaneError, fail } from "./errors.ts";
import { atomicWrite, readOptional, withLock } from "./files.ts";
import { gitSucceeds } from "./git.ts";
import { blocks, leasedMessage, workspaceLease } from "./lease.ts";
import type { EnvProfile, Registry } from "./registry.ts";
import {
	assertIdentity,
	inspectWorkspace,
	type Workspace,
} from "./workspaces.ts";

export interface EnvOptions {
	file: string;
	/** "all" copies every key the source file defines; target-only keys are kept. */
	keys: string[] | "all";
	overwrite?: boolean;
	publicKeys?: string[];
	/** Keys that stay local in the target: never added or overwritten, reported as "kept". */
	keep?: string[];
	/** Act as this lease holder: a target leased by anyone else is refused (LEASED). */
	as?: string;
	/**
	 * With keys "all": also remove target keys the source does not define (state "remove"),
	 * except kept ones. Applying a removal needs overwrite, like a conflict.
	 */
	prune?: boolean;
}

export interface EnvChange {
	key: string;
	state: "add" | "same" | "conflict" | "kept" | "remove";
}
export interface EnvPlan {
	source: string;
	target: string;
	file: string;
	changes: EnvChange[];
}

const KEY = /^[A-Za-z_][A-Za-z0-9_]*$/;

export function validateFile(file: string): void {
	if (!/^\.env(?:\.[a-zA-Z0-9_-]+)*$/.test(file))
		fail("ENV_FILE", "Choose an .env filename without directory components.");
}

// Explicit selections only: copying the whole file mirrors what the source already
// exposes, so browser-exposed keys need no separate acknowledgement there.
export function validateKeys(options: EnvOptions): void {
	const keep = options.keep ?? [];
	if (new Set(keep).size !== keep.length || keep.some((key) => !KEY.test(key)))
		fail("ENV_KEYS", "Kept keys must be unique variable names.");
	if (options.keys === "all") return;
	// Only a whole-file mirror can say which keys the target should no longer have.
	if (options.prune)
		fail("ENV_KEYS", "Removing keys the source lacks needs all keys.");
	if (
		options.keys.length === 0 ||
		new Set(options.keys).size !== options.keys.length ||
		options.keys.some((key) => !KEY.test(key))
	) {
		fail(
			"ENV_KEYS",
			"Select an explicit, nonempty list of unique variable names.",
		);
	}
	if ((options.publicKeys ?? []).some((key) => !options.keys.includes(key)))
		fail("ENV_KEYS", "Public keys must belong to the selected keys.");
	// A kept key is never copied, so it needs no acknowledgement.
	if (
		options.keys.some(
			(key) =>
				!keep.includes(key) &&
				/^(VITE_|NEXT_PUBLIC_|PUBLIC_)/.test(key) &&
				!options.publicKeys?.includes(key),
		)
	) {
		fail(
			"PUBLIC_VARIABLE",
			"Browser-exposed variables require explicit --public-keys acknowledgement. Never select a server secret.",
		);
	}
}

async function readEnv(
	workspace: Workspace,
	file: string,
): Promise<{ raw: string | null; values: Record<string, string> }> {
	await assertIdentity(workspace);
	// On case-insensitive volumes ".env" opens ".ENV": the name on disk must match exactly,
	// and no case variant of it may be tracked.
	const names = await readdir(workspace.path);
	if (
		names.some(
			(name) => name !== file && name.toLowerCase() === file.toLowerCase(),
		)
	)
		fail(
			"ENV_CASE",
			`Another file differs from ${file} only in letter case. Rename or remove it first.`,
		);
	if (
		await gitSucceeds(workspace.path, [
			"ls-files",
			"--error-unmatch",
			"--",
			`:(icase)${file}`,
		])
	)
		fail("TRACKED_ENV", "Environment files must not be tracked by Git.");
	if (
		!(await gitSucceeds(workspace.path, [
			"check-ignore",
			"--quiet",
			"--",
			file,
		]))
	)
		fail(
			"ENV_NOT_IGNORED",
			"Environment files must be ignored by Git before synchronization.",
		);
	const raw = await readOptional(join(workspace.path, file));
	if (raw != null && Buffer.byteLength(raw) > 1024 * 1024)
		fail("ENV_TOO_LARGE", "Environment file exceeds the 1 MiB limit.");
	try {
		const values = Object.fromEntries(
			Object.entries(parseEnv(raw ?? "")).filter(
				(entry): entry is [string, string] => entry[1] != null,
			),
		);
		return { raw, values };
	} catch {
		fail(
			"ENV_PARSE",
			"Could not parse environment file. Contents were suppressed.",
		);
	}
}

async function prepare(
	source: Workspace,
	target: Workspace,
	options: EnvOptions,
) {
	validateFile(options.file);
	validateKeys(options);
	if (source.path === target.path)
		fail("ENV_SAME_TARGET", "Source and target must differ.");
	if (source.repository !== target.repository || source.group !== target.group)
		fail(
			"ENV_GROUP",
			`"${source.name}" is in group "${source.group}" and "${target.name}" is in group "${target.group}". Keys are only copied between workspaces in the same group; move one of them into the other's group first.`,
		);
	const lease = await workspaceLease(target);
	if (lease && blocks(lease, options.as))
		fail("LEASED", leasedMessage(target.name, lease));
	const from = await readEnv(source, options.file);
	const to = await readEnv(target, options.file);
	if (from.raw == null)
		fail("ENV_SOURCE_MISSING", "Source environment file does not exist.");
	// Mirroring an empty source would empty every target: refuse instead.
	if (options.prune && Object.keys(from.values).length === 0)
		fail(
			"ENV_SOURCE_EMPTY",
			"The source file defines no keys, so removing the keys it lacks would empty the target.",
		);
	const keys =
		options.keys === "all" ? Object.keys(from.values).sort() : options.keys;
	const changes: EnvChange[] = [];
	for (const key of keys) {
		if (options.keep?.includes(key)) {
			changes.push({ key, state: "kept" });
			continue;
		}
		if (!Object.hasOwn(from.values, key))
			fail("ENV_KEY_MISSING", "A selected variable is absent from the source.");
		const state = !Object.hasOwn(to.values, key)
			? "add"
			: from.values[key] === to.values[key]
				? "same"
				: "conflict";
		changes.push({ key, state });
	}
	if (options.prune)
		for (const key of Object.keys(to.values).sort())
			if (!Object.hasOwn(from.values, key))
				changes.push({
					key,
					state: options.keep?.includes(key) ? "kept" : "remove",
				});
	const plan: EnvPlan = {
		source: source.name,
		target: target.name,
		file: options.file,
		changes,
	};
	return { from, to, plan };
}

export async function planEnv(
	source: Workspace,
	target: Workspace,
	options: EnvOptions,
): Promise<EnvPlan> {
	return (await prepare(source, target, options)).plan;
}

function serialize(values: Record<string, string>): string {
	const content = `${Object.keys(values)
		.sort()
		.map((key) => {
			const value = values[key] ?? "";
			// Node's dotenv grammar permits multiline quoted values but has no quote escaping.
			const quote = ["'", '"', "`"].find(
				(candidate) => !value.includes(candidate),
			);
			if (!quote || value.includes("\r") || value.includes("\0"))
				fail(
					"ENV_VALUE",
					"A value cannot be represented safely in the supported dotenv format.",
				);
			return `${key}=${quote}${value}${quote}`;
		})
		.join("\n")}\n`;
	const roundtrip = parseEnv(content);
	if (Object.keys(values).some((key) => roundtrip[key] !== values[key]))
		fail(
			"ENV_VALUE",
			"A value cannot be round-tripped safely. No file was written.",
		);
	return content;
}

export async function applyEnv(
	source: Workspace,
	target: Workspace,
	options: EnvOptions,
): Promise<EnvPlan> {
	const state = await inspectWorkspace(target);
	return withLock(join(state.commonDir, "clonelane.lock"), async () => {
		const { from, to, plan } = await prepare(source, target, options);
		if (
			!options.overwrite &&
			plan.changes.some((change) =>
				["conflict", "remove"].includes(change.state),
			)
		)
			fail(
				"ENV_CONFLICT",
				"Target values differ or keys would be removed. Review the key-only plan and explicitly enable overwrite.",
			);
		if (plan.changes.every((change) => ["same", "kept"].includes(change.state)))
			return plan;
		const merged = Object.assign(
			Object.create(null) as Record<string, string>,
			to.values,
		);
		for (const { key, state } of plan.changes)
			if (state === "remove") delete merged[key];
			else if (state !== "kept") merged[key] = from.values[key] ?? "";
		const content = serialize(merged);
		// Compare again before replacement; do not silently discard an editor's update.
		const latestSource = await readEnv(source, options.file);
		const latestTarget = await readEnv(target, options.file);
		if (latestSource.raw !== from.raw || latestTarget.raw !== to.raw)
			fail(
				"ENV_CHANGED",
				"Environment files changed during planning. Retry after reviewing them.",
			);
		await atomicWrite(join(target.path, options.file), content);
		return plan;
	});
}

export interface ProfileResult {
	target: string;
	/** Present when this target was planned or written. */
	plan?: EnvPlan;
	error?: string;
	message?: string;
}

/**
 * Plans (dryRun) or applies an env profile (a saved one by name, or an unsaved one) from its
 * source to its targets: every other workspace in the source's group, or only those listed,
 * each with its own kept keys. Targets are handled independently (previews in parallel,
 * writes one at a time): one target's conflict or error is reported and does not stop the
 * others.
 */
export async function syncEnvProfile(
	registry: Registry,
	which: string | EnvProfile,
	options: { dryRun?: boolean; overwrite?: boolean; as?: string } = {},
): Promise<ProfileResult[]> {
	const profile =
		typeof which === "string"
			? registry.profiles?.find((item) => item.name === which)
			: which;
	if (!profile) fail("PROFILE", `Env profile "${which}" does not exist.`);
	const source = registry.workspaces.find(
		(item) => item.name === profile.source,
	);
	if (!source)
		fail("WORKSPACE", `Workspace "${profile.source}" is not registered.`);
	const members = registry.workspaces.filter(
		(item) => item.group === source.group && item !== source,
	);
	const unknown = profile.targets?.find(
		(name) => !members.some((item) => item.name === name),
	);
	if (unknown)
		fail(
			"PROFILE_TARGET",
			`"${unknown}" is not another workspace in group "${source.group}".`,
		);
	const listed = profile.targets;
	const targets = listed
		? members.filter((item) => listed.includes(item.name))
		: members;
	if (targets.length === 0)
		fail(
			"EMPTY",
			listed
				? "This profile has no targets left."
				: `No other workspace is in group "${source.group}".`,
		);
	const one = async (target: Workspace): Promise<ProfileResult> => {
		try {
			const plan = await (options.dryRun ? planEnv : applyEnv)(source, target, {
				file: profile.file,
				keys: profile.keys,
				publicKeys: profile.publicKeys,
				prune: profile.prune,
				// Own entries only: a workspace may be named like an Object member.
				keep:
					profile.keep && Object.hasOwn(profile.keep, target.name)
						? profile.keep[target.name]
						: undefined,
				overwrite: options.overwrite,
				as: options.as,
			});
			return { target: target.name, plan };
		} catch (error) {
			return {
				target: target.name,
				...(error instanceof ClonelaneError
					? { error: error.code, message: error.message }
					: {
							error: "FAILED",
							message:
								"Operation failed. Details were suppressed to protect local secrets.",
						}),
			};
		}
	};
	// A preview only reads, so targets are compared in parallel. Writes go one at a time:
	// worktrees of one clone share the lock that applyEnv takes.
	if (options.dryRun) {
		// At most four at once: each target starts several Git processes.
		const results: ProfileResult[] = new Array(targets.length);
		let next = 0;
		const worker = async () => {
			while (next < targets.length) {
				const index = next++;
				results[index] = await one(targets[index] as Workspace);
			}
		};
		await Promise.all(
			Array.from({ length: Math.min(4, targets.length) }, worker),
		);
		return results;
	}
	const results: ProfileResult[] = [];
	for (const target of targets) results.push(await one(target));
	return results;
}
