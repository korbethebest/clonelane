import { readdir, stat } from "node:fs/promises";
import { join } from "node:path";

import {
	addWorkspace,
	applyEnv,
	ClonelaneError,
	fetchWorkspaces,
	historyGraph,
	inspectWorkspace,
	planEnv,
	readRegistry,
	removeWorkspace,
	selectWorkspaces,
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
export function createHandlers(config) {
	const pick = async (group) =>
		selectWorkspaces(await readRegistry(config), group || undefined);
	const env = async (input, apply) => {
		const { workspaces } = await readRegistry(config);
		const source = workspaces.find((item) => item.name === input.source);
		const target = workspaces.find((item) => item.name === input.target);
		if (!source || !target)
			throw new ClonelaneError(
				"WORKSPACE",
				"Source or target is not registered.",
			);
		return (apply ? applyEnv : planEnv)(source, target, {
			file: input.file || ".env",
			// The whole file unless the user chose "Only these keys".
			...(input.scope === "selected"
				? { keys: list(input.keys), publicKeys: list(input.publicKeys) }
				: { keys: "all" }),
			overwrite: apply && input.overwrite === true,
		});
	};
	return {
		registry: () => readRegistry(config),
		status: async ({ group }) =>
			Promise.all(
				(await pick(group)).map((workspace) =>
					inspectWorkspace(workspace)
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
			),
		// History is read when its panel opens, not on every refresh.
		graph: async ({ name }) => {
			const { workspaces } = await readRegistry(config);
			const workspace = workspaces.find((item) => item.name === name);
			if (!workspace)
				throw new ClonelaneError("WORKSPACE", "Workspace is not registered.");
			return historyGraph(workspace);
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
		fetch: async ({ group }) => {
			const selected = await pick(group);
			await fetchWorkspaces(selected);
			return selected.map((item) => item.name);
		},
		sync: async ({ group, dryRun, rebase }) => {
			const selected = await pick(group);
			// Same contract as the CLI: a real sync fetches first, a preview never does.
			if (dryRun !== true) await fetchWorkspaces(selected);
			return syncWorkspaces(selected, {
				dryRun: dryRun === true,
				rebase: rebase === true,
			});
		},
		envPlan: (input) => env(input, false),
		envApply: (input) => env(input, true),
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
