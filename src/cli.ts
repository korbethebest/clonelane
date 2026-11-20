#!/usr/bin/env node
import { homedir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";

import { applyEnv, planEnv, syncEnvProfile } from "./env.ts";
import { ClonelaneError, fail } from "./errors.ts";
import {
	addWorkspace,
	readRegistry,
	removeProfile,
	saveProfile,
	selectWorkspaces,
} from "./registry.ts";
import { listOperations, restoreOperation } from "./restore.ts";
import { fetchWorkspaces, syncWorkspaces } from "./sync.ts";
import { inspectWorkspace } from "./workspaces.ts";

const help = `Clonelane — keep your Git workspaces in the same lane.

  clonelane register <path> --name <name> --group <group> [--base master] [--remote origin]
  clonelane status [--group <group>] [--json]
  clonelane fetch [--group <group>]
  clonelane sync [--group <group>] [--dry-run] [--rebase]
  clonelane history [--group <group>] [--json]
  clonelane restore <id> [--group <group>] [--dry-run]
  clonelane env plan|apply --source <name> --target <name> --all-keys | --keys API_URL,TOKEN
                        [--file .env] [--overwrite] [--public-keys VITE_API_URL] [--prune]
  clonelane env profile save <profile> --source <name> --all-keys | --keys API_URL,TOKEN
                        [--file .env] [--public-keys ...] [--keep <workspace>:PORT,DB_NAME ...] [--prune]
                        [--targets b,c]
  clonelane env profile list | remove <profile>
  clonelane env sync <profile> [--dry-run] [--overwrite]

Global: --config <file> (default: ~/.config/clonelane/registry.json), --help

status and sync --dry-run use cached remote refs and do not fetch.
sync fetches the selected base before updating. No command pushes.
--rebase applies only to the current, unpublished, linear feature branch.
history lists the branch moves Clonelane made, with their backups. restore moves a
branch back to a backup only if it has not moved since; --dry-run shows the plan.
env output shows key names and states only. Applying normalizes comments/formatting.
A profile saves key names, never values. env sync copies from its source to every other
workspace in that group (or only --targets); each target's --keep keys stay local there. --prune (with
--all-keys) also removes target keys the source lacks; removals need --overwrite.
`;

async function main(): Promise<void> {
	const { values, positionals } = parseArgs({
		allowPositionals: true,
		options: {
			config: { type: "string" },
			name: { type: "string" },
			group: { type: "string" },
			base: { type: "string" },
			remote: { type: "string" },
			json: { type: "boolean" },
			"dry-run": { type: "boolean" },
			rebase: { type: "boolean" },
			help: { type: "boolean" },
			source: { type: "string" },
			target: { type: "string" },
			keys: { type: "string" },
			"all-keys": { type: "boolean" },
			file: { type: "string" },
			overwrite: { type: "boolean" },
			"public-keys": { type: "string" },
			keep: { type: "string", multiple: true },
			prune: { type: "boolean" },
			targets: { type: "string" },
		},
	});
	if (values.help || positionals.length === 0) {
		console.log(help);
		return;
	}
	const config =
		values.config ?? join(homedir(), ".config", "clonelane", "registry.json");
	const [command, argument] = positionals;
	const allowed: Record<string, string[]> = {
		register: ["name", "group", "base", "remote"],
		status: ["group", "json"],
		fetch: ["group"],
		sync: ["group", "dry-run", "rebase"],
		history: ["group", "json"],
		restore: ["group", "dry-run"],
		env:
			argument === "sync"
				? // Like env plan: a preview takes no --overwrite.
					values["dry-run"]
					? ["dry-run"]
					: ["dry-run", "overwrite"]
				: argument === "profile"
					? positionals[2] === "save"
						? [
								"source",
								"keys",
								"all-keys",
								"file",
								"public-keys",
								"keep",
								"prune",
								"targets",
							]
						: []
					: [
							"source",
							"target",
							"keys",
							"all-keys",
							"file",
							"public-keys",
							"prune",
							...(argument === "apply" ? ["overwrite"] : []),
						],
	};
	if (
		Object.keys(values).some(
			(key) =>
				!["config", "help", ...(allowed[command ?? ""] ?? [])].includes(key),
		)
	) {
		fail(
			"USAGE",
			"This command received an unsupported option. Run clonelane --help.",
		);
	}
	const print = (data: unknown) => console.log(JSON.stringify(data, null, 2));
	if (command === "register") {
		if (!argument || !values.name || !values.group || positionals.length !== 2)
			fail("USAGE", "register requires a path, --name and --group.");
		const workspace = await addWorkspace(config, {
			path: argument,
			name: values.name,
			group: values.group,
			remote: values.remote,
			base: values.base,
		});
		print({
			registered: workspace.name,
			group: workspace.group,
			path: workspace.path,
		});
		return;
	}
	if (command === "env" && argument === "profile") {
		const [, , action, name] = positionals;
		if (action === "list" && positionals.length === 3) {
			print((await readRegistry(config)).profiles ?? []);
			return;
		}
		if (action === "remove" && name && positionals.length === 4) {
			await removeProfile(config, name);
			print({ removed: name });
			return;
		}
		if (
			action !== "save" ||
			!name ||
			positionals.length !== 4 ||
			!values.source ||
			!values.keys === !values["all-keys"]
		)
			fail(
				"USAGE",
				"env profile save requires a name, --source and either --all-keys or --keys.",
			);
		const keep: Record<string, string[]> = {};
		for (const entry of values.keep ?? []) {
			const at = entry.indexOf(":");
			const workspace = entry.slice(0, at);
			if (at < 1 || Object.hasOwn(keep, workspace))
				fail("USAGE", "Use --keep <workspace>:KEY,KEY once per workspace.");
			keep[workspace] = entry.slice(at + 1).split(",");
		}
		print(
			await saveProfile(config, {
				name,
				source: values.source,
				file: values.file ?? ".env",
				keys: values.keys?.split(",") ?? "all",
				publicKeys: values["public-keys"]?.split(","),
				keep,
				prune: values.prune,
				targets: values.targets?.split(","),
			}),
		);
		return;
	}
	const registry = await readRegistry(config);
	if (command === "env" && argument === "sync") {
		if (positionals.length !== 3 || !positionals[2])
			fail("USAGE", "env sync requires one profile name.");
		const results = await syncEnvProfile(registry, positionals[2], {
			dryRun: values["dry-run"],
			overwrite: values.overwrite,
		});
		print(results);
		if (results.some((result) => result.error)) process.exitCode = 1;
		return;
	}
	if (command === "env") {
		if (
			!["plan", "apply"].includes(argument ?? "") ||
			positionals.length !== 2 ||
			!values.source ||
			!values.target ||
			// Exactly one: a missing --keys must never silently become "all".
			!values.keys === !values["all-keys"]
		)
			fail(
				"USAGE",
				"env plan|apply requires --source, --target and either --all-keys or --keys.",
			);
		const source = registry.workspaces.find(
			(item) => item.name === values.source,
		);
		const target = registry.workspaces.find(
			(item) => item.name === values.target,
		);
		if (!source || !target)
			fail("WORKSPACE", "Source or target is not registered.");
		const options = {
			file: values.file ?? ".env",
			keys: values.keys?.split(",") ?? ("all" as const),
			overwrite: values.overwrite,
			publicKeys: values["public-keys"]?.split(","),
			prune: values.prune,
		};
		print(
			await (argument === "apply" ? applyEnv : planEnv)(
				source,
				target,
				options,
			),
		);
		return;
	}
	if (command === "restore") {
		if (positionals.length !== 2 || !/^[0-9a-f]{16}$/.test(argument ?? ""))
			fail(
				"USAGE",
				"restore requires one operation id from clonelane history.",
			);
		const id = argument as string;
		// The journal is per clone, so find the workspace that recorded this id.
		const owners: (typeof registry.workspaces)[number][] = [];
		let unreadable: unknown;
		for (const workspace of selectWorkspaces(registry, values.group)) {
			const operations = await listOperations(workspace).catch((error) => {
				unreadable ??= error;
				return [];
			});
			if (operations.some((item) => item.id === id)) owners.push(workspace);
		}
		if (owners.length > 1)
			fail(
				"AMBIGUOUS",
				`Operation ${id} exists in several workspaces. Narrow it with --group.`,
			);
		const owner = owners[0];
		// The id may be in a workspace that could not be read: say why instead of "not found".
		if (!owner && unreadable) throw unreadable;
		if (!owner)
			fail(
				"NOT_FOUND",
				`No recorded operation ${id}. Run "clonelane history" to list them.`,
			);
		const result = await restoreOperation(owner, id, {
			dryRun: values["dry-run"],
		});
		print(result);
		if (result.result === "refused") process.exitCode = 1;
		return;
	}
	if (positionals.length !== 1)
		fail("USAGE", "Unexpected positional argument.");
	const selected = selectWorkspaces(registry, values.group);
	if (command === "history") {
		const histories = await Promise.all(
			selected.map((workspace) =>
				listOperations(workspace).catch((error: unknown) => ({
					workspace,
					error:
						error instanceof ClonelaneError
							? { code: error.code, message: error.message }
							: { code: "IO_ERROR", message: "Could not read this workspace." },
				})),
			),
		);
		if (histories.some((item) => "error" in item)) process.exitCode = 1;
		if (values.json) {
			// stdout stays a plain list of operations; unreadable workspaces go to stderr.
			print(histories.flatMap((item) => ("error" in item ? [] : item)));
			for (const item of histories)
				if ("error" in item)
					console.error(
						JSON.stringify({
							workspace: item.workspace.name,
							error: item.error.code,
							message: item.error.message,
						}),
					);
		} else
			for (const [index, item] of histories.entries()) {
				const name = selected[index]?.name;
				if ("error" in item) {
					console.log(`\n${name}: ${item.error.message}`);
					continue;
				}
				console.log(`\n${name}: ${item.length} recorded moves`);
				if (item.length)
					console.table(
						item.map((operation) => ({
							id: operation.id,
							time: operation.time,
							kind: operation.kind,
							branch: operation.ref.replace(/^refs\/heads\//, ""),
							from: operation.from.slice(0, 12),
							to: (operation.tip ?? operation.to).slice(0, 12),
							state: operation.state,
						})),
					);
			}
		return;
	}
	if (command === "status") {
		// One unreadable workspace must not hide the others.
		const statuses = await Promise.all(
			selected.map((workspace) =>
				inspectWorkspace(workspace, { reuseIdentity: true }).catch(
					(error: unknown) => ({
						workspace,
						error:
							error instanceof ClonelaneError
								? { code: error.code, message: error.message }
								: {
										code: "IO_ERROR",
										message: "Could not read this workspace.",
									},
					}),
				),
			),
		);
		if (statuses.some((state) => "error" in state)) process.exitCode = 1;
		if (values.json) print(statuses);
		else {
			console.table(
				statuses.map((state) =>
					"error" in state
						? {
								name: state.workspace.name,
								path: state.workspace.path,
								error: state.error.code,
							}
						: {
								name: state.workspace.name,
								path: state.workspace.path,
								branch: state.branch ?? "(detached)",
								dirty: state.dirty,
								operation: state.operation,
								"ahead of base": state.baseAhead,
								"behind base": state.baseBehind,
								interrupted: state.interrupted,
							},
				),
			);
			for (const state of statuses) {
				if ("error" in state) {
					console.log(`\n${state.workspace.name}: ${state.error.message}`);
					continue;
				}
				console.log(`\n${state.workspace.name}: local branches`);
				console.table(state.branches);
			}
			if (statuses.some((state) => "interrupted" in state && state.interrupted))
				console.log(
					'A Clonelane update was interrupted. Run "clonelane history" to see it and its backup.',
				);
			console.log("Remote refs are cached. Run clonelane fetch to refresh.");
		}
		return;
	}
	if (command === "fetch") {
		const results = await fetchWorkspaces(selected);
		print(results);
		if (results.some((result) => result.result === "failed"))
			process.exitCode = 1;
		return;
	}
	if (command === "sync") {
		const results = await syncWorkspaces(selected, {
			dryRun: values["dry-run"],
			rebase: values.rebase,
			fetch: !values["dry-run"],
		});
		print(results);
		if (results.some((result) => result.result === "failed"))
			process.exitCode = 1;
		return;
	}
	fail("USAGE", "Unknown command. Run clonelane --help.");
}

main().catch((error) => {
	// Never print raw errors, CLI arguments, Git output or environment contents.
	console.error(
		JSON.stringify(
			error instanceof ClonelaneError
				? { error: error.code, message: error.message }
				: {
						error: "FAILED",
						message:
							"Operation failed. Details were suppressed to protect local secrets.",
					},
		),
	);
	process.exitCode = 1;
});
