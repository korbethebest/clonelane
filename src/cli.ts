#!/usr/bin/env node
import { mkdir, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";

import { applyEnv, planEnv, syncEnvProfile } from "./env.ts";
import { ClonelaneError, fail } from "./errors.ts";
import { atomicWrite } from "./files.ts";
import {
	checkHolder,
	claimWorkspace,
	DEFAULT_MINUTES,
	releaseLease,
	takeLease,
	workspaceLease,
} from "./lease.ts";
import { serveMcp } from "./mcp.ts";
import {
	addWorkspace,
	readRegistry,
	removeProfile,
	saveProfile,
	selectWorkspaces,
	setAutoSync,
	workspaceAt,
} from "./registry.ts";
import { listOperations, operationOwner, restoreOperation } from "./restore.ts";
import { fetchWorkspaces, runAutoSync, syncWorkspaces } from "./sync.ts";
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
  clonelane lease take [<workspace>] --holder <name> [--note "why"] [--minutes 120]
  clonelane lease release [<workspace>] [--holder <name>] [--force]
  clonelane lease list [--group <group>] [--json]
  clonelane claim [--group <group>] --holder <name> [--note "why"] [--minutes 120]
  clonelane here
  clonelane agent install [--claude] [--agents] [--project]
  clonelane mcp
  clonelane auto-sync on|off <group> | auto-sync list
  clonelane worker [--every 15] [--once]

Global: --config <file> (default: ~/.config/clonelane/registry.json), --help
--as <holder> on sync, restore and env: act as that lease holder.
CLONELANE_HOLDER in the environment is the default --holder and --as.
lease take/release without a workspace use the one the current folder is in.
claim leases a free workspace (no lease, nothing uncommitted) in the group, by default
the current folder's, and prints its path; the holder's own lease is renewed instead.
here prints the workspace the current folder is in, with its lease.
agent install writes the Clonelane skill for coding agents: --claude to ~/.claude/skills,
--agents to ~/.agents/skills (Codex, Gemini CLI and others); both by default. --project
writes them under the current folder instead.
mcp serves the same actions to MCP clients over stdio; sync, env_sync and restore preview
unless called with dry_run false.
auto-sync on keeps a group up to date without being asked (fetch, then fast-forward only;
never rebase), and prints what a sync would do now. The desktop app's automatic fetch and
worker do it: worker every --every minutes (5 to 1440), or one pass with --once.

status and sync --dry-run use cached remote refs and do not fetch.
sync fetches the selected base before updating. No command pushes.
--rebase applies only to the current, unpublished, linear feature branch, and moves local
branches stacked under it along with it (stack in the result); each is backed up.
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
			holder: { type: "string" },
			note: { type: "string" },
			minutes: { type: "string" },
			force: { type: "boolean" },
			as: { type: "string" },
			claude: { type: "boolean" },
			agents: { type: "boolean" },
			project: { type: "boolean" },
			every: { type: "string" },
			once: { type: "boolean" },
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
		lease:
			argument === "take"
				? ["holder", "note", "minutes"]
				: argument === "release"
					? ["holder", "force"]
					: ["group", "json"],
		claim: ["group", "holder", "note", "minutes"],
		here: [],
		agent: ["claude", "agents", "project"],
		mcp: [],
		"auto-sync": [],
		worker: ["every", "once"],
	};
	// A lease holder may act on its own leased workspaces; profiles store no holder.
	if (
		["sync", "restore"].includes(command ?? "") ||
		(command === "env" && argument !== "profile")
	)
		allowed[command as string]?.push("as");
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
	// One name per agent or person, set once instead of on every command.
	const fromEnv = process.env.CLONELANE_HOLDER || undefined;
	if (fromEnv) {
		try {
			checkHolder(fromEnv);
		} catch {
			fail(
				"USAGE",
				"CLONELANE_HOLDER may contain only letters, digits, dots, underscores, @ and hyphens, up to 64 characters.",
			);
		}
	}
	const holder = values.holder ?? fromEnv;
	const as = values.as ?? fromEnv;
	const minutes = () => {
		if (values.minutes !== undefined && !/^\d+$/.test(values.minutes))
			fail("USAGE", "--minutes takes a whole number of minutes.");
		return values.minutes === undefined
			? DEFAULT_MINUTES
			: Number(values.minutes);
	};
	if (command === "mcp") {
		if (positionals.length !== 1) fail("USAGE", "mcp takes no arguments.");
		await serveMcp(config);
		return;
	}
	if (command === "agent") {
		if (argument !== "install" || positionals.length !== 2)
			fail("USAGE", "Use clonelane agent install.");
		const skill = await readFile(
			new URL("../skills/clonelane/SKILL.md", import.meta.url),
			"utf8",
		);
		const base = values.project ? process.cwd() : homedir();
		const both = !values.claude && !values.agents;
		const installed: string[] = [];
		const backups: string[] = [];
		for (const [wanted, dir] of [
			[values.claude || both, ".claude"],
			[values.agents || both, ".agents"],
		] as const) {
			if (!wanted) continue;
			const folder = join(base, dir, "skills", "clonelane");
			await mkdir(folder, { recursive: true });
			const file = join(folder, "SKILL.md");
			// Reinstalling brings the skill up to date; a copy someone edited is kept beside it.
			const before = await readFile(file, "utf8").catch(() => null);
			if (before != null && before !== skill) {
				await atomicWrite(`${file}.bak`, before);
				backups.push(`${file}.bak`);
			}
			await atomicWrite(file, skill);
			installed.push(file);
		}
		print({ installed, ...(backups.length ? { backups } : {}) });
		return;
	}
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
	if (command === "lease" && (argument === "take" || argument === "release")) {
		const name = positionals[2];
		const workspace =
			name === undefined
				? await workspaceAt(registry, process.cwd())
				: registry.workspaces.find((item) => item.name === name);
		if (positionals.length > 3 || !workspace)
			fail(
				"USAGE",
				`lease ${argument} takes one registered workspace name, or none inside a workspace.`,
			);
		if (argument === "take") {
			if (!holder)
				fail("USAGE", "lease take requires --holder (or CLONELANE_HOLDER).");
			print({
				workspace: workspace.name,
				...(await takeLease(workspace, {
					holder,
					note: values.note,
					minutes: minutes(),
				})),
			});
			return;
		}
		const released = await releaseLease(workspace, {
			holder,
			force: values.force,
		});
		print({ workspace: workspace.name, released });
		return;
	}
	if (command === "here") {
		if (positionals.length !== 1) fail("USAGE", "here takes no arguments.");
		const workspace = await workspaceAt(registry, process.cwd());
		// Still say which workspace this is when its lease or identity cannot be read.
		const lease = await workspaceLease(workspace).then(
			(value) => ({ lease: value }),
			(error: unknown) => ({
				lease: null,
				error: error instanceof ClonelaneError ? error.code : "IO_ERROR",
			}),
		);
		print({ ...workspace, ...lease });
		if ("error" in lease) process.exitCode = 1;
		return;
	}
	if (command === "claim") {
		if (positionals.length !== 1) fail("USAGE", "claim takes no arguments.");
		if (!holder)
			fail("USAGE", "claim requires --holder (or CLONELANE_HOLDER).");
		// The folder's own workspace is the natural pick, and its group the default.
		const here = await workspaceAt(registry, process.cwd()).catch(() => null);
		const group =
			values.group ??
			here?.group ??
			fail("USAGE", "claim requires --group outside a registered workspace.");
		const claimed = await claimWorkspace(selectWorkspaces(registry, group), {
			holder,
			prefer: here?.name,
			note: values.note,
			minutes: minutes(),
		});
		print({
			workspace: claimed.workspace.name,
			path: claimed.workspace.path,
			renewed: claimed.renewed,
			...claimed.lease,
		});
		return;
	}
	if (command === "auto-sync") {
		if (argument === "list" && positionals.length === 2) {
			print(registry.autoSync ?? []);
			return;
		}
		const name = positionals[2];
		if (
			!["on", "off"].includes(argument ?? "") ||
			!name ||
			positionals.length !== 3
		)
			fail(
				"USAGE",
				"Use auto-sync on <group>, auto-sync off <group> or auto-sync list.",
			);
		// Turning it on shows what it would do right now (cached refs, nothing changes),
		// made first so a group is never left on without one.
		const preview =
			argument === "on"
				? await syncWorkspaces(selectWorkspaces(registry, name), {
						dryRun: true,
					})
				: undefined;
		const autoSync = await setAutoSync(config, name, argument === "on");
		print(preview ? { autoSync, preview } : { autoSync });
		return;
	}
	if (command === "worker") {
		if (positionals.length !== 1) fail("USAGE", "worker takes no arguments.");
		if (values.every !== undefined && !/^\d+$/.test(values.every))
			fail("USAGE", "--every takes a whole number of minutes.");
		const every = Number(values.every ?? 15);
		if (every < 5 || every > 1440)
			fail("USAGE", "--every takes 5 to 1440 minutes.");
		// The registry is read on every pass, so auto-sync on/off applies without a restart.
		const pass = async () => {
			const current = await readRegistry(config);
			if (!current.autoSync?.length)
				fail(
					"EMPTY",
					"No group has automatic sync on. Turn one on with clonelane auto-sync on <group>.",
				);
			// Each group is printed as soon as it is done.
			const runs = await runAutoSync(current, undefined, (run) =>
				console.log(JSON.stringify({ time: new Date().toISOString(), ...run })),
			);
			return runs.some(
				(run) =>
					run.error || run.results.some((item) => item.result === "failed"),
			);
		};
		if (values.once) {
			if (await pass()) process.exitCode = 1;
			return;
		}
		for (;;) {
			// One bad pass (registry unreadable, nothing on yet) is reported; the next one runs.
			await pass().catch((error: unknown) =>
				console.error(
					JSON.stringify(
						error instanceof ClonelaneError
							? { error: error.code, message: error.message }
							: { error: "FAILED", message: "This pass failed." },
					),
				),
			);
			await new Promise((done) => setTimeout(done, every * 60_000));
		}
	}
	if (command === "env" && argument === "sync") {
		if (positionals.length !== 3 || !positionals[2])
			fail("USAGE", "env sync requires one profile name.");
		const results = await syncEnvProfile(registry, positionals[2], {
			dryRun: values["dry-run"],
			overwrite: values.overwrite,
			as,
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
			as,
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
		const owner = await operationOwner(
			selectWorkspaces(registry, values.group),
			id,
		);
		const result = await restoreOperation(owner, id, {
			dryRun: values["dry-run"],
			as,
		});
		print(result);
		if (result.result === "refused") process.exitCode = 1;
		return;
	}
	if (command === "lease") {
		if (argument !== "list" || positionals.length !== 2)
			fail("USAGE", "Use lease take, lease release or lease list.");
		const rows = await Promise.all(
			selectWorkspaces(registry, values.group).map(async (workspace) => {
				try {
					return {
						workspace: workspace.name,
						lease: await workspaceLease(workspace),
					};
				} catch (error) {
					process.exitCode = 1;
					return {
						workspace: workspace.name,
						error: error instanceof ClonelaneError ? error.code : "IO_ERROR",
					};
				}
			}),
		);
		if (values.json) print(rows);
		else
			console.table(
				rows.map((row) => ({
					workspace: row.workspace,
					holder: "lease" in row ? (row.lease?.holder ?? "") : `(${row.error})`,
					note: "lease" in row ? (row.lease?.note ?? "") : "",
					until: "lease" in row ? (row.lease?.until ?? "") : "",
				})),
			);
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
								lease: state.lease?.holder ?? "",
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
			as,
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
