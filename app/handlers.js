import {
	mkdir,
	readdir,
	readFile,
	rename,
	stat,
	writeFile,
} from "node:fs/promises";
import { dirname, join } from "node:path";

import {
	addWorkspace,
	ClonelaneError,
	fetchWorkspaces,
	historyGraph,
	inspectWorkspace,
	listOperations,
	readRegistry,
	removeProfile,
	removeWorkspace,
	restoreOperation,
	saveProfile,
	selectWorkspaces,
	syncEnvProfile,
	syncWorkspaces,
	updateWorkspace,
} from "../dist/index.js";

const list = (value) =>
	String(value ?? "")
		.split(",")
		.map((item) => item.trim())
		.filter(Boolean);

// Remote-tracking refs are shared by every worktree, but each worktree writes its own
// FETCH_HEAD, so the latest one across the repository is its last fetch. null = never.
async function lastFetch(commonDir) {
	const worktrees = await readdir(join(commonDir, "worktrees")).catch(() => []);
	const times = await Promise.all(
		[
			commonDir,
			...worktrees.map((name) => join(commonDir, "worktrees", name)),
		].map((dir) =>
			stat(join(dir, "FETCH_HEAD")).then(
				(info) => info.mtimeMs,
				() => 0,
			),
		),
	);
	return Math.max(...times) || null;
}

