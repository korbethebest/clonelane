import { mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";

import { fail } from "./errors.ts";
import { atomicWrite, readOptional, withLock } from "./files.ts";
import { validName } from "./git.ts";
import { registerWorkspace, type Workspace } from "./workspaces.ts";

export interface Registry {
	version: 1;
	workspaces: Workspace[];
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
