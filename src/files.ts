import { randomUUID } from "node:crypto";
import {
	type FileHandle,
	lstat,
	mkdir,
	open,
	readFile,
	realpath,
	rename,
	unlink,
} from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";

import { fail } from "./errors.ts";

export async function exists(path: string): Promise<boolean> {
	try {
		await lstat(path);
		return true;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
		throw error;
	}
}

export async function regularFile(path: string): Promise<void> {
	const stat = await lstat(path);
	if (!stat.isFile() || stat.nlink !== 1)
		fail("UNSAFE_FILE", "Expected a regular, unlinked file.");
}

export async function readOptional(path: string): Promise<string | null> {
	if (!(await exists(path))) return null;
	await regularFile(path);
	return readFile(path, "utf8");
}

// The parent must be trusted. This is not a sandbox against a hostile local user.
export async function atomicWrite(
	path: string,
	content: string,
): Promise<void> {
	const parent = await realpath(dirname(resolve(path)));
	const target = join(parent, path.split(/[\\/]/).at(-1) ?? "");
	if (await exists(target)) await regularFile(target);
	// Named after the target so a temp file left by a hard kill stays covered by the same
	// ignore rule (".env.*" for ".env"); it can hold every copied secret.
	const temp = join(
		parent,
		`${basename(target)}.clonelane-${randomUUID()}.tmp`,
	);
	const handle = await open(temp, "wx", 0o600);
	try {
		try {
			await handle.writeFile(content, "utf8");
			await handle.sync();
		} finally {
			await handle.close();
		}
		await rename(temp, target);
	} finally {
		if (await exists(temp)) await unlink(temp);
	}
}

export async function withLock<T>(
	path: string,
	action: () => Promise<T>,
): Promise<T> {
	await mkdir(dirname(path), { recursive: true, mode: 0o700 });
	let handle: FileHandle;
	try {
		handle = await open(path, "wx", 0o600);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "EEXIST") {
			fail(
				"LOCKED",
				"Another Clonelane operation holds this lock. Inspect before removing a stale lock.",
			);
		}
		throw error;
	}
	try {
		await handle.writeFile(`${process.pid}\n`);
		return await action();
	} finally {
		await handle.close();
		await unlink(path);
	}
}
