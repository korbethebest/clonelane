import { emitKeypressEvents } from "node:readline";
import type { Readable, Writable } from "node:stream";

import { openInEditor } from "./editor.ts";
import { ClonelaneError } from "./errors.ts";
import { readRegistry, selectWorkspaces } from "./registry.ts";
import { fetchWorkspaces, type SyncResult, syncWorkspaces } from "./sync.ts";
import {
	inspectWorkspace,
	type Workspace,
	type WorkspaceStatus,
} from "./workspaces.ts";

/**
 * `clonelane tui`: a full-screen overview of the registered workspaces in a terminal,
 * with the everyday actions on single keys. Plain ANSI, no dependencies. It reads Git
 * state, fetches and syncs by the same rules as the CLI; it never rebases.
 */

export type Row = WorkspaceStatus | { workspace: Workspace; error: string };

export interface Screen {
	rows: Row[];
	selected: number;
	/** One line under the list: what just happened, or what went wrong. */
	message: string;
	busy: string;
	/** Replaces the selected workspace's details: a sync preview or its results. */
	panel?: { title: string; lines: string[] };
}

const keys = "↑↓ select  r reload  f fetch  s sync  o open in editor  q quit";

// shortcut: counts UTF-16 units, so wide (CJK) characters overflow narrow terminals;
// measure display width if names with them become common.
const fit = (text: string, width: number) =>
	text.length <= width ? text : `${text.slice(0, Math.max(0, width - 1))}…`;

const counts = (ahead: number | null, behind: number | null) =>
	ahead == null || behind == null
		? "not fetched"
		: ahead === 0 && behind === 0
			? "even"
			: [ahead ? `↑${ahead}` : "", behind ? `↓${behind}` : ""]
					.filter(Boolean)
					.join(" ");

function cells(row: Row, groups: boolean): string[] {
	const name = row.workspace.name;
	const group = groups ? [row.workspace.group] : [];
	if ("error" in row) return [name, ...group, "", row.error, "", ""];
	const state = [
		row.operation ? "operation" : row.dirty ? "changes" : "clean",
		row.interrupted ? "interrupted" : "",
	]
		.filter(Boolean)
		.join(", ");
	return [
		name,
		...group,
		row.branch ?? "(detached)",
		state,
		counts(row.baseAhead, row.baseBehind),
		row.lease ? `${row.lease.holder}` : "",
	];
}

function table(rows: string[][], width: number): string[] {
	const widths = rows[0]?.map((_, column) =>
		Math.min(24, Math.max(...rows.map((row) => row[column]?.length ?? 0))),
	);
	return rows.map((row) =>
		fit(
			row
				.map((cell, column) =>
					fit(cell, widths?.[column] ?? 0).padEnd(widths?.[column] ?? 0),
				)
				.join("  ")
				.trimEnd(),
			width,
		),
	);
}

