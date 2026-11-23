import { readFile } from "node:fs/promises";
import { createInterface } from "node:readline";
import type { Readable, Writable } from "node:stream";

import { syncEnvProfile } from "./env.ts";
import { ClonelaneError, fail } from "./errors.ts";
import {
	checkHolder,
	claimWorkspace,
	DEFAULT_MINUTES,
	releaseLease,
	takeLease,
	workspaceLease,
} from "./lease.ts";
import {
	type Registry,
	readRegistry,
	selectWorkspaces,
	workspaceAt,
} from "./registry.ts";
import { listOperations, operationOwner, restoreOperation } from "./restore.ts";
import { fetchWorkspaces, syncWorkspaces } from "./sync.ts";
import { inspectWorkspace, type Workspace } from "./workspaces.ts";

/** Protocol versions this server speaks, newest first. Tools work the same in all. */
const VERSIONS = ["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"];

type Args = Record<string, unknown>;
interface Context {
	registry: () => Promise<Registry>;
	holder?: string;
	cwd: string;
}
interface Tool {
	name: string;
	description: string;
	inputSchema: {
		type: "object";
		properties: Record<string, object>;
		required?: string[];
		additionalProperties: false;
	};
	annotations: {
		readOnlyHint: boolean;
		destructiveHint?: boolean;
		openWorldHint: false;
	};
	run: (args: Args, context: Context) => Promise<unknown>;
}

// Arguments come from a model: check every one, and say exactly what was wrong.
function text(args: Args, key: string, required = false): string | undefined {
	const value = args[key];
	if (value === undefined || value === null || value === "") {
		if (required) fail("INVALID_ARGUMENT", `"${key}" is required.`);
		return undefined;
	}
	if (typeof value !== "string")
		fail("INVALID_ARGUMENT", `"${key}" must be a string.`);
	return value;
}
function flag(args: Args, key: string, fallback: boolean): boolean {
	const value = args[key];
	if (value === undefined) return fallback;
	if (typeof value !== "boolean")
		fail("INVALID_ARGUMENT", `"${key}" must be true or false.`);
	return value;
}
function minutes(args: Args): number {
	const value = args.minutes ?? DEFAULT_MINUTES;
	if (!Number.isInteger(value))
		fail("INVALID_ARGUMENT", '"minutes" must be a whole number.');
	return value as number;
}
// A server started with CLONELANE_HOLDER speaks for that holder only: a model cannot
// release or act on another holder's lease by naming it.
function named(args: Args, context: Context, key: string): string | undefined {
	const given = text(args, key);
	if (given !== undefined && context.holder && given !== context.holder)
		fail(
			"INVALID_ARGUMENT",
			`This server acts as "${context.holder}" (CLONELANE_HOLDER); "${key}" cannot name another holder.`,
		);
	return given ?? context.holder;
}
function holderOf(args: Args, context: Context): string {
	const holder = named(args, context, "holder");
	if (!holder)
		fail(
			"INVALID_ARGUMENT",
			'"holder" is required (or set CLONELANE_HOLDER for the server).',
		);
	return holder;
}
// A named workspace, or the one a folder (by default the server's) is in.
async function target(args: Args, context: Context): Promise<Workspace> {
	const registry = await context.registry();
	const name = text(args, "workspace");
	if (name !== undefined && text(args, "path") !== undefined)
		fail("INVALID_ARGUMENT", 'Give "workspace" or "path", not both.');
	if (name === undefined)
		return workspaceAt(registry, text(args, "path") ?? context.cwd);
	const workspace = registry.workspaces.find((item) => item.name === name);
	if (!workspace) fail("WORKSPACE", `Workspace "${name}" is not registered.`);
	return workspace;
}
const reason = (error: unknown) =>
	error instanceof ClonelaneError ? error.code : "IO_ERROR";

