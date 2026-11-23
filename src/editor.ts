import { spawn } from "node:child_process";
import { statSync } from "node:fs";
import { basename, dirname, isAbsolute, join } from "node:path";

import { fail } from "./errors.ts";
import { findProgram } from "./git.ts";
import type { Workspace } from "./workspaces.ts";

const isFile = (path: string) => {
	try {
		return statSync(path).isFile();
	} catch {
		return false;
	}
};

/**
 * The editor program to open a workspace folder with: CLONELANE_EDITOR (an absolute path
 * to the program), else VS Code found on PATH. Always a program file, never a shell
 * command line, so a folder name is passed as one argument and never interpreted.
 */
export function findEditor(env = process.env): string | undefined {
	const configured = env.CLONELANE_EDITOR;
	if (configured) {
		if (!isAbsolute(configured) || !isFile(configured))
			fail(
				"EDITOR",
				"CLONELANE_EDITOR must be the full path to your editor's program file.",
			);
		return configured;
	}
	if (process.platform !== "win32")
		return findProgram(["code"], env.PATH ?? "");
	// On Windows PATH holds VS Code's bin\code.cmd, a batch file that needs a shell; the
	// program it starts, Code.exe, sits one folder up.
	const script = findProgram(["code.cmd"], env.PATH ?? "");
	const program = script && join(dirname(dirname(script)), "Code.exe");
	return program && isFile(program) ? program : undefined;
}

/** Opens a workspace folder in the editor, detached; returns the program's file name. */
export function openInEditor(workspace: Workspace, env = process.env): string {
	const program = findEditor(env);
	if (!program)
		fail(
			"EDITOR",
			"No editor found. Install VS Code's code command, or set CLONELANE_EDITOR to your editor's program file.",
		);
	const childEnv = { ...env };
	// Set inside Electron apps and terminals they host; it would start Code.exe as Node.
	delete childEnv.ELECTRON_RUN_AS_NODE;
	const child = spawn(program, [workspace.path], {
		cwd: workspace.path,
		detached: true,
		stdio: "ignore",
		env: childEnv,
	});
	// A start failure is reported by the editor not opening; it must not crash the caller.
	child.on("error", () => {});
	child.unref();
	return basename(program);
}
