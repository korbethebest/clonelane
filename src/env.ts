import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { parseEnv } from "node:util";

import { fail } from "./errors.ts";
import { atomicWrite, readOptional, withLock } from "./files.ts";
import { gitSucceeds } from "./git.ts";
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
}

export interface EnvChange {
	key: string;
	state: "add" | "same" | "conflict";
}
export interface EnvPlan {
	source: string;
	target: string;
	file: string;
	changes: EnvChange[];
}

function validateFile(file: string): void {
	if (!/^\.env(?:\.[a-zA-Z0-9_-]+)*$/.test(file))
		fail("ENV_FILE", "Choose an .env filename without directory components.");
}

// Explicit selections only: copying the whole file mirrors what the source already
// exposes, so browser-exposed keys need no separate acknowledgement there.
function validateKeys(options: EnvOptions & { keys: string[] }): void {
	if (
		options.keys.length === 0 ||
		new Set(options.keys).size !== options.keys.length ||
		options.keys.some((key) => !/^[A-Za-z_][A-Za-z0-9_]*$/.test(key))
	) {
		fail(
			"ENV_KEYS",
			"Select an explicit, nonempty list of unique variable names.",
		);
	}
	if ((options.publicKeys ?? []).some((key) => !options.keys.includes(key)))
		fail("ENV_KEYS", "Public keys must belong to the selected keys.");
	if (
		options.keys.some(
			(key) =>
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
	if (options.keys !== "all") validateKeys({ ...options, keys: options.keys });
	if (source.path === target.path)
		fail("ENV_SAME_TARGET", "Source and target must differ.");
	if (source.repository !== target.repository || source.group !== target.group)
		fail(
			"ENV_GROUP",
			`"${source.name}" is in group "${source.group}" and "${target.name}" is in group "${target.group}". Keys are only copied between workspaces in the same group; move one of them into the other's group first.`,
		);
	const from = await readEnv(source, options.file);
	const to = await readEnv(target, options.file);
	if (from.raw == null)
		fail("ENV_SOURCE_MISSING", "Source environment file does not exist.");
	const keys =
		options.keys === "all" ? Object.keys(from.values).sort() : options.keys;
	const changes: EnvChange[] = [];
	for (const key of keys) {
		if (!Object.hasOwn(from.values, key))
			fail("ENV_KEY_MISSING", "A selected variable is absent from the source.");
		const state = !Object.hasOwn(to.values, key)
			? "add"
			: from.values[key] === to.values[key]
				? "same"
				: "conflict";
		changes.push({ key, state });
	}
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
			plan.changes.some((change) => change.state === "conflict")
		)
			fail(
				"ENV_CONFLICT",
				"Target values differ. Review the key-only plan and explicitly enable overwrite.",
			);
		if (plan.changes.every((change) => change.state === "same")) return plan;
		const merged = Object.assign(
			Object.create(null) as Record<string, string>,
			to.values,
		);
		for (const { key } of plan.changes) merged[key] = from.values[key] ?? "";
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