const group = {
	type: "string",
	description: "Group name; all groups if omitted.",
};
const path = {
	type: "string",
	description:
		"A folder inside the workspace (absolute). Defaults to the server's working folder.",
};
const workspace = {
	type: "string",
	description: "Workspace name. Omit to use the one `path` is in.",
};
const holder = {
	type: "string",
	description:
		"Your lease holder name (letters, digits, . _ @ -). Defaults to CLONELANE_HOLDER.",
};
const as = {
	type: "string",
	description:
		"Act as this lease holder, to work on your own leased workspace. Defaults to CLONELANE_HOLDER.",
};
const dryRun = {
	type: "boolean",
	description: "Preview only (default true). Pass false to apply.",
};
const note = { type: "string", description: "Why, in a few words." };
const lease = {
	type: "integer",
	minimum: 1,
	maximum: 7 * 24 * 60,
	description: `Lease length in minutes (default ${DEFAULT_MINUTES}). A renewal never shortens a lease.`,
};
const schema = (
	properties: Record<string, object>,
	required?: string[],
): Tool["inputSchema"] => ({
	type: "object",
	properties,
	...(required ? { required } : {}),
	additionalProperties: false,
});
const readOnly = { readOnlyHint: true, openWorldHint: false } as const;
const writes = (destructive: boolean) =>
	({
		readOnlyHint: false,
		destructiveHint: destructive,
		openWorldHint: false,
	}) as const;

