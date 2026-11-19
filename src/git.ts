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
	// LC_ALL would override LC_MESSAGES below. Keep its character locale as LC_CTYPE so only
	// the message language changes.
	if (env.LC_ALL) {
		env.LC_CTYPE ??= env.LC_ALL;
		delete env.LC_ALL;
	}
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
					// Untranslated messages only, so failures can be matched below; the
					// character handling of paths and commit subjects is left alone.
					LC_MESSAGES: "C",
					LANGUAGE: "C",
				},
			},
		);
		return stdout.trimEnd();
	} catch (error) {
		const failure = error as {
			killed?: boolean;
			code?: unknown;
			stdout?: unknown;
			stderr?: unknown;
		};
		// Node also sets `killed` when it stops a child for exceeding maxBuffer.
		if (failure.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER")
			fail(
				"GIT_OUTPUT_TOO_LARGE",
				"Git produced more output than Clonelane reads (8 MiB). Run the same step with Git directly.",
			);
		if (failure.killed)
			fail(
				"GIT_TIMEOUT",
				"Git did not finish within 60 seconds. Check the network, or run the same step with Git directly.",
			);
		// Git is launched by absolute path, so ENOENT here means the working folder is gone.
		if (failure.code === "ENOENT")
			fail("GIT_NO_FOLDER", "The workspace folder does not exist any more.");
		const [code, message] = describeGitFailure(
			String(failure.stderr ?? ""),
			String(failure.stdout ?? ""),
		);
		fail(code, message);
	}
}

// Git's output can carry credentials, URLs or file contents, so it is never shown. It is
// only matched against known failure kinds to tell the user what to do next.
const failures: [RegExp, string, string][] = [
	[
		// Windows file errors read "Access is denied", which this does not match.
		/could not read (username|password)|authentication failed|permission denied \(publickey|terminal prompts disabled|returned error: 40[13]|http 40[13]|access denied/i,
		"GIT_AUTH",
		"The remote rejected the credentials. Check that this account can fetch the repository with Git.",
	],
	[
		/could not resolve host(name)?|connection timed out|failed to connect|connection refused|network is unreachable|operation timed out|ssl certificate problem/i,
		"GIT_NETWORK",
		"Could not reach the remote. Check the network connection, VPN or proxy.",
	],
	[
		/couldn't find remote ref/i,
		"GIT_REMOTE_REF",
		"The base branch does not exist on the remote. Check the base branch name.",
	],
	[
		/repository not found|does not appear to be a git repository/i,
		"GIT_REMOTE_MISSING",
		"The remote repository was not found. Check the remote URL and access rights.",
	],
	[
		/\.lock'?: file exists|unable to create '[^']*\.lock'|another git process/i,
		"GIT_LOCKED",
		"Another Git process is working in this repository (a .lock file exists). Wait for it to finish, or remove the stale lock file.",
	],
	[
		/not a git repository/i,
		"GIT_NOT_REPO",
		"This folder is not a Git repository any more.",
	],
	[
		/would be overwritten/i,
		"GIT_LOCAL_CHANGES",
		"Local files would be overwritten. Commit or move them first.",
	],
];

// Git's own conflict reports, not any line that happens to contain the word. Git prints
// "CONFLICT (...)" and "Automatic merge failed" on stdout, "Could not apply" on stderr.
const conflictReports = [
	/^CONFLICT \(/m,
	/^(?:error: )?could not apply [0-9a-f]+|^automatic merge failed/im,
];
const conflict = {
	test: (output: string) =>
		conflictReports.some((report) => report.test(output)),
};
const conflictMessage = "Git stopped on a conflict.";

// stderr is matched against every kind. stdout can hold file contents, subjects or branch
// names, so it is only checked for Git's conflict report.
export function describeGitFailure(
	stderr: string,
	stdout = "",
): [string, string] {
	for (const [pattern, code, message] of failures)
		if (pattern.test(stderr)) return [code, message];
	if (conflict.test(stderr) || conflict.test(stdout))
		return ["GIT_CONFLICT", conflictMessage];
	return [
		"GIT_FAILED",
		"Git operation failed. Inspect the workspace with Git; command output was suppressed.",
	];
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