function details(row: Row): string[] {
	const lines = [`${row.workspace.name}  ${row.workspace.path}`];
	if ("error" in row) return lines;
	if (row.lease)
		lines.push(
			`  leased by ${row.lease.holder} until ${row.lease.until}${row.lease.note ? ` (${row.lease.note})` : ""}`,
		);
	if (row.subject) lines.push(`  ${row.head.slice(0, 8)} ${row.subject}`);
	lines.push(
		"",
		...table(
			row.branches.map((branch) => [
				`${branch.current ? "*" : " "} ${branch.name}`,
				branch.upstream?.replace(/^refs\/remotes\//, "") ?? "",
				branch.upstream ? counts(branch.ahead, branch.behind) : "",
			]),
			Number.POSITIVE_INFINITY,
		).map((line) => `  ${line}`),
	);
	return lines;
}

/** The whole screen as lines, each at most `width` characters (before colour). */
export function render(
	screen: Screen,
	width: number,
	height: number,
	color = false,
): string[] {
	const paint = (code: string, text: string) =>
		color ? `\x1b[${code}m${text}\x1b[0m` : text;
	const groups =
		new Set(screen.rows.map((row) => row.workspace.group)).size > 1;
	const header = [
		"NAME",
		...(groups ? ["GROUP"] : []),
		"BRANCH",
		"STATE",
		"BASE",
		"LEASE",
	];
	const lines = table(
		[header, ...screen.rows.map((row) => cells(row, groups))],
		width - 2,
	);
	const out = [
		paint(
			"1",
			fit(
				`Clonelane  ${screen.rows.length} workspace${screen.rows.length === 1 ? "" : "s"}`,
				width,
			),
		),
		"",
		paint("2", `  ${lines[0] ?? ""}`),
	];
	// The list gets up to half the screen and scrolls to keep the selection in view.
	const room = Math.max(
		1,
		Math.min(screen.rows.length, Math.floor((height - 6) / 2)),
	);
	const first = Math.min(
		Math.max(0, screen.selected - room + 1),
		Math.max(0, screen.rows.length - room),
	);
	for (
		let index = first;
		index < first + room && index < screen.rows.length;
		index++
	) {
		const line = `${index === screen.selected ? "▸" : " "} ${lines[index + 1] ?? ""}`;
		const row = screen.rows[index];
		out.push(
			index === screen.selected
				? paint("7", line.padEnd(width))
				: row && "error" in row
					? paint("31", line)
					: line,
		);
	}
	out.push("");
	const selected = screen.rows[screen.selected];
	const body = screen.panel
		? [paint("1", fit(screen.panel.title, width)), ...screen.panel.lines]
		: selected
			? details(selected)
			: ["No workspaces registered. Add one with clonelane register."];
	const footer = [
		fit(screen.busy || screen.message, width),
		paint("2", fit(keys, width)),
	];
	const space = Math.max(0, height - out.length - footer.length);
	out.push(
		...body.slice(0, space).map((line) => fit(line, width)),
		...Array(Math.max(0, space - body.length)).fill(""),
		...footer,
	);
	return out;
}

const describe = (error: unknown) =>
	error instanceof ClonelaneError
		? error.message
		: "Failed. Details were suppressed to protect local secrets.";

const reason = (text: string | undefined) => (text ?? "").replaceAll("-", " ");

function syncLines(results: SyncResult[]): string[] {
	return table(
		results.map((result) => [
			result.name,
			result.result === "planned" ? result.action : result.result,
			result.message ?? reason(result.reason),
		]),
		Number.POSITIVE_INFINITY,
	).map((line) => `  ${line}`);
}

type Terminal = Writable & { columns?: number; rows?: number; isTTY?: boolean };
type Keyboard = Readable & {
	isTTY?: boolean;
	setRawMode?: (on: boolean) => void;
};

/** Runs the overview until q or Ctrl+C. Needs an interactive terminal. */
export async function runTui(
	options: { config: string; group?: string; as?: string },
	input: Keyboard = process.stdin,
	output: Terminal = process.stdout,
): Promise<void> {
	if (!input.isTTY || !output.isTTY || !input.setRawMode)
		throw new ClonelaneError(
			"USAGE",
			"clonelane tui needs an interactive terminal. Use clonelane status for scripts.",
		);
	const color = !process.env.NO_COLOR;
	const screen: Screen = { rows: [], selected: 0, message: "", busy: "" };
	let workspaces: Workspace[] = [];
	let confirm: (() => Promise<void>) | undefined;
	const draw = () =>
		output.write(
			`\x1b[H\x1b[2J${render(screen, output.columns ?? 80, output.rows ?? 24, color).join("\r\n")}`,
		);
	const reload = async () => {
		workspaces = selectWorkspaces(
			await readRegistry(options.config),
			options.group,
		);
		screen.rows = await Promise.all(
			workspaces.map((workspace) =>
				inspectWorkspace(workspace, { reuseIdentity: true }).catch(
					(error: unknown): Row => ({
						workspace,
						error: error instanceof ClonelaneError ? error.code : "IO_ERROR",
					}),
				),
			),
		);
		screen.selected = Math.min(
			screen.selected,
			Math.max(0, screen.rows.length - 1),
		);
	};
	const run = async (busy: string, task: () => Promise<string>) => {
		screen.busy = busy;
		draw();
		try {
			screen.message = await task();
		} catch (error) {
			screen.message = describe(error);
		}
		screen.busy = "";
		draw();
	};
	const up = () => {
		screen.selected = Math.max(0, screen.selected - 1);
	};
	const down = () => {
		screen.selected = Math.min(screen.rows.length - 1, screen.selected + 1);
	};
	const actions: Record<string, () => Promise<void> | void> = {
		up,
		down,
		k: up,
		j: down,
		r: () =>
			run("Reading Git state…", async () => {
				await reload();
				return "Reloaded. Remote refs are cached; f fetches.";
			}),
		f: () =>
			run("Fetching…", async () => {
				const results = await fetchWorkspaces(workspaces);
				await reload();
				const failed = results.filter((result) => result.result === "failed");
				return failed.length
					? failed
							.map((result) => `${result.name}: ${result.message}`)
							.join("  ")
					: `Fetched ${results.length}.`;
			}),
		s: () =>
			run("Previewing sync…", async () => {
				const plans = await syncWorkspaces(workspaces, {
					dryRun: true,
					as: options.as,
				});
				const changes = plans.some(
					(plan) =>
						plan.action === "fast-forward" ||
						plan.baseUpdate?.action === "fast-forward",
				);
				screen.panel = {
					title: "Sync preview (cached remote refs)",
					lines: syncLines(plans),
				};
				if (!changes) return "Nothing to sync. f fetches the latest first.";
				confirm = () =>
					run("Fetching and syncing…", async () => {
						const results = await syncWorkspaces(workspaces, {
							fetch: true,
							as: options.as,
						});
						screen.panel = { title: "Sync results", lines: syncLines(results) };
						await reload();
						return results.some((result) => result.result === "failed")
							? "Some workspaces failed; see above."
							: "Synced.";
					});
				return "y applies it (fetches first). Any other key cancels.";
			}),
		o: () =>
			run("Opening…", async () => {
				const row = screen.rows[screen.selected];
				if (!row) return "No workspace selected.";
				return `Opened ${row.workspace.name} in ${openInEditor(row.workspace)}.`;
			}),
	};

	emitKeypressEvents(input);
	input.setRawMode(true);
	input.resume();
	// The alternate screen keeps the user's scrollback; the cursor is hidden while open.
	output.write("\x1b[?1049h\x1b[?25l");
	const onResize = () => draw();
	output.on("resize", onResize);
	try {
		await run("Reading Git state…", async () => {
			await reload();
			return "";
		});
		await new Promise<void>((resolve) => {
			const onKey = async (
				_: string,
				key: { name?: string; ctrl?: boolean },
			) => {
				if (key?.name === "q" || (key?.ctrl && key.name === "c")) {
					input.off("keypress", onKey);
					resolve();
					return;
				}
				if (screen.busy) return;
				const pending = confirm;
				confirm = undefined;
				if (pending) {
					if (key?.name === "y") await pending();
					else {
						screen.message = "Cancelled.";
						draw();
					}
					return;
				}
				const action = key?.name && actions[key.name];
				if (!action) return;
				if (key.name !== "s") screen.panel = undefined;
				await action();
				draw();
			};
			input.on("keypress", onKey);
		});
	} finally {
		output.off("resize", onResize);
		output.write("\x1b[?25h\x1b[?1049l");
		input.setRawMode(false);
		input.pause();
	}
}