// Electron-free so the app's actions can be exercised with plain Node.
export function createHandlers(config, { statusCache } = {}) {
	// Writes are serialized and atomic (temp file, then rename), and never delay a status.
	let saving = Promise.resolve();
	const save = (data) => {
		saving = saving
			.then(async () => {
				await mkdir(dirname(statusCache), { recursive: true });
				const temp = `${statusCache}.${process.pid}.tmp`;
				await writeFile(temp, JSON.stringify(data), { mode: 0o600 });
				await rename(temp, statusCache);
			})
			.catch(() => {});
	};
	const named = async (name) => {
		const { workspaces } = await readRegistry(config);
		const workspace = workspaces.find((item) => item.name === name);
		if (!workspace)
			throw new ClonelaneError("WORKSPACE", "Workspace is not registered.");
		return workspace;
	};
	const pick = async (group) =>
		selectWorkspaces(await readRegistry(config), group || undefined);
	// The form's key selection, as the core takes it.
	const selection = (input) =>
		input.scope === "selected"
			? { keys: list(input.keys), publicKeys: list(input.publicKeys) }
			: // A checkbox posts "on"; removing keys only applies to a whole-file mirror.
				{ keys: "all", prune: input.prune === "on" || input.prune === true };
	// The form's fields as a profile. Targets are a comma list; kept keys arrive as
	// "keep:<workspace>" fields and count only for a chosen target. "All targets" saves no
	// list, so the profile follows the group as it changes.
	const profileFrom = (input) => {
		const targets = list(input.targets);
		const keep = Object.fromEntries(
			Object.entries(input)
				.filter(
					([field, value]) =>
						field.startsWith("keep:") &&
						targets.includes(field.slice(5)) &&
						list(value).length > 0,
				)
				.map(([field, value]) => [field.slice(5), list(value)]),
		);
		return {
			name: String(input.name ?? ""),
			source: String(input.source ?? ""),
			file: input.file || ".env",
			...selection(input),
			...(input.allTargets === true ? {} : { targets }),
			keep,
		};
	};
	return {
		registry: () => readRegistry(config),
		status: async ({ group }) => {
			const statuses = await Promise.all(
				(await pick(group)).map((workspace) =>
					inspectWorkspace(workspace, { reuseIdentity: true })
						.then(async (state) => ({
							...state,
							lastFetch: await lastFetch(state.commonDir),
						}))
						.catch((error) => ({
							workspace,
							error:
								error instanceof ClonelaneError
									? error.message
									: "Could not read this workspace. Check that the folder still exists.",
						})),
				),
			);
			// The last result is shown at the next start while fresh state is read. Local only:
			// paths, branch names and commit subjects, in the user's own app data folder.
			if (statusCache)
				save({ config, group: group ?? "", at: Date.now(), statuses });
			return statuses;
		},
		// Last known statuses for this registry and group, limited to workspaces still
		// registered, or null. Never fresh: for display while the current state loads.
		cachedStatus: async ({ group }) => {
			if (!statusCache) return null;
			try {
				const saved = JSON.parse(await readFile(statusCache, "utf8"));
				if (
					saved.config !== config ||
					saved.group !== (group ?? "") ||
					!Array.isArray(saved.statuses)
				)
					return null;
				const current = await pick(group);
				const statuses = current
					.map((workspace) =>
						saved.statuses.find(
							(state) =>
								state?.workspace?.name === workspace.name &&
								state.workspace.path === workspace.path,
						),
					)
					.filter(Boolean);
				return statuses.length === current.length
					? { at: saved.at, statuses }
					: null;
			} catch {
				return null;
			}
		},
		// History is read when its panel opens, not on every refresh.
		graph: async ({ name }) => historyGraph(await named(name)),
		// Branch moves Clonelane recorded for one workspace, newest first. Read-only.
		operations: async ({ name }) => listOperations(await named(name)),
		// Same checks as clonelane restore; a preview (dryRun) changes nothing.
		restore: async ({ name, id, dryRun }) => {
			if (!/^[0-9a-f]{16}$/.test(id ?? ""))
				throw new ClonelaneError("USAGE", "Unknown operation id.");
			return restoreOperation(await named(name), id, {
				dryRun: dryRun === true,
			});
		},
		register: (input) =>
			addWorkspace(config, {
				path: String(input.path ?? ""),
				name: String(input.name ?? ""),
				group: String(input.group ?? ""),
				base: input.base || undefined,
				remote: input.remote || undefined,
			}),
		update: (input) =>
			updateWorkspace(config, String(input.name ?? ""), {
				name: input.newName || undefined,
				group: input.group || undefined,
			}),
		remove: async (input) => {
			await removeWorkspace(config, String(input.name ?? ""));
			return String(input.name);
		},
		fetch: async ({ group }) => fetchWorkspaces(await pick(group)),
		sync: async ({ group, dryRun, rebase }) =>
			// Same contract as the CLI: a real sync fetches first, a preview never does.
			syncWorkspaces(await pick(group), {
				dryRun: dryRun === true,
				rebase: rebase === true,
				fetch: dryRun !== true,
			}),
		// Saves the form as a profile. Kept keys are per target: the field sets (or, empty,
		// clears) the chosen target's; the others' saved entries are kept.
		profileSave: (input) => saveProfile(config, profileFrom(input)),
		profileRemove: async ({ name }) => {
			await removeProfile(config, String(name ?? ""));
			return String(name);
		},
		// The form, run as an unsaved profile. Same contract as clonelane env sync: a
		// preview (dryRun) never writes, and only a real run can overwrite.
		envSync: async (input) =>
			syncEnvProfile(await readRegistry(config), profileFrom(input), {
				dryRun: input.dryRun === true,
				overwrite: input.dryRun !== true && input.overwrite === true,
			}),
	};
}

export async function call(handlers, name, input) {
	if (!Object.hasOwn(handlers, name))
		return { ok: false, error: "USAGE", message: "Unknown action." };
	// Renderer input is untrusted: every action takes only flat strings and booleans.
	const fields = Object.fromEntries(
		Object.entries(input && typeof input === "object" ? input : {}).filter(
			([, value]) => typeof value === "string" || typeof value === "boolean",
		),
	);
	try {
		return { ok: true, data: await handlers[name](fields) };
	} catch (error) {
		// Never forward raw errors: they can carry paths, Git output or env contents.
		return error instanceof ClonelaneError
			? { ok: false, error: error.code, message: error.message }
			: {
					ok: false,
					error: "FAILED",
					message:
						"Operation failed. Details were suppressed to protect local secrets.",
				};
	}
}
