import { mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";

import { validateFile, validateKeys } from "./env.ts";
import { fail } from "./errors.ts";
import { atomicWrite, readOptional, withLock } from "./files.ts";
import { validName } from "./git.ts";
import { registerWorkspace, type Workspace } from "./workspaces.ts";

/**
 * A saved .env share: which file and keys to copy from one workspace to the rest of its
 * group, and which keys each target keeps local. Key names only; never values.
 */
export interface EnvProfile {
	name: string;
	/** The workspace copied from. The targets are the other workspaces in its group. */
	source: string;
	file: string;
	keys: string[] | "all";
	publicKeys?: string[];
	/** Per target workspace name: keys that stay local there (never added or overwritten). */
	keep?: Record<string, string[]>;
	/** Also remove target keys the source lacks (needs keys "all"). */
	prune?: boolean;
}

export interface Registry {
	version: 1;
	workspaces: Workspace[];
	profiles?: EnvProfile[];
}

const strings = (value: unknown) =>
	Array.isArray(value) && value.every((item) => typeof item === "string");

function validProfile(item: EnvProfile): boolean {
	return (
		item != null &&
		["name", "source", "file"].every(
			(key) => typeof item[key as keyof EnvProfile] === "string",
		) &&
		(item.keys === "all" || strings(item.keys)) &&
		(item.publicKeys === undefined || strings(item.publicKeys)) &&
		(item.prune === undefined || typeof item.prune === "boolean") &&
		(item.keep === undefined ||
			(item.keep != null &&
				typeof item.keep === "object" &&
				!Array.isArray(item.keep) &&
				Object.values(item.keep).every(strings)))
	);
}

export async function readRegistry(path: string): Promise<Registry> {
	const content = await readOptional(resolve(path));
	if (content == null) return { version: 1, workspaces: [] };
	let data: Registry;
	try {
		data = JSON.parse(content);
	} catch {
		fail("CONFIG", "Registry is not valid JSON.");
	}
	if (data?.version !== 1 || !Array.isArray(data.workspaces))
		fail("CONFIG", "Unsupported registry format.");
	for (const item of data.workspaces) {
		if (
			!item ||
			["name", "path", "group", "repository", "remote", "base"].some(
				(key) => typeof item[key as keyof Workspace] !== "string",
			)
		) {
			fail("CONFIG", "Invalid workspace entry.");
		}
	}
	if (
		data.profiles !== undefined &&
		!(
			Array.isArray(data.profiles) &&
			data.profiles.every(validProfile) &&
			new Set(data.profiles.map((item) => item.name)).size ===
				data.profiles.length
		)
	)
		fail("CONFIG", "Invalid env profile entry.");
	return data;
}

export async function addWorkspace(
	path: string,
	input: Parameters<typeof registerWorkspace>[0],
): Promise<Workspace> {
	const workspace = await registerWorkspace(input);
	await edit(path, (registry) => {
		check(registry.workspaces, workspace);
		registry.workspaces.push(workspace);
	});
	return workspace;
}

// A group is one repository: syncing and .env sharing never cross groups.
function check(others: Workspace[], workspace: Workspace): void {
	if (
		others.some(
			(item) => item.name === workspace.name || item.path === workspace.path,
		)
	)
		fail("DUPLICATE", "Workspace name or path is already registered.");
	const lookalike = others.find(
		(item) =>
			item.group !== workspace.group &&
			item.group.toLowerCase() === workspace.group.toLowerCase(),
	);
	if (lookalike)
		fail(
			"GROUP_CASE",
			`Group "${workspace.group}" differs from the existing group "${lookalike.group}" only in letter case. Use "${lookalike.group}" to join it.`,
		);
	const member = others.find(
		(item) =>
			item.group === workspace.group &&
			(item.repository !== workspace.repository ||
				item.base !== workspace.base),
	);
	if (member)
		fail(
			"GROUP_MISMATCH",
			`Group "${workspace.group}" holds ${member.repository} with base ${member.base}. A group must use one repository and base branch; choose another group name.`,
		);
}

async function edit(
	path: string,
	change: (registry: Registry) => void,
): Promise<void> {
	await mkdir(dirname(resolve(path)), { recursive: true, mode: 0o700 });
	await withLock(`${resolve(path)}.lock`, async () => {
		const registry = await readRegistry(path);
		change(registry);
		await atomicWrite(resolve(path), `${JSON.stringify(registry, null, 2)}\n`);
	});
}

function find(registry: Registry, name: string): Workspace {
	const workspace = registry.workspaces.find((item) => item.name === name);
	if (!workspace) fail("WORKSPACE", `Workspace "${name}" is not registered.`);
	return workspace;
}

/** Rename a workspace or move it to another group. Only the registry changes. */
export async function updateWorkspace(
	path: string,
	name: string,
	changes: { name?: string; group?: string },
): Promise<Workspace> {
	let updated: Workspace | undefined;
	await edit(path, (registry) => {
		const workspace = find(registry, name);
		const next = {
			...workspace,
			name: changes.name ?? workspace.name,
			group: changes.group ?? workspace.group,
		};
		validName(next.name, "workspace name");
		validName(next.group, "group name");
		check(
			registry.workspaces.filter((item) => item !== workspace),
			next,
		);
		const profiles = registry.profiles ?? [];
		// A profile's targets are its source's group: moving the source would silently
		// point it at other workspaces.
		const using = profiles.find((item) => item.source === name);
		if (using && next.group !== workspace.group)
			fail(
				"PROFILE_SOURCE",
				`Workspace "${name}" is the source of env profile "${using.name}". Remove or change that profile before moving it to another group.`,
			);
		for (const profile of profiles) {
			// Profiles refer to workspaces by name: follow a rename.
			if (profile.source === name) profile.source = next.name;
			if (!profile.keep || !Object.hasOwn(profile.keep, name)) continue;
			const keys = profile.keep[name] ?? [];
			delete profile.keep[name];
			// Kept keys only apply within the source's group; leaving it drops them.
			const source = registry.workspaces.find(
				(item) => item.name === profile.source,
			);
			if (source?.group === next.group) profile.keep[next.name] = keys;
		}
		Object.assign(workspace, next);
		updated = workspace;
	});
	return updated as Workspace;
}

/** Forget a workspace. Its folder, branches and files are not touched. */
export async function removeWorkspace(
	path: string,
	name: string,
): Promise<void> {
	await edit(path, (registry) => {
		const workspace = find(registry, name);
		const using = registry.profiles?.find((item) => item.source === name);
		if (using)
			fail(
				"PROFILE_SOURCE",
				`Workspace "${name}" is the source of env profile "${using.name}". Remove or change that profile first.`,
			);
		for (const profile of registry.profiles ?? [])
			if (profile.keep) delete profile.keep[name];
		registry.workspaces = registry.workspaces.filter(
			(item) => item !== workspace,
		);
	});
}

export function selectWorkspaces(
	registry: Registry,
	group?: string,
): Workspace[] {
	const selected = registry.workspaces.filter(
		(item) => group == null || item.group === group,
	);
	if (selected.length === 0)
		fail("EMPTY", "No registered workspaces match this selection.");
	return selected;
}

/**
 * Create or replace an env profile. Stores key names only; never reads a .env file.
 * With `keepFor`, `profile.keep` holds only that target's kept keys (none clears them):
 * the other targets' saved entries are carried over, minus any the new source or key
 * selection no longer allows. The merge happens under the registry lock.
 */
export async function saveProfile(
	path: string,
	profile: EnvProfile,
	options: { keepFor?: string } = {},
): Promise<EnvProfile> {
	validName(profile.name, "profile name");
	validateFile(profile.file);
	validateKeys({
		file: profile.file,
		keys: profile.keys,
		publicKeys: profile.publicKeys,
		prune: profile.prune,
	});
	let saved: EnvProfile | undefined;
	await edit(path, (registry) => {
		const source = find(registry, profile.source);
		const allowed = (name: string, keys: string[]) => {
			const target = registry.workspaces.find((item) => item.name === name);
			return (
				target != null &&
				target !== source &&
				target.group === source.group &&
				(profile.keys === "all" ||
					keys.every((key) => profile.keys.includes(key)))
			);
		};
		let keep = profile.keep ?? {};
		if (options.keepFor !== undefined) {
			const { keepFor } = options;
			const previous =
				registry.profiles?.find((item) => item.name === profile.name)?.keep ??
				{};
			keep = Object.fromEntries(
				Object.entries(previous).filter(
					([name, keys]) => name !== keepFor && allowed(name, keys),
				),
			);
			const own = Object.hasOwn(profile.keep ?? {}, keepFor)
				? profile.keep?.[keepFor]
				: undefined;
			if (own?.length) keep[keepFor] = own;
		}
		for (const [name, keys] of Object.entries(keep)) {
			const target = find(registry, name);
			if (target === source || target.group !== source.group)
				fail(
					"PROFILE_KEEP",
					`Kept keys belong to another workspace in group "${source.group}", not to "${name}".`,
				);
			if (keys.length === 0)
				fail("ENV_KEYS", "Select at least one key to keep.");
			validateKeys({ file: profile.file, keys: "all", keep: keys });
			// With an explicit list, a key outside it is never copied: keeping it means nothing.
			if (!allowed(name, keys))
				fail(
					"ENV_KEYS",
					"Kept keys must be among the profile's selected keys.",
				);
		}
		saved = {
			name: profile.name,
			source: profile.source,
			file: profile.file,
			keys: profile.keys,
			...(profile.publicKeys?.length ? { publicKeys: profile.publicKeys } : {}),
			...(Object.keys(keep).length ? { keep } : {}),
			...(profile.prune ? { prune: true } : {}),
		};
		const kept = saved;
		registry.profiles = [
			...(registry.profiles ?? []).filter((item) => item.name !== kept.name),
			kept,
		];
	});
	return saved as EnvProfile;
}

export async function removeProfile(path: string, name: string): Promise<void> {
	await edit(path, (registry) => {
		if (!registry.profiles?.some((item) => item.name === name))
			fail("PROFILE", `Env profile "${name}" does not exist.`);
		registry.profiles = registry.profiles.filter((item) => item.name !== name);
	});
}