export const tools: Tool[] = [
	{
		name: "here",
		description:
			"Which registered workspace a folder is in: name, group, path, base branch and its lease. Start here.",
		inputSchema: schema({ path }),
		annotations: readOnly,
		run: async (args, context) => {
			const found = await target(args, context);
			return { ...found, lease: await workspaceLease(found) };
		},
	},
	{
		name: "status",
		description:
			"State of every workspace: branch, uncommitted changes, commits ahead of and behind the base branch, local branches and lease. Uses cached remote refs; does not fetch.",
		inputSchema: schema({ group }),
		annotations: readOnly,
		run: async (args, context) =>
			Promise.all(
				selectWorkspaces(await context.registry(), text(args, "group")).map(
					(item) =>
						inspectWorkspace(item, { reuseIdentity: true }).catch(
							(error: unknown) => ({
								workspace: item,
								error: reason(error),
							}),
						),
				),
			),
	},
	{
		name: "claim",
		description:
			"Lease a free workspace (no lease, nothing uncommitted, no Git operation) in a group and return its path; work only in that path. Claiming again as the same holder returns the same workspace, renewed. NO_FREE_WORKSPACE means every one is busy: tell the user.",
		inputSchema: schema({
			holder,
			group: {
				type: "string",
				description: "Group to claim from. Defaults to the group `path` is in.",
			},
			path,
			note,
			minutes: lease,
		}),
		annotations: writes(false),
		run: async (args, context) => {
			const registry = await context.registry();
			const folder = text(args, "path");
			const here = await workspaceAt(registry, folder ?? context.cwd).catch(
				(caught: unknown) => {
					// A path the caller named must be a workspace; the server's own folder need not.
					if (folder !== undefined) throw caught;
					return null;
				},
			);
			const name =
				text(args, "group") ??
				here?.group ??
				fail(
					"INVALID_ARGUMENT",
					'"group" is required outside a registered workspace.',
				);
			const claimed = await claimWorkspace(selectWorkspaces(registry, name), {
				prefer: here?.name,
				holder: holderOf(args, context),
				note: text(args, "note"),
				minutes: minutes(args),
			});
			return {
				workspace: claimed.workspace.name,
				path: claimed.workspace.path,
				renewed: claimed.renewed,
				...claimed.lease,
			};
		},
	},
	{
		name: "lease_take",
		description:
			"Lease a workspace so Clonelane (sync, env, restore) leaves it to you; taking it again as the same holder renews it. LEASED means someone else holds it.",
		inputSchema: schema({ workspace, path, holder, note, minutes: lease }),
		annotations: writes(false),
		run: async (args, context) => {
			const found = await target(args, context);
			return {
				workspace: found.name,
				...(await takeLease(found, {
					holder: holderOf(args, context),
					note: text(args, "note"),
					minutes: minutes(args),
				})),
			};
		},
	},
	{
		name: "lease_release",
		description:
			"Give back your lease when the task is done. Only the holder can release it.",
		inputSchema: schema({ workspace, path, holder }),
		annotations: writes(false),
		run: async (args, context) => {
			const found = await target(args, context);
			return {
				workspace: found.name,
				released: await releaseLease(found, {
					holder: holderOf(args, context),
				}),
			};
		},
	},
	{
		name: "lease_list",
		description: "Who holds each workspace, why and until when.",
		inputSchema: schema({ group }),
		annotations: readOnly,
		run: async (args, context) =>
			Promise.all(
				selectWorkspaces(await context.registry(), text(args, "group")).map(
					async (item) => {
						try {
							return {
								workspace: item.name,
								lease: await workspaceLease(item),
							};
						} catch (error) {
							return { workspace: item.name, error: reason(error) };
						}
					},
				),
			),
	},
	{
		name: "fetch",
		description:
			"Fetch each workspace's base branch from its remote. Only remote-tracking refs change.",
		inputSchema: schema({ group }),
		annotations: writes(false),
		run: async (args, context) =>
			fetchWorkspaces(
				selectWorkspaces(await context.registry(), text(args, "group")),
			),
	},
	{
		name: "sync",
		description:
			"Bring workspaces up to their base branch. Previews by default (no fetch); with dry_run false it fetches, then fast-forwards. It skips dirty workspaces, Git operations and workspaces leased by others, and says why. rebase only for an unpublished, linear current feature branch, and only when the user asked.",
		inputSchema: schema({
			group,
			dry_run: dryRun,
			rebase: {
				type: "boolean",
				description: "Rebase the current feature branch (default false).",
			},
			as,
		}),
		annotations: writes(true),
		run: async (args, context) => {
			const preview = flag(args, "dry_run", true);
			return syncWorkspaces(
				selectWorkspaces(await context.registry(), text(args, "group")),
				{
					dryRun: preview,
					rebase: flag(args, "rebase", false),
					fetch: !preview,
					as: named(args, context, "as"),
				},
			);
		},
	},
	{
		name: "env_profiles",
		description:
			"Saved env profiles: which .env keys are copied from which source workspace to which targets. Key names only, never values.",
		inputSchema: schema({}),
		annotations: readOnly,
		run: async (_args, context) => (await context.registry()).profiles ?? [],
	},
	{
		name: "env_sync",
		description:
			"Copy .env keys from a profile's source to its targets. Previews by default: key names and states only, never values. Changing or removing an existing key needs overwrite: ask the user first.",
		inputSchema: schema(
			{
				profile: { type: "string", description: "Profile name." },
				dry_run: dryRun,
				overwrite: {
					type: "boolean",
					description:
						"Allow changing or removing existing keys (default false). Ask the user first.",
				},
				as,
			},
			["profile"],
		),
		annotations: writes(true),
		run: async (args, context) => {
			const preview = flag(args, "dry_run", true);
			if (preview && flag(args, "overwrite", false))
				fail("INVALID_ARGUMENT", "A preview takes no overwrite.");
			return syncEnvProfile(
				await context.registry(),
				text(args, "profile", true) as string,
				{
					dryRun: preview,
					overwrite: flag(args, "overwrite", false),
					as: named(args, context, "as"),
				},
			);
		},
	},
	{
		name: "history",
		description:
			"Branch moves Clonelane made, newest first, each with the backup it can be restored from.",
		inputSchema: schema({ group }),
		annotations: readOnly,
		run: async (args, context) =>
			Promise.all(
				selectWorkspaces(await context.registry(), text(args, "group")).map(
					async (item) => {
						try {
							return {
								workspace: item.name,
								operations: await listOperations(item),
							};
						} catch (error) {
							return { workspace: item.name, error: reason(error) };
						}
					},
				),
			),
	},
	{
		name: "restore",
		description:
			"Move a branch back to the backup of a recorded move (an id from history), only if it has not moved since. Previews by default.",
		inputSchema: schema(
			{
				id: { type: "string", description: "Operation id from history." },
				group,
				dry_run: dryRun,
				as,
			},
			["id"],
		),
		annotations: writes(true),
		run: async (args, context) => {
			const id = text(args, "id", true) as string;
			if (!/^[0-9a-f]{16}$/.test(id))
				fail("INVALID_ARGUMENT", '"id" is a 16-character id from history.');
			const owner = await operationOwner(
				selectWorkspaces(await context.registry(), text(args, "group")),
				id,
			);
			return restoreOperation(owner, id, {
				dryRun: flag(args, "dry_run", true),
				as: named(args, context, "as"),
			});
		},
	},
];

type Message = {
	jsonrpc?: unknown;
	id?: unknown;
	method?: unknown;
	params?: Args;
};
const reply = (id: unknown, result: unknown) => ({
	jsonrpc: "2.0",
	id,
	result,
});
const error = (id: unknown, code: number, message: string) => ({
	jsonrpc: "2.0",
	id,
	error: { code, message },
});

