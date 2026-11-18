import { execFile } from "node:child_process";
import { accessSync, constants, mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";

import { fail } from "./errors.ts";

const exec = promisify(execFile);

// Hooks are disabled by pointing core.hooksPath at a place that holds none. On Windows
// "/dev/null/<hook>" resolves under the cwd's drive root (C:\dev\null\<hook>), a folder
// other users can create, so an empty directory private to this process is used instead.
let noHooks: string | undefined;
export function hooksPath(): string {
	if (process.platform !== "win32") return "/dev/null";
	if (noHooks === undefined) {
		const dir = mkdtempSync(join(tmpdir(), "clonelane-no-hooks-"));
		process.once("exit", () => rmSync(dir, { recursive: true, force: true }));
		noHooks = dir;
	}
	return noHooks;
}

// Git is launched by absolute path. A bare "git" is looked up through PATH, and an empty,
// "." or other relative PATH entry means the current directory: the working tree, whose
// files (a committed git.exe) come from the repository. Only fully absolute entries count.
export function findGit(pathEnv = process.env.PATH ?? ""): string {
	const windows = process.platform === "win32";
	const absolute = windows ? /^(?:[A-Za-z]:[\\/]|\\\\)/ : /^\//;
	for (const raw of pathEnv.split(delimiter)) {
		const dir = raw.replace(/^"(.*)"$/, "$1");
		if (!absolute.test(dir)) continue;
		for (const name of windows ? ["git.com", "git.exe"] : ["git"]) {
			const candidate = join(dir, name);
			try {
				if (!statSync(candidate).isFile()) continue;
				if (!windows) accessSync(candidate, constants.X_OK);
				return candidate;
			} catch {}
		}
	}
	fail(
		"GIT_MISSING",
		"Git was not found on PATH. Install Git and add it to PATH.",
	);
}

let gitPath: string | undefined;
const gitExecutable = () => {
	gitPath ??= findGit();
	return gitPath;
};

export async function git(path: string, args: string[]): Promise<string> {
	const executable = gitExecutable();
	const env = { ...process.env };
	for (const key of [
		"GIT_DIR",
		"GIT_WORK_TREE",
		"GIT_COMMON_DIR",
		"GIT_INDEX_FILE",
		"GIT_OBJECT_DIRECTORY",
		"GIT_ALTERNATE_OBJECT_DIRECTORIES",
	])
		delete env[key];
	try {
		const { stdout } = await exec(
			executable,
			[
				"--no-optional-locks",
				"-c",
				`core.hooksPath=${hooksPath()}`,
				"-c",
				"core.fsmonitor=false",
				"-c",
				"maintenance.auto=false",
				"-c",
				"gc.auto=0",
				"-c",
				"core.untrackedCache=false",
				...args,
			],
			{
				cwd: path,
				encoding: "utf8",
				timeout: 60_000,
				maxBuffer: 8 * 1024 * 1024,
				windowsHide: true,
				env: {
					...env,
					GIT_TERMINAL_PROMPT: "0",
					GCM_INTERACTIVE: "never",
					GIT_EDITOR: "true",
				},
			},
		);
		return stdout.trimEnd();
	} catch {
		// Child stdout/stderr may contain remote passwords, file contents or tokens.
		fail(
			"GIT_FAILED",
			"Git operation failed. Inspect the workspace with Git; command output was suppressed.",
		);
	}
}

export async function gitSucceeds(
	path: string,
	args: string[],
): Promise<boolean> {
	try {
		await git(path, args);
		return true;
	} catch {
		return false;
	}
}

export function repositoryIdentity(remote: string, root: string): string {
	// Remote helpers ("<transport>::<address>") wrap a real address: identify that one,
	// which also strips any credentials it carries.
	const helper = /^[A-Za-z][A-Za-z0-9+.-]*::(.+)$/.exec(remote);
	if (helper) return repositoryIdentity(helper[1] as string, root);
	if (/^[a-z][a-z0-9+.-]*:\/\//i.test(remote)) {
		let url: URL;
		try {
			url = new URL(remote);
		} catch {
			fail("REMOTE", "Unsupported remote URL.");
		}
		if (url.protocol === "file:") return url.href.replace(/\/$/, "");
		if (!["ssh:", "http:", "https:"].includes(url.protocol))
			fail("REMOTE", "Unsupported remote protocol.");
		return `${url.hostname.toLowerCase()}${url.port ? `:${url.port}` : ""}/${url.pathname.replace(/^\/+|\/+$/g, "").replace(/\.git$/, "")}`;
	}
	const ssh = /^(?:[^@/]+@)?([^:/\\]+):(.+)$/.exec(remote);
	if (ssh && !/^[A-Za-z]:[\\/]/.test(remote)) {
		return `${ssh[1]?.toLowerCase()}/${ssh[2]?.replace(/\/+$/, "").replace(/\.git$/, "")}`;
	}
	// Local paths are supported for offline use and integration tests.
	return pathToFileURL(resolve(root, remote)).href.replace(/\/$/, "");
}

export function validName(value: string, field = "name"): void {
	if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/.test(value))
		fail(
			"NAME",
			`The ${field} may contain only letters, digits, dots, underscores and hyphens (no spaces), up to 64 characters.`,
		);
}

export async function validBranch(path: string, branch: string): Promise<void> {
	if (
		branch.startsWith("-") ||
		!(await gitSucceeds(path, ["check-ref-format", `refs/heads/${branch}`]))
	) {
		fail("BRANCH", "Invalid base branch.");
	}
}