/**
 * One MCP session: takes a parsed JSON-RPC message, returns the response (null for a
 * notification). The registry is read on every call, so registry changes apply at once.
 */
export function mcpSession(options: {
	config: string;
	holder?: string;
	cwd?: string;
	version: string;
}) {
	const context: Context = {
		registry: () => readRegistry(options.config),
		holder: options.holder,
		cwd: options.cwd ?? process.cwd(),
	};
	return async (message: Message): Promise<object | null> => {
		if (
			message === null ||
			typeof message !== "object" ||
			Array.isArray(message) ||
			message.jsonrpc !== "2.0" ||
			typeof message.method !== "string"
		)
			return error(message?.id ?? null, -32600, "Invalid request.");
		const { id, method } = message;
		const params = message.params ?? {};
		// Notifications (initialized, cancelled) need no answer.
		if (id === undefined) return null;
		if (method === "initialize") {
			const asked = params.protocolVersion;
			return reply(id, {
				protocolVersion:
					typeof asked === "string" && VERSIONS.includes(asked)
						? asked
						: VERSIONS[0],
				capabilities: { tools: { listChanged: false } },
				serverInfo: { name: "clonelane", version: options.version },
				instructions:
					"Clonelane coordinates several clones or worktrees of one repository. Start with here (or claim for a checkout of your own), keep a lease while working, preview before applying, never act on a workspace someone else leased, and release your lease when done.",
			});
		}
		if (method === "ping") return reply(id, {});
		if (method === "tools/list")
			return reply(id, {
				tools: tools.map(({ run: _run, ...tool }) => tool),
			});
		if (method === "tools/call") {
			const tool = tools.find((item) => item.name === params.name);
			if (!tool) return error(id, -32602, "Unknown tool.");
			const args = params.arguments ?? {};
			try {
				if (typeof args !== "object" || Array.isArray(args))
					fail("INVALID_ARGUMENT", "Arguments must be an object.");
				for (const key of Object.keys(args as Args))
					if (!Object.hasOwn(tool.inputSchema.properties, key))
						fail("INVALID_ARGUMENT", `Unknown argument "${key}".`);
				const data = await tool.run(args as Args, context);
				return reply(id, {
					content: [{ type: "text", text: JSON.stringify(data, null, 2) }],
				});
			} catch (caught) {
				// Never forward raw errors: they can carry paths, Git output or env contents.
				// stderr (not the protocol channel) gets the kind of failure, for diagnosis.
				if (!(caught instanceof ClonelaneError))
					process.stderr.write(
						`clonelane mcp: ${tool.name} failed (${(caught as { code?: unknown })?.code ?? (caught as Error)?.name ?? "error"})\n`,
					);
				const body =
					caught instanceof ClonelaneError
						? { error: caught.code, message: caught.message }
						: {
								error: "FAILED",
								message:
									"Operation failed. Details were suppressed to protect local secrets.",
							};
				return reply(id, {
					content: [{ type: "text", text: JSON.stringify(body) }],
					isError: true,
				});
			}
		}
		return error(id, -32601, "Method not found.");
	};
}

/** Serves MCP over stdio: one JSON-RPC message per line. stdout carries nothing else. */
export async function serveMcp(
	config: string,
	input: Readable = process.stdin,
	output: Writable = process.stdout,
): Promise<void> {
	const { version } = JSON.parse(
		await readFile(new URL("../package.json", import.meta.url), "utf8"),
	) as { version: string };
	const fromEnv = process.env.CLONELANE_HOLDER || undefined;
	if (fromEnv) checkHolder(fromEnv);
	const handle = mcpSession({ config, holder: fromEnv, version });
	const pending = new Set<Promise<void>>();
	for await (const line of createInterface({ input, crlfDelay: Infinity })) {
		if (!line.trim()) continue;
		let message: Message;
		try {
			message = JSON.parse(line);
		} catch {
			output.write(`${JSON.stringify(error(null, -32700, "Parse error."))}\n`);
			continue;
		}
		// Requests run side by side; Clonelane's own locks order the writes.
		const task = handle(message)
			.then((response) => {
				if (response) output.write(`${JSON.stringify(response)}\n`);
			})
			// A closed pipe must not take the server (or the other requests) down.
			.catch(() => {})
			.finally(() => pending.delete(task));
		pending.add(task);
	}
	await Promise.all(pending);
}
