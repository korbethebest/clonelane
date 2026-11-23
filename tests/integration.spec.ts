import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import {
	copyFile,
	link,
	mkdir,
	mkdtemp,
	readdir,
	readFile,
	realpath,
	rm,
	symlink,
	writeFile,
} from "node:fs/promises";
import { delimiter, dirname, join, relative, resolve, sep } from "node:path";
import { describe, type TestContext, test } from "node:test";
import { parseEnv, promisify } from "node:util";
import {
	describeGitFailure,
	findGit,
	git,
	hooksPath,
	moveRefLocked,
	repositoryIdentity,
} from "../src/git.ts";
import {
	addWorkspace,
	applyEnv,
	claimWorkspace,
	fetchWorkspaces,
	historyGraph,
	inspectWorkspace,
	listOperations,
	planEnv,
	readLease,
	readRegistry,
	registerWorkspace,
	releaseLease,
	removeProfile,
	removeWorkspace,
	restoreOperation,
	runAutoSync,
	saveProfile,
	setAutoSync,
	syncEnvProfile,
	syncWorkspaces,
	takeLease,
	updateWorkspace,
	workspaceAt,
} from "../src/index.ts";
import { begin } from "../src/journal.ts";

const exec = promisify(execFile);
const sandbox = resolve("tests.local");
// Test subprocesses must not mix the developer's global Git settings with fixture settings.
process.env.GIT_CONFIG_GLOBAL = "/dev/null";
process.env.GIT_CONFIG_NOSYSTEM = "1";

async function run(path: string, args: string[]): Promise<string> {
	const { stdout } = await exec(
		"git",
		[
			"-c",
			"user.name=Clonelane Test",
			"-c",
			"user.email=test@clonelane.invalid",
			"-c",
			"commit.gpgsign=false",
			"-c",
			`core.hooksPath=${hooksPath()}`,
			...args,
		],
		{
			cwd: path,
			encoding: "utf8",
			windowsHide: true,
			env: {
				...process.env,
				GIT_CONFIG_GLOBAL: "/dev/null",
				GIT_CONFIG_NOSYSTEM: "1",
				GIT_AUTHOR_NAME: "Clonelane Test",
				GIT_AUTHOR_EMAIL: "test@clonelane.invalid",
				GIT_COMMITTER_NAME: "Clonelane Test",
				GIT_COMMITTER_EMAIL: "test@clonelane.invalid",
			},
		},
	);
	return stdout.trim();
}

async function fixture(t: TestContext) {
	await mkdir(sandbox, { recursive: true });
	const root = await mkdtemp(join(sandbox, "case-"));
	t.after(async () => {
		const target = resolve(root);
		assert.ok(
			target.startsWith(sandbox + sep),
			"cleanup stays inside test sandbox",
		);
		await rm(target, {
			recursive: true,
			force: true,
			maxRetries: 5,
			retryDelay: 100,
		});
	});
	const remote = join(root, "remote.git");
	const seed = join(root, "seed");
	const first = join(root, "first clone");
	const second = join(root, "second");
	await run(root, ["init", "--bare", "--initial-branch=master", remote]);
	await run(root, ["clone", remote, seed]);
	await writeFile(join(seed, ".gitignore"), ".env\n.env.*\n");
	await writeFile(join(seed, "hello.txt"), "initial\n");
	await run(seed, ["add", "."]);
	await run(seed, ["commit", "-m", "initial"]);
	await run(seed, ["push", "origin", "master"]);
	await run(root, ["clone", remote, first]);
	await run(root, ["clone", remote, second]);
	for (const path of [first, second]) {
		await run(path, ["config", "user.name", "Clonelane Test"]);
		await run(path, ["config", "user.email", "test@clonelane.invalid"]);
	}
	const a = await registerWorkspace({
		name: "first",
		path: first,
		group: "demo",
	});
	const b = await registerWorkspace({
		name: "second",
		path: second,
		group: "demo",
	});
	async function publish(file = "new.txt", content = "remote update\n") {
		await writeFile(join(seed, file), content);
		await run(seed, ["add", file]);
		await run(seed, ["commit", "-m", "advance master"]);
		await run(seed, ["push", "origin", "master"]);
		return run(seed, ["rev-parse", "HEAD"]);
	}
	return { root, remote, seed, first, second, a, b, publish };
}

describe("isolated Git and env integration", { concurrency: 4 }, () => {
	test("remote identity unifies SSH/HTTPS and never retains credentials", () => {
		assert.equal(
			repositoryIdentity(
				"https://alice:secret@github.com/Team/Repo.git?token=secret",
				".",
			),
			"github.com/Team/Repo",
		);
		assert.equal(
			repositoryIdentity("git@github.com:Team/Repo.git", "."),
			"github.com/Team/Repo",
		);
		// Remote-helper form: identify the wrapped address and drop its credentials.
		assert.equal(
			repositoryIdentity(
				"persistent-https::https://user:SYNTHETIC_TOKEN@github.com/Team/Repo.git",
				".",
			),
			"github.com/Team/Repo",
		);
	});

	test("hooks never run: neither the repository's own nor one planted at a Windows drive root", async (t) => {
		const f = await fixture(t);
		const marker = join(f.root, "hook-ran");
		const hook = `#!${process.execPath.replace(/\\/g, "/")}\nrequire("fs").writeFileSync(${JSON.stringify(marker)}, "hit")\n`;
		await writeFile(
			join(f.first, ".git", "hooks", "reference-transaction"),
			hook,
			{ mode: 0o755 },
		);
		await git(f.first, ["update-ref", "refs/heads/probe", "HEAD"]);
		assert.equal(existsSync(marker), false, "repository hook ran");
		if (process.platform !== "win32") return;
		// "/dev/null/<hook>" resolves under the cwd's drive root on Windows; a virtual drive
		// stands in for C:\ so nothing is written outside the sandbox.
		const drive = ["R:", "Q:", "P:", "O:", "N:"].find(
			(d) => !existsSync(`${d}\\`),
		);
		if (!drive) return t.skip("no free drive letter for subst");
		const base = join(f.root, "drive");
		await mkdir(base);
		await exec("subst", [drive, base]);
		t.after(() => exec("subst", [drive, "/d"]));
		await run(`${drive}\\`, ["clone", f.remote, "clone"]);
		// Planted only now, so the one Git call under test is the one that could run it.
		await mkdir(join(base, "dev", "null"), { recursive: true });
		await writeFile(join(base, "dev", "null", "reference-transaction"), hook);
		await git(`${drive}\\clone`, ["update-ref", "refs/heads/probe", "HEAD"]);
		assert.equal(existsSync(marker), false, "drive-root hook ran");
	});

	test("Git is resolved from absolute PATH entries only", async (t) => {
		const f = await fixture(t);
		const real = findGit();
		await writeFile(
			join(f.root, process.platform === "win32" ? "git.exe" : "git"),
			"#!/bin/sh\nexit 0\n",
			{ mode: 0o755 },
		);
		// Empty, "." and relative entries all point into the current directory tree.
		const path = ["", ".", relative(process.cwd(), f.root), dirname(real)].join(
			delimiter,
		);
		assert.equal(findGit(path), real);
		assert.throws(() => findGit(relative(process.cwd(), f.root)), {
			code: "GIT_MISSING",
		});
	});

	test("a git.exe in the working tree is never run in place of Git", {
		skip: process.platform !== "win32",
	}, async (t) => {
		const f = await fixture(t);
		await copyFile(
			"C:\\Windows\\System32\\whoami.exe",
			join(f.first, "git.exe"),
		);
		assert.match(await git(f.first, ["--version"]), /^git version/);
	});

	test("registry groups independent clones and rejects duplicate or mismatched entries", async (t) => {
		const f = await fixture(t);
		const config = join(f.root, "registry.json");
		await addWorkspace(config, { name: "a", path: f.first, group: "demo" });
		await addWorkspace(config, { name: "b", path: f.second, group: "demo" });
		assert.equal((await readRegistry(config)).workspaces.length, 2);
		await assert.rejects(
			addWorkspace(config, { name: "a", path: f.seed, group: "demo" }),
			{ code: "DUPLICATE" },
		);
		await assert.rejects(
			addWorkspace(config, {
				name: "c",
				path: f.seed,
				group: "demo",
				base: "main",
			}),
			{ code: "GROUP_MISMATCH" },
		);
	});

	test("registry edits rename, regroup and forget workspaces without touching folders", async (t) => {
		const f = await fixture(t);
		const config = join(f.root, "registry.json");
		await addWorkspace(config, { name: "a", path: f.first, group: "Demo" });
		await addWorkspace(config, { name: "b", path: f.second, group: "other" });
		await assert.rejects(
			addWorkspace(config, { name: "c", path: f.seed, group: "demo" }),
			(error: Error) =>
				/"Demo"/.test(error.message) &&
				"code" in error &&
				error.code === "GROUP_CASE",
		);
		await assert.rejects(
			planEnv(f.a, { ...f.b, group: "other" }, { file: ".env", keys: "all" }),
			{
				code: "ENV_GROUP",
			},
		);
		const moved = await updateWorkspace(config, "b", {
			name: "b2",
			group: "Demo",
		});
		assert.deepEqual([moved.name, moved.group], ["b2", "Demo"]);
		await assert.rejects(updateWorkspace(config, "b2", { name: "a" }), {
			code: "DUPLICATE",
		});
		await assert.rejects(updateWorkspace(config, "missing", { group: "x" }), {
			code: "WORKSPACE",
		});
		await removeWorkspace(config, "a");
		assert.deepEqual(
			(await readRegistry(config)).workspaces.map((item) => [
				item.name,
				item.group,
			]),
			[["b2", "Demo"]],
		);
		assert.equal(
			await run(f.first, ["rev-parse", "--is-inside-work-tree"]),
			"true",
		);
	});

	test("a partly pushed branch is never rebased; a file named HEAD does not break inspection", async (t) => {
		const f = await fixture(t);
		await run(f.first, ["switch", "-c", "feat"]);
		for (const name of ["b", "c"]) {
			await writeFile(join(f.first, `${name}.txt`), `${name}\n`);
			await run(f.first, ["add", "."]);
			await run(f.first, ["commit", "-m", name]);
			// Push b without an upstream; c stays local, so the tip is unpublished.
			if (name === "b") await run(f.first, ["push", "origin", "feat"]);
		}
		await writeFile(join(f.first, ".git", "info", "exclude"), "HEAD\n");
		await writeFile(join(f.first, "HEAD"), "not a revision\n");
		await f.publish();
		await fetchWorkspaces([f.a]);
		assert.equal((await inspectWorkspace(f.a)).subject, "c");
		const [plan] = await syncWorkspaces([f.a], { dryRun: true, rebase: true });
		assert.equal(plan?.action, "skip");
		assert.equal(plan?.reason, "published-or-merge-branch");
	});

	test("fetch handles two bases of one clone under its single lock", async (t) => {
		const f = await fixture(t);
		await run(f.seed, ["push", "origin", "master:develop"]);
		const path = join(f.root, "dev");
		await run(f.first, ["worktree", "add", "--detach", path]);
		const dev = await registerWorkspace({
			name: "dev",
			path,
			group: "dev",
			base: "develop",
		});
		await fetchWorkspaces([f.a, dev]);
		assert.ok(await run(f.first, ["rev-parse", "refs/remotes/origin/develop"]));
	});

	test("sync never overwrites an ignored .env that the incoming base adds", async (t) => {
		const f = await fixture(t);
		await writeFile(join(f.first, ".env"), "TOKEN=local-synthetic\n");
		await writeFile(join(f.seed, ".env"), "TOKEN=remote-synthetic\n");
		await run(f.seed, ["add", "-f", ".env"]);
		await run(f.seed, ["commit", "-m", "commit env by mistake"]);
		await run(f.seed, ["push", "origin", "master"]);
		await fetchWorkspaces([f.a]);
		const [preview] = await syncWorkspaces([f.a], { dryRun: true });
		assert.equal(preview?.reason, "local-files-in-the-way");
		const [result] = await syncWorkspaces([f.a]);
		assert.equal(result?.result, "skipped");
		assert.equal(
			await readFile(join(f.first, ".env"), "utf8"),
			"TOKEN=local-synthetic\n",
		);
	});

	test("env refuses a target whose .env differs from a tracked or present file only by case", async (t) => {
		const f = await fixture(t);
		await writeFile(join(f.seed, ".ENV"), "A=1\n");
		await run(f.seed, ["add", "-f", ".ENV"]);
		await run(f.seed, ["commit", "-m", "tracked upper-case env"]);
		await run(f.seed, ["push", "origin", "master"]);
		await run(f.second, ["pull", "-q", "--ff-only"]);
		await writeFile(join(f.first, ".env"), "A=synthetic\n");
		const options = { file: ".env", keys: ["A"], overwrite: true };
		await assert.rejects(applyEnv(f.a, f.b, options), { code: "ENV_CASE" });
		// Tracked but absent on disk: the case-insensitive pathspec still catches it.
		await rm(join(f.second, ".ENV"));
		await writeFile(join(f.second, ".env"), "A=2\n");
		await assert.rejects(applyEnv(f.a, f.b, options), { code: "TRACKED_ENV" });
		assert.equal(await run(f.second, ["show", "HEAD:.ENV"]), "A=1");
	});

	test("a base being rebased in another worktree is not moved", async (t) => {
		const f = await fixture(t);
		await run(f.first, ["switch", "-c", "feature"]);
		await run(f.first, ["worktree", "add", "--detach", join(f.root, "other")]);
		const { commonDir } = await inspectWorkspace(f.a);
		const [id = ""] = await readdir(join(commonDir, "worktrees"));
		await mkdir(join(commonDir, "worktrees", id, "rebase-merge"));
		await writeFile(
			join(commonDir, "worktrees", id, "rebase-merge", "head-name"),
			"refs/heads/master\n",
		);
		await f.publish();
		await fetchWorkspaces([f.a]);
		const [plan] = await syncWorkspaces([f.a], { dryRun: true });
		assert.equal(
			plan?.baseUpdate?.reason,
			"base-checked-out-in-another-worktree",
		);
	});

	test("worktrees share common metadata but retain independent current branches", async (t) => {
		const f = await fixture(t);
		const path = join(f.root, "linked");
		await run(f.first, ["worktree", "add", "-b", "feature", path]);
		const linked = await registerWorkspace({
			name: "linked",
			path,
			group: "demo",
		});
		const first = await inspectWorkspace(f.a);
		const second = await inspectWorkspace(linked);
		assert.equal(first.commonDir, second.commonDir);
		assert.equal(second.branch, "feature");
		assert.ok(second.branches.some((branch) => branch.name === "master"));
	});

	test("status carries the HEAD subject; the graph lists branch commits and connector lines", async (t) => {
		const f = await fixture(t);
		await run(f.first, ["switch", "-c", "feature"]);
		await writeFile(join(f.first, "feature.txt"), "x\n");
		await run(f.first, ["add", "."]);
		await run(f.first, ["commit", "-m", "feature work"]);
		await run(f.first, ["switch", "master"]);
		await writeFile(join(f.first, "local.txt"), "y\n");
		await run(f.first, ["add", "."]);
		await run(f.first, ["commit", "-m", "local master"]);
		assert.equal((await inspectWorkspace(f.a)).subject, "local master");
		const commits = await historyGraph(f.a);
		assert.deepEqual(commits.map((commit) => commit.subject).sort(), [
			"feature work",
			"initial",
			"local master",
		]);
		const initial = commits.find((commit) => commit.subject === "initial");
		const local = commits.find((commit) => commit.subject === "local master");
		assert.deepEqual(local?.parents, [initial?.hash]);
		assert.deepEqual(local?.refs, [{ name: "master", kind: "head" }]);
		// origin/HEAD is an alias and is left out.
		assert.deepEqual(initial?.refs, [
			{ name: "origin/master", kind: "remote" },
		]);
		assert.equal(initial?.author, "Clonelane Test");
		assert.ok((initial?.time ?? 0) > 0);
	});

	test("a lease keeps sync, env and restore away from a workspace unless acting as its holder", async (t) => {
		const f = await fixture(t);
		const lease = await takeLease(f.b, {
			holder: "agent-1",
			note: "feat/login",
		});
		assert.equal((await inspectWorkspace(f.b)).lease?.holder, "agent-1");
		await assert.rejects(takeLease(f.b, { holder: "someone" }), {
			code: "LEASED",
		});
		// Renewing keeps since and moves until.
		const renewed = await takeLease(f.b, { holder: "agent-1", minutes: 600 });
		assert.equal(renewed.since, lease.since);
		assert.equal(renewed.note, "feat/login");
		assert.ok(Date.parse(renewed.until) > Date.parse(lease.until));

		await f.publish();
		const tracked = () =>
			run(f.second, ["rev-parse", "refs/remotes/origin/master"]);
		const before = await tracked();
		const synced = await syncWorkspaces([f.a, f.b], { fetch: true });
		// Not even fetched: its remote-tracking refs stay where the holder left them.
		assert.equal(await tracked(), before);
		assert.deepEqual(
			synced.map((item) => [item.name, item.result, item.reason]),
			[
				["first", "updated", "base-branch"],
				["second", "skipped", "leased"],
			],
		);
		const mine = await syncWorkspaces([f.b], { as: "agent-1", fetch: true });
		assert.equal(mine[0]?.result, "updated");

		await writeFile(join(f.first, ".env"), "TOKEN=x\n");
		const options = { file: ".env", keys: "all" as const };
		await assert.rejects(planEnv(f.a, f.b, options), { code: "LEASED" });
		await planEnv(f.a, f.b, { ...options, as: "agent-1" });

		const [operation] = await listOperations(f.b);
		assert.ok(operation);
		assert.equal(
			(await restoreOperation(f.b, operation.id, { dryRun: true })).reason,
			"leased",
		);
		assert.equal(
			(
				await restoreOperation(f.b, operation.id, {
					dryRun: true,
					as: "agent-1",
				})
			).result,
			"planned",
		);

		await assert.rejects(releaseLease(f.b, { holder: "someone" }), {
			code: "LEASED",
		});
		assert.equal(
			(await releaseLease(f.b, { holder: "agent-1" }))?.holder,
			"agent-1",
		);
		assert.equal((await inspectWorkspace(f.b)).lease, null);

		// A lapsed lease is gone; an unreadable one is held by "unknown" until forced.
		const gitDir = join(f.second, ".git");
		const file = join(gitDir, "clonelane-lease.json");
		await writeFile(
			file,
			JSON.stringify({
				holder: "old",
				since: "x",
				until: "2000-01-01T00:00:00Z",
			}),
		);
		assert.equal(await readLease(gitDir), null);
		await writeFile(file, "not json");
		assert.equal((await readLease(gitDir))?.holder, "?");
		// No holder name matches it, so --as cannot get past it either.
		await assert.rejects(planEnv(f.a, f.b, { ...options, as: "?" }), {
			code: "LEASED",
		});
		await assert.rejects(releaseLease(f.b), { code: "LEASED" });
		await releaseLease(f.b, { force: true });
		assert.equal(await readLease(gitDir), null);
		await assert.rejects(takeLease(f.b, { holder: "bad name" }), {
			code: "LEASE_HOLDER",
		});
	});

	test("claim leases a free workspace, renews the holder's own, and the CLI finds the current one", async (t) => {
		const f = await fixture(t);
		const config = join(f.root, "registry.json");
		await addWorkspace(config, { name: "first", path: f.first, group: "demo" });
		await addWorkspace(config, {
			name: "second",
			path: f.second,
			group: "demo",
		});
		const registry = await readRegistry(config);
		// Inside a workspace, from a subfolder too; outside, a clear code.
		await mkdir(join(f.second, "src"), { recursive: true });
		assert.equal(
			(await workspaceAt(registry, join(f.second, "src"))).name,
			"second",
		);
		await assert.rejects(workspaceAt(registry, f.root), {
			code: "NOT_A_WORKSPACE",
		});
		// A dirty workspace is not free; the clean one is claimed, and claiming again renews it.
		await writeFile(join(f.first, "hello.txt"), "local edit\n");
		const claimed = await claimWorkspace(registry.workspaces, {
			holder: "codex-1",
			note: "task",
		});
		assert.equal(claimed.workspace.name, "second");
		assert.equal(claimed.renewed, false);
		const again = await claimWorkspace(registry.workspaces, {
			holder: "codex-1",
		});
		assert.equal(again.workspace.name, "second");
		assert.equal(again.renewed, true);
		assert.equal(again.lease.note, "task");
		const long = await takeLease(claimed.workspace, {
			holder: "codex-1",
			minutes: 600,
		});
		const retried = await claimWorkspace(registry.workspaces, {
			holder: "codex-1",
		});
		assert.equal(retried.lease.until, long.until);
		// Nothing else is free: one is leased, the other dirty.
		await assert.rejects(
			claimWorkspace(registry.workspaces, { holder: "codex-2" }),
			{
				code: "NO_FREE_WORKSPACE",
			},
		);
		await assert.rejects(
			claimWorkspace(registry.workspaces, { holder: "bad name" }),
			{
				code: "LEASE_HOLDER",
			},
		);

		// CLI: CLONELANE_HOLDER stands in for --holder and --as, and "here" is the cwd.
		const cli = (args: string[], cwd: string, holder?: string) =>
			exec(
				process.execPath,
				[resolve("src/cli.ts"), ...args, "--config", config],
				{
					cwd,
					encoding: "utf8",
					env: { ...process.env, CLONELANE_HOLDER: holder ?? "" },
				},
			);
		const here = JSON.parse(
			(await cli(["here"], join(f.second, "src"))).stdout,
		);
		assert.equal(here.name, "second");
		assert.equal(here.lease.holder, "codex-1");
		// Leased by codex-1: a sync as anyone else skips it, as codex-1 does not.
		const skipped = JSON.parse(
			(await cli(["sync", "--dry-run"], f.second)).stdout,
		);
		assert.equal(
			skipped.find((item: { name: string }) => item.name === "second")?.reason,
			"leased",
		);
		const own = JSON.parse(
			(await cli(["sync", "--dry-run"], f.second, "codex-1")).stdout,
		);
		assert.notEqual(
			own.find((item: { name: string }) => item.name === "second")?.reason,
			"leased",
		);
		await assert.rejects(
			cli(["lease", "release"], f.second, "codex-2"),
			/LEASED/,
		);
		const released = JSON.parse(
			(await cli(["lease", "release"], f.second, "codex-1")).stdout,
		);
		assert.equal(released.workspace, "second");
		assert.equal(released.released.holder, "codex-1");
		// claim from inside the group defaults to that group and prints the path to work in.
		const viaCli = JSON.parse(
			(await cli(["claim", "--note", "fix"], f.first, "gemini")).stdout,
		);
		assert.equal(viaCli.workspace, "second");
		assert.equal(viaCli.holder, "gemini");
		assert.equal(viaCli.path, (await readRegistry(config)).workspaces[1]?.path);
		await assert.rejects(cli(["claim"], f.root, "gemini"), /USAGE/);
		await assert.rejects(cli(["claim", "--group", "demo"], f.root), /USAGE/);

		// agent install --project writes the skill for Claude and for .agents tools.
		const installed = JSON.parse(
			(await cli(["agent", "install", "--project"], f.root)).stdout,
		);
		assert.deepEqual(installed.installed, [
			join(f.root, ".claude", "skills", "clonelane", "SKILL.md"),
			join(f.root, ".agents", "skills", "clonelane", "SKILL.md"),
		]);
		const skill = await readFile(installed.installed[1], "utf8");
		// Reinstalling keeps an edited copy beside the fresh one.
		await writeFile(installed.installed[0], "my notes\n");
		const again2 = JSON.parse(
			(await cli(["agent", "install", "--project", "--claude"], f.root)).stdout,
		);
		assert.deepEqual(again2.backups, [`${installed.installed[0]}.bak`]);
		assert.equal(
			await readFile(`${installed.installed[0]}.bak`, "utf8"),
			"my notes\n",
		);
		assert.equal(await readFile(installed.installed[0], "utf8"), skill);
		// A holder name the CLI could never use is refused up front.
		await assert.rejects(
			cli(["status"], f.root, "my agent"),
			/CLONELANE_HOLDER/,
		);
		assert.match(skill, /^---\nname: clonelane\ndescription: /);
	});

	test("the MCP server answers over stdio: tools list, here, claim, previews and errors", async (t) => {
		const f = await fixture(t);
		const config = join(f.root, "registry.json");
		await addWorkspace(config, { name: "first", path: f.first, group: "demo" });
		await addWorkspace(config, {
			name: "second",
			path: f.second,
			group: "demo",
		});
		const before = await run(f.first, ["rev-parse", "HEAD"]);
		await f.publish();
		await fetchWorkspaces((await readRegistry(config)).workspaces);
		const requests: object[] = [
			{
				jsonrpc: "2.0",
				id: 1,
				method: "initialize",
				params: {
					protocolVersion: "2025-06-18",
					capabilities: {},
					clientInfo: { name: "test", version: "0" },
				},
			},
			{ jsonrpc: "2.0", method: "notifications/initialized" },
			{ jsonrpc: "2.0", id: 2, method: "tools/list" },
			{
				jsonrpc: "2.0",
				id: 3,
				method: "tools/call",
				params: { name: "here", arguments: {} },
			},
			{
				jsonrpc: "2.0",
				id: 4,
				method: "tools/call",
				params: { name: "claim", arguments: { note: "mcp" } },
			},
			{
				jsonrpc: "2.0",
				id: 5,
				method: "tools/call",
				params: { name: "sync", arguments: {} },
			},
			{
				jsonrpc: "2.0",
				id: 6,
				method: "tools/call",
				params: {
					name: "lease_take",
					arguments: { workspace: "first", holder: "someone-else" },
				},
			},
			{
				jsonrpc: "2.0",
				id: 7,
				method: "tools/call",
				params: { name: "sync", arguments: { constructor: true } },
			},
			{
				jsonrpc: "2.0",
				id: 8,
				method: "tools/call",
				params: { name: "nope", arguments: {} },
			},
			{ jsonrpc: "2.0", id: 9, method: "nope" },
		];
		const child = execFile(
			process.execPath,
			[resolve("src/cli.ts"), "mcp", "--config", config],
			{
				cwd: f.second,
				encoding: "utf8",
				env: { ...process.env, CLONELANE_HOLDER: "claude-1" },
			},
		);
		const output = new Promise<string>((done, failed) => {
			let out = "";
			child.stdout?.on("data", (chunk) => {
				out += chunk;
			});
			child.on("error", failed);
			child.on("close", () => done(out));
		});
		child.stdin?.end(
			`${requests.map((item) => JSON.stringify(item)).join("\n")}\nnot json\n`,
		);
		const lines = (await output)
			.trim()
			.split("\n")
			.map((line) => JSON.parse(line));
		// Every line on stdout is a JSON-RPC response; the notification got none.
		assert.equal(lines.length, 10);
		const by = new Map(lines.map((line) => [line.id, line]));
		assert.equal(by.get(1).result.protocolVersion, "2025-06-18");
		assert.equal(by.get(1).result.serverInfo.name, "clonelane");
		const names = by
			.get(2)
			.result.tools.map((tool: { name: string }) => tool.name);
		assert.ok(
			["here", "claim", "sync", "env_sync", "lease_release"].every((name) =>
				names.includes(name),
			),
		);
		const body = (id: number) => JSON.parse(by.get(id).result.content[0].text);
		assert.equal(body(3).name, "second");
		// Holder from CLONELANE_HOLDER; group from the server's folder.
		assert.equal(body(4).holder, "claude-1");
		// The server's own workspace is free, so claim picks it over the first one listed.
		assert.equal(body(4).workspace, "second");
		assert.equal(body(4).note, "mcp");
		// sync previews by default: nothing moved, and nothing was fetched.
		assert.ok(Array.isArray(body(5)));
		assert.equal(await run(f.first, ["rev-parse", "HEAD"]), before);
		assert.equal(by.get(6).result.isError, true);
		// A server running as claude-1 cannot speak for another holder.
		assert.equal(body(6).error, "INVALID_ARGUMENT");
		assert.match(body(6).message, /claude-1/);
		assert.equal(body(7).error, "INVALID_ARGUMENT");
		assert.equal(by.get(8).error.code, -32602);
		assert.equal(by.get(9).error.code, -32601);
		assert.equal(by.get(null).error.code, -32700);
	});

	test("automatic sync: a group turned on is fetched and fast-forwarded by the worker, leases and changes respected", async (t) => {
		const f = await fixture(t);
		const config = join(f.root, "registry.json");
		await addWorkspace(config, { name: "first", path: f.first, group: "demo" });
		await addWorkspace(config, {
			name: "second",
			path: f.second,
			group: "demo",
		});
		await assert.rejects(setAutoSync(config, "nope", true), { code: "EMPTY" });
		const cli = (args: string[]) =>
			exec(
				process.execPath,
				[resolve("src/cli.ts"), ...args, "--config", config],
				{
					cwd: f.root,
					encoding: "utf8",
					env: { ...process.env, CLONELANE_HOLDER: "" },
				},
			);
		// Nothing on yet: one pass says so and fails.
		await assert.rejects(cli(["worker", "--once"]), /EMPTY/);
		const on = JSON.parse((await cli(["auto-sync", "on", "demo"])).stdout);
		assert.deepEqual(on.autoSync, ["demo"]);
		assert.equal(on.preview.length, 2);
		assert.deepEqual(JSON.parse((await cli(["auto-sync", "list"])).stdout), [
			"demo",
		]);
		const head = await f.publish();
		// second is leased by someone: the pass updates first only, and leaves second alone.
		const registry = await readRegistry(config);
		await takeLease(registry.workspaces[1] as typeof f.a, {
			holder: "agent-1",
		});
		const before = await run(f.second, ["rev-parse", "HEAD"]);
		const lines = (await cli(["worker", "--once"])).stdout
			.trim()
			.split("\n")
			.map((line) => JSON.parse(line));
		assert.equal(lines.length, 1);
		assert.equal(lines[0].group, "demo");
		assert.deepEqual(
			lines[0].results.map((item: { name: string; result: string }) => [
				item.name,
				item.result,
			]),
			[
				["first", "updated"],
				["second", "skipped"],
			],
		);
		assert.equal(await run(f.first, ["rev-parse", "HEAD"]), head);
		assert.equal(await run(f.second, ["rev-parse", "HEAD"]), before);
		// The library pass skips groups that are off, and turning off clears the setting.
		assert.deepEqual(
			await runAutoSync(await readRegistry(config), ["other"]),
			[],
		);
		assert.deepEqual(
			JSON.parse((await cli(["auto-sync", "off", "demo"])).stdout).autoSync,
			[],
		);
		assert.equal((await readRegistry(config)).autoSync, undefined);
		await assert.rejects(cli(["worker", "--every", "1"]), /USAGE/);
		// A group whose last workspace is gone drops out, so a new group of that name starts off.
		await setAutoSync(config, "demo", true);
		await removeWorkspace(config, "first");
		assert.deepEqual((await readRegistry(config)).autoSync, ["demo"]);
		await removeWorkspace(config, "second");
		assert.equal((await readRegistry(config)).autoSync, undefined);
	});

	test("rebase moves branches stacked under the current one with it, each backed up and restorable", async (t) => {
		const f = await fixture(t);
		const commit = async (file: string) => {
			await writeFile(join(f.first, file), `${file}\n`);
			await run(f.first, ["add", file]);
			await run(f.first, ["commit", "-m", file]);
		};
		await run(f.first, ["switch", "-c", "feat-a"]);
		await commit("a.txt");
		await run(f.first, ["switch", "-c", "feat-b"]);
		await commit("b.txt");
		const oldA = await run(f.first, ["rev-parse", "feat-a"]);
		const base = await f.publish();
		await fetchWorkspaces([f.a]);

		const [plan] = await syncWorkspaces([f.a], { dryRun: true, rebase: true });
		assert.equal(plan?.action, "rebase");
		assert.deepEqual(plan?.stack, ["feat-a"]);

		// The lower branch checked out in another worktree cannot move: the stack is skipped.
		const side = join(f.root, "side");
		await run(f.first, ["worktree", "add", side, "feat-a"]);
		const [busy] = await syncWorkspaces([f.a], { dryRun: true, rebase: true });
		assert.equal(busy?.reason, "stacked-branch-checked-out-elsewhere");
		await run(f.first, ["worktree", "remove", side]);

		const [result] = await syncWorkspaces([f.a], {
			rebase: true,
			fetch: false,
		});
		assert.equal(result?.result, "updated");
		const newA = await run(f.first, ["rev-parse", "feat-a"]);
		// Still stacked: feat-a now sits on the new base, and feat-b on feat-a.
		assert.notEqual(newA, oldA);
		assert.equal(await run(f.first, ["merge-base", "feat-a", "master"]), base);
		assert.equal(await run(f.first, ["merge-base", "feat-a", "feat-b"]), newA);
		assert.equal(
			await run(f.first, ["rev-list", "--count", "master..feat-b"]),
			"2",
		);

		// Each branch has its own journal entry; feat-a can be restored on its own.
		const operations = await listOperations(f.a);
		const moveA = operations.find((item) => item.ref === "refs/heads/feat-a");
		assert.equal(moveA?.state, "done");
		assert.equal(moveA?.tip, newA);
		assert.ok(
			operations.some(
				(item) => item.ref === "refs/heads/feat-b" && item.state === "done",
			),
		);
		const restored = await restoreOperation(f.a, moveA?.id ?? "");
		assert.equal(restored.result, "restored");
		assert.equal(await run(f.first, ["rev-parse", "feat-a"]), oldA);

		// A published branch in the stack is never rewritten.
		await run(f.first, ["switch", "feat-a"]);
		await run(f.first, ["push", "-u", "origin", "feat-a"]);
		await run(f.first, ["switch", "feat-b"]);
		await run(f.first, ["reset", "--hard", "feat-a"]);
		await commit("c.txt");
		await f.publish("more.txt");
		await fetchWorkspaces([f.a]);
		const [published] = await syncWorkspaces([f.a], {
			dryRun: true,
			rebase: true,
		});
		assert.equal(published?.reason, "published-or-merge-branch");
	});

	test("dry run does not fetch or create recovery refs; explicit fetch then fast-forward updates master", async (t) => {
		const f = await fixture(t);
		const before = await run(f.first, ["rev-parse", "HEAD"]);
		const expected = await f.publish();
		const cached = await syncWorkspaces([f.a], { dryRun: true });
		assert.equal(cached[0]?.action, "up-to-date");
		assert.equal(
			await run(f.first, ["rev-parse", "refs/remotes/origin/master"]),
			before,
		);
		await fetchWorkspaces([f.a, f.b]);
		const plan = await syncWorkspaces([f.a], { dryRun: true });
		assert.equal(plan[0]?.action, "fast-forward");
		assert.equal(await run(f.first, ["for-each-ref", "refs/clonelane/"]), "");
		const result = await syncWorkspaces([f.a, f.b]);
		assert.ok(result.every((item) => item.result === "updated"));
		assert.equal(await run(f.first, ["rev-parse", "HEAD"]), expected);
		assert.equal(
			await run(f.first, ["rev-parse", result[0]?.backup ?? ""]),
			before,
		);
	});

	test("dirty directories and divergent master preserve local work", async (t) => {
		const f = await fixture(t);
		await f.publish();
		await fetchWorkspaces([f.a, f.b]);
		await writeFile(join(f.first, "uncommitted.txt"), "keep me");
		await writeFile(join(f.second, "local.txt"), "local commit");
		await run(f.second, ["add", "local.txt"]);
		await run(f.second, ["commit", "-m", "local"]);
		const before = await run(f.second, ["rev-parse", "HEAD"]);
		const results = await syncWorkspaces([f.a, f.b]);
		assert.equal(results[0]?.reason, "uncommitted-changes");
		assert.equal(results[1]?.reason, "base-has-local-commits");
		assert.equal(await run(f.second, ["rev-parse", "HEAD"]), before);
		assert.equal(
			await readFile(join(f.first, "uncommitted.txt"), "utf8"),
			"keep me",
		);
	});

	test("explicit rebase keeps feature branch and puts its commit onto current master", async (t) => {
		const f = await fixture(t);
		await run(f.first, ["switch", "-c", "feature"]);
		await writeFile(join(f.first, "feature.txt"), "feature\n");
		await run(f.first, ["add", "feature.txt"]);
		await run(f.first, ["commit", "-m", "feature"]);
		const expected = await f.publish();
		await fetchWorkspaces([f.a]);
		assert.equal(
			(await syncWorkspaces([f.a]))[0]?.reason,
			"rebase-not-enabled",
		);
		const result = await syncWorkspaces([f.a], { rebase: true });
		assert.equal(result[0]?.result, "updated");
		assert.equal(await run(f.first, ["branch", "--show-current"]), "feature");
		assert.equal(await run(f.first, ["rev-parse", "HEAD^"]), expected);
		assert.equal(await run(f.first, ["rev-parse", "master"]), expected);
		assert.equal(
			await readFile(join(f.first, "feature.txt"), "utf8"),
			"feature\n",
		);
	});

	test("published feature branches are never automatically rewritten", async (t) => {
		const f = await fixture(t);
		await run(f.first, ["switch", "-c", "shared"]);
		await writeFile(join(f.first, "feature.txt"), "shared");
		await run(f.first, ["add", "."]);
		await run(f.first, ["commit", "-m", "shared"]);
		await run(f.first, ["push", "-u", "origin", "shared"]);
		const before = await run(f.first, ["rev-parse", "HEAD"]);
		await f.publish();
		await fetchWorkspaces([f.a]);
		assert.equal(
			(await syncWorkspaces([f.a], { dryRun: true, rebase: true }))[0]?.reason,
			"published-or-merge-branch",
		);
		assert.equal(
			(await syncWorkspaces([f.a], { rebase: true }))[0]?.reason,
			"published-or-merge-branch",
		);
		assert.equal(await run(f.first, ["rev-parse", "HEAD"]), before);
	});

	test("conflicting rebase restores original branch and clean checkout", async (t) => {
		const f = await fixture(t);
		await run(f.first, ["switch", "-c", "feature"]);
		await writeFile(join(f.first, "hello.txt"), "local conflict\n");
		await run(f.first, ["add", "."]);
		await run(f.first, ["commit", "-m", "conflict"]);
		const before = await run(f.first, ["rev-parse", "HEAD"]);
		await f.publish("hello.txt", "remote conflict\n");
		await fetchWorkspaces([f.a]);
		const result = await syncWorkspaces([f.a], { rebase: true });
		assert.equal(result[0]?.error, "rebase-failed-restored");
		assert.equal(await run(f.first, ["rev-parse", "HEAD"]), before);
		assert.equal(await run(f.first, ["status", "--porcelain"]), "");
		assert.equal((await inspectWorkspace(f.a)).operation, false);
	});

	test("existing Clonelane lock blocks mutations", async (t) => {
		const f = await fixture(t);
		const state = await inspectWorkspace(f.a);
		await writeFile(
			join(state.commonDir, "clonelane.lock"),
			"another instance",
		);
		assert.equal((await syncWorkspaces([f.a]))[0]?.error, "LOCKED");
	});

	test("cached status reads still notice new commits, changes and a changed remote", async (t) => {
		const f = await fixture(t);
		const published = await f.publish();
		await fetchWorkspaces([f.a]);
		const reuse = { reuseIdentity: true };
		// The first read learns where the config lives, the second caches, later ones reuse.
		await inspectWorkspace(f.a, reuse);
		await inspectWorkspace(f.a, reuse);
		const before = await inspectWorkspace(f.a, reuse);
		assert.equal(before.baseBehind, 1);
		assert.equal(before.dirty, false);
		// A second read uses the cached identity and counts; new local work still shows.
		await writeFile(join(f.first, "local.txt"), "local\n");
		await run(f.first, ["add", "local.txt"]);
		await run(f.first, ["commit", "-m", "local work"]);
		await writeFile(join(f.first, "hello.txt"), "edited\n");
		const after = await inspectWorkspace(f.a, reuse);
		assert.equal(after.baseAhead, 1);
		assert.equal(after.baseBehind, 1);
		assert.equal(after.dirty, true);
		assert.equal(after.subject, "local work");
		assert.equal(after.baseHead, published);
		assert.equal(after.branches.find((item) => item.current)?.name, "master");
		// Changing the remote rewrites .git/config, so the cached identity is dropped.
		await run(f.first, [
			"remote",
			"set-url",
			"origin",
			"https://example.invalid/other.git",
		]);
		await assert.rejects(inspectWorkspace(f.a, reuse), {
			code: "IDENTITY_CHANGED",
		});
		// A detached HEAD has no branch row and reads its subject separately.
		await run(f.first, ["remote", "set-url", "origin", f.remote]);
		await run(f.first, ["checkout", "--detach", "HEAD~1"]);
		const detached = await inspectWorkspace(f.a, reuse);
		assert.equal(detached.branch, null);
		assert.equal(detached.subject, "initial");
	});

	test("changed remote identity blocks operations without exposing its credentials", async (t) => {
		const f = await fixture(t);
		await run(f.first, [
			"remote",
			"set-url",
			"origin",
			"https://person:do-not-print@example.invalid/other.git",
		]);
		await assert.rejects(inspectWorkspace(f.a), (error) => {
			assert.ok(error instanceof Error);
			assert.ok(!error.message.includes("do-not-print"));
			return (error as { code?: string }).code === "IDENTITY_CHANGED";
		});
	});

	test("env plan is value-free; apply preserves target-only keys and multiline strings", async (t) => {
		const f = await fixture(t);
		const secret = "fixture-secret-never-print";
		await writeFile(
			join(f.first, ".env"),
			`API_TOKEN='${secret}'\nMULTI='line one\nline two'\nNOT_SHARED=source\n`,
		);
		await writeFile(join(f.second, ".env"), "PORT=6004\nNOT_SHARED=local\n");
		const options = { file: ".env", keys: ["API_TOKEN", "MULTI"] };
		const plan = await planEnv(f.a, f.b, options);
		assert.ok(!JSON.stringify(plan).includes(secret));
		assert.deepEqual(
			plan.changes.map((change) => change.state),
			["add", "add"],
		);
		await applyEnv(f.a, f.b, options);
		const actual = parseEnv(await readFile(join(f.second, ".env"), "utf8"));
		assert.equal(actual.API_TOKEN, secret);
		assert.equal(actual.MULTI, "line one\nline two");
		assert.equal(actual.PORT, "6004");
		assert.equal(actual.NOT_SHARED, "local");
	});

	test("env all-keys copies every source key, keeps target-only keys and still gates conflicts", async (t) => {
		const f = await fixture(t);
		await writeFile(
			join(f.first, ".env"),
			"TOKEN=new\nVITE_URL=https://example.invalid\nEXTRA=1\n",
		);
		await writeFile(join(f.second, ".env"), "TOKEN=old\nPORT=6004\n");
		const options = { file: ".env", keys: "all" as const };
		const plan = await planEnv(f.a, f.b, options);
		assert.deepEqual(
			plan.changes.map((change) => [change.key, change.state]),
			[
				["EXTRA", "add"],
				["TOKEN", "conflict"],
				["VITE_URL", "add"],
			],
		);
		await assert.rejects(applyEnv(f.a, f.b, options), { code: "ENV_CONFLICT" });
		await applyEnv(f.a, f.b, { ...options, overwrite: true });
		const actual = parseEnv(await readFile(join(f.second, ".env"), "utf8"));
		assert.deepEqual(
			{ ...actual },
			{
				EXTRA: "1",
				PORT: "6004",
				TOKEN: "new",
				VITE_URL: "https://example.invalid",
			},
		);
	});

	test("env conflicts require explicit overwrite and preview never writes", async (t) => {
		const f = await fixture(t);
		await writeFile(join(f.first, ".env"), "TOKEN=new\n");
		const original = "# important\nTOKEN=old\n";
		await writeFile(join(f.second, ".env"), original);
		const options = { file: ".env", keys: ["TOKEN"] };
		assert.equal(
			(await planEnv(f.a, f.b, options)).changes[0]?.state,
			"conflict",
		);
		assert.equal(await readFile(join(f.second, ".env"), "utf8"), original);
		await assert.rejects(applyEnv(f.a, f.b, options), { code: "ENV_CONFLICT" });
		assert.equal(await readFile(join(f.second, ".env"), "utf8"), original);
		await applyEnv(f.a, f.b, { ...options, overwrite: true });
		assert.equal(
			parseEnv(await readFile(join(f.second, ".env"), "utf8")).TOKEN,
			"new",
		);
	});

	test("env profile syncs a group, keeps each target's local keys and reports targets independently", async (t) => {
		const f = await fixture(t);
		const third = join(f.root, "third");
		await run(f.root, ["clone", f.remote, third]);
		const config = join(f.root, "registry.json");
		for (const [name, path] of [
			["first", f.first],
			["second", f.second],
			["third", third],
		] as const)
			await addWorkspace(config, { name, path, group: "demo" });
		await writeFile(
			join(f.first, ".env"),
			"TOKEN=shared\nPORT=3000\nVITE_URL=https://example.invalid\n",
		);
		await writeFile(join(f.second, ".env"), "PORT=3001\nLOCAL=1\n");
		await writeFile(join(third, ".env"), "TOKEN=other\n");
		const profile = await saveProfile(config, {
			name: "dev",
			source: "first",
			file: ".env",
			keys: "all",
			keep: { second: ["PORT"] },
		});
		assert.equal(JSON.stringify(profile).includes("shared"), false);

		const preview = await syncEnvProfile(await readRegistry(config), "dev", {
			dryRun: true,
		});
		assert.deepEqual(
			preview.map((item) => [
				item.target,
				item.plan?.changes.map((change) => `${change.key}:${change.state}`),
			]),
			[
				["second", ["PORT:kept", "TOKEN:add", "VITE_URL:add"]],
				["third", ["PORT:add", "TOKEN:conflict", "VITE_URL:add"]],
			],
		);
		assert.equal(
			await readFile(join(f.second, ".env"), "utf8"),
			"PORT=3001\nLOCAL=1\n",
		);

		// third conflicts: it is reported, second is still written.
		const applied = await syncEnvProfile(await readRegistry(config), "dev");
		assert.deepEqual(
			applied.map((item) => [item.target, item.error ?? "ok"]),
			[
				["second", "ok"],
				["third", "ENV_CONFLICT"],
			],
		);
		assert.deepEqual(
			{ ...parseEnv(await readFile(join(f.second, ".env"), "utf8")) },
			{
				LOCAL: "1",
				PORT: "3001",
				TOKEN: "shared",
				VITE_URL: "https://example.invalid",
			},
		);
		assert.equal(await readFile(join(third, ".env"), "utf8"), "TOKEN=other\n");
		await syncEnvProfile(await readRegistry(config), "dev", {
			overwrite: true,
		});
		assert.equal(
			parseEnv(await readFile(join(third, ".env"), "utf8")).TOKEN,
			"shared",
		);
	});

	test("env prune removes keys the source lacks, only with all keys and overwrite", async (t) => {
		const f = await fixture(t);
		await writeFile(join(f.first, ".env"), "TOKEN=shared\n");
		await writeFile(join(f.second, ".env"), "TOKEN=shared\nOLD=1\nPORT=3001\n");
		const options = {
			file: ".env",
			keys: "all" as const,
			prune: true,
			keep: ["PORT"],
		};
		assert.deepEqual(
			(await planEnv(f.a, f.b, options)).changes.map(
				(change) => `${change.key}:${change.state}`,
			),
			["TOKEN:same", "OLD:remove", "PORT:kept"],
		);
		await assert.rejects(applyEnv(f.a, f.b, options), { code: "ENV_CONFLICT" });
		await applyEnv(f.a, f.b, { ...options, overwrite: true });
		assert.deepEqual(
			{ ...parseEnv(await readFile(join(f.second, ".env"), "utf8")) },
			{ PORT: "3001", TOKEN: "shared" },
		);
		await assert.rejects(
			planEnv(f.a, f.b, { file: ".env", keys: ["TOKEN"], prune: true }),
			{ code: "ENV_KEYS" },
		);
		// An empty source would empty the target: refused, not planned as removals.
		await writeFile(join(f.first, ".env"), "");
		await assert.rejects(planEnv(f.a, f.b, { ...options, keep: [] }), {
			code: "ENV_SOURCE_EMPTY",
		});
	});

	test("profile targets limit the group, follow renames, and previews keep target order", async (t) => {
		const f = await fixture(t);
		const third = join(f.root, "third");
		await run(f.root, ["clone", f.remote, third]);
		const config = join(f.root, "registry.json");
		for (const [name, path] of [
			["first", f.first],
			["second", f.second],
			["third", third],
		] as const)
			await addWorkspace(config, { name, path, group: "demo" });
		const base = { name: "dev", source: "first", file: ".env" };
		// Only third: second is left alone, and a kept key must belong to a target.
		await assert.rejects(
			saveProfile(config, {
				...base,
				keys: "all",
				targets: ["third"],
				keep: { second: ["PORT"] },
			}),
			{ code: "PROFILE_KEEP" },
		);
		await assert.rejects(
			saveProfile(config, { ...base, keys: "all", targets: ["first"] }),
			{ code: "PROFILE_TARGET" },
		);
		await saveProfile(config, { ...base, keys: "all", targets: ["third"] });
		await writeFile(join(f.first, ".env"), "A=1\n");
		assert.deepEqual(
			(
				await syncEnvProfile(await readRegistry(config), "dev", {
					dryRun: true,
				})
			).map((item) => item.target),
			["third"],
		);
		// Targets follow a rename and are dropped when they leave the group; an emptied
		// list fails instead of widening to the whole group.
		await updateWorkspace(config, "third", { name: "three" });
		assert.deepEqual((await readRegistry(config)).profiles?.[0]?.targets, [
			"three",
		]);
		await updateWorkspace(config, "three", { group: "elsewhere" });
		await assert.rejects(
			syncEnvProfile(await readRegistry(config), "dev", { dryRun: true }),
			{ code: "EMPTY" },
		);
		await updateWorkspace(config, "three", { name: "third", group: "demo" });
		await rm(join(f.first, ".env"));
		await saveProfile(config, { ...base, keys: "all", prune: true });
		// first has no .env: every target fails alike, in registry order.
		await writeFile(join(f.second, ".env"), "A=1\n");
		const preview = await syncEnvProfile(await readRegistry(config), "dev", {
			dryRun: true,
		});
		assert.deepEqual(
			preview.map((item) => [item.target, item.error]),
			[
				["second", "ENV_SOURCE_MISSING"],
				["third", "ENV_SOURCE_MISSING"],
			],
		);
		await writeFile(join(f.first, ".env"), "A=1\n");
		await writeFile(join(third, ".env"), "A=1\nB=2\n");
		assert.deepEqual(
			(
				await syncEnvProfile(await readRegistry(config), "dev", {
					dryRun: true,
				})
			).map((item) => [
				item.target,
				item.plan?.changes.map((change) => `${change.key}:${change.state}`),
			]),
			[
				["second", ["A:same"]],
				["third", ["A:same", "B:remove"]],
			],
		);
	});

	test("env profiles validate on save, follow renames and protect their source", async (t) => {
		const f = await fixture(t);
		const config = join(f.root, "registry.json");
		await addWorkspace(config, { name: "first", path: f.first, group: "demo" });
		await addWorkspace(config, {
			name: "second",
			path: f.second,
			group: "demo",
		});
		const base = { name: "dev", source: "first", file: ".env" };
		await assert.rejects(saveProfile(config, { ...base, keys: ["VITE_URL"] }), {
			code: "PUBLIC_VARIABLE",
		});
		await assert.rejects(
			saveProfile(config, { ...base, keys: "all", keep: { first: ["PORT"] } }),
			{ code: "PROFILE_TARGET" },
		);
		await assert.rejects(
			saveProfile(config, { ...base, keys: "all", keep: { second: ["1BAD"] } }),
			{ code: "ENV_KEYS" },
		);
		await assert.rejects(
			saveProfile(config, { ...base, file: "../.env", keys: "all" }),
			{
				code: "ENV_FILE",
			},
		);
		await saveProfile(config, {
			...base,
			keys: ["TOKEN", "PORT"],
			publicKeys: [],
			keep: { second: ["PORT"] },
		});
		await updateWorkspace(config, "second", { name: "two" });
		await updateWorkspace(config, "first", { name: "one" });
		assert.deepEqual((await readRegistry(config)).profiles, [
			{
				name: "dev",
				source: "one",
				file: ".env",
				keys: ["TOKEN", "PORT"],
				keep: { two: ["PORT"] },
			},
		]);
		await assert.rejects(removeWorkspace(config, "one"), {
			code: "PROFILE_SOURCE",
		});
		await assert.rejects(
			updateWorkspace(config, "one", { group: "elsewhere" }),
			{
				code: "PROFILE_SOURCE",
			},
		);
		await assert.rejects(
			saveProfile(config, {
				...base,
				source: "one",
				keys: ["TOKEN"],
				keep: { two: ["PORT"] },
			}),
			{ code: "ENV_KEYS" },
		);
		// Leaving the source's group drops the kept keys; coming back does not restore them.
		await updateWorkspace(config, "two", { group: "elsewhere" });
		assert.equal(
			(await readRegistry(config)).profiles?.[0]?.keep?.two,
			undefined,
		);
		await updateWorkspace(config, "two", { group: "demo" });
		await saveProfile(config, {
			...base,
			source: "one",
			keys: ["TOKEN", "PORT"],
			keep: { two: ["PORT"] },
		});
		await removeWorkspace(config, "two");
		assert.equal(
			(await readRegistry(config)).profiles?.[0]?.keep?.two,
			undefined,
		);
		await removeProfile(config, "dev");
		await removeWorkspace(config, "one");
		await writeFile(
			config,
			JSON.stringify({ version: 1, workspaces: [], profiles: [{ name: 1 }] }),
		);
		await assert.rejects(readRegistry(config), { code: "CONFIG" });
		const twice = { name: "dev", source: "x", file: ".env", keys: "all" };
		await writeFile(
			config,
			JSON.stringify({ version: 1, workspaces: [], profiles: [twice, twice] }),
		);
		await assert.rejects(readRegistry(config), { code: "CONFIG" });
	});

	test("env rejects tracked files, missing keys, path traversal and public variables without acknowledgement", async (t) => {
		const f = await fixture(t);
		await writeFile(
			join(f.first, ".env"),
			"TOKEN=secret\nVITE_URL=https://example.invalid\n",
		);
		await assert.rejects(
			planEnv(f.a, f.b, { file: "../.env", keys: ["TOKEN"] }),
			{ code: "ENV_FILE" },
		);
		await assert.rejects(
			planEnv(f.a, f.b, { file: ".env", keys: ["MISSING"] }),
			{
				code: "ENV_KEY_MISSING",
			},
		);
		await assert.rejects(
			planEnv(f.a, f.b, { file: ".env", keys: ["VITE_URL"] }),
			{ code: "PUBLIC_VARIABLE" },
		);
		await planEnv(f.a, f.b, {
			file: ".env",
			keys: ["VITE_URL"],
			publicKeys: ["VITE_URL"],
		});
		await run(f.first, ["add", "--force", ".env"]);
		await assert.rejects(planEnv(f.a, f.b, { file: ".env", keys: ["TOKEN"] }), {
			code: "TRACKED_ENV",
		});
	});

	test("env rejects symlink targets and leaves external file untouched", async (t) => {
		const f = await fixture(t);
		await writeFile(join(f.first, ".env"), "TOKEN=secret\n");
		const outside = join(f.root, "outside.env");
		await writeFile(outside, "TOKEN=outside\n");
		try {
			await symlink(outside, join(f.second, ".env"), "file");
		} catch (error) {
			if (
				["EPERM", "EACCES"].includes(
					(error as NodeJS.ErrnoException).code ?? "",
				)
			) {
				t.skip("OS does not permit file symlinks");
				return;
			}
			throw error;
		}
		await assert.rejects(
			applyEnv(f.a, f.b, { file: ".env", keys: ["TOKEN"], overwrite: true }),
			{ code: "UNSAFE_FILE" },
		);
		assert.equal(await readFile(outside, "utf8"), "TOKEN=outside\n");
	});

	test("Git failures are explained by kind and never echo Git's output", () => {
		const cases: [string, string][] = [
			[
				"fatal: Authentication failed for 'https://user:SECRET@host/r.git/'",
				"GIT_AUTH",
			],
			[
				"ssh: Could not resolve hostname host: Name or service not known",
				"GIT_NETWORK",
			],
			["fatal: couldn't find remote ref refs/heads/main", "GIT_REMOTE_REF"],
			[
				"fatal: 'SECRET/path' does not appear to be a git repository",
				"GIT_REMOTE_MISSING",
			],
			[
				"fatal: Unable to create 'C:/w/.git/index.lock': File exists.",
				"GIT_LOCKED",
			],
			[
				"error: Your local changes to the following files would be overwritten by merge",
				"GIT_LOCAL_CHANGES",
			],
			["CONFLICT (content): Merge conflict in a.txt", "GIT_CONFLICT"],
			["error: could not apply 1a2b3c4... feature", "GIT_CONFLICT"],
			["Could not apply 1a2b3c4... feature", "GIT_CONFLICT"],
			[
				"remote: Access denied\nfatal: unable to access the repository",
				"GIT_AUTH",
			],
			["ERROR: Access denied", "GIT_AUTH"],
			// Not conflicts or credential problems, despite the words they contain.
			[
				"error: pathspec 'conflict-notes' did not match any file(s)",
				"GIT_FAILED",
			],
			["error: unable to unlink old 'a.txt': Access is denied.", "GIT_FAILED"],
			["something unexpected", "GIT_FAILED"],
		];
		for (const [output, code] of cases) {
			const [actual, message] = describeGitFailure(output);
			assert.equal(actual, code, output);
			assert.ok(
				!message.includes("SECRET"),
				"message must not echo Git output",
			);
		}
		// stdout (file contents, subjects) only counts for Git's conflict report.
		assert.equal(
			describeGitFailure(
				"fatal: bad object",
				"subject: authentication failed",
			)[0],
			"GIT_FAILED",
		);
		assert.equal(
			describeGitFailure("", "Automatic merge failed; fix conflicts")[0],
			"GIT_CONFLICT",
		);
	});

	test("a real merge conflict is classified from Git's stdout", async (t) => {
		const f = await fixture(t);
		await run(f.first, ["switch", "-c", "other"]);
		await writeFile(join(f.first, "hello.txt"), "other\n");
		await run(f.first, ["commit", "-am", "other side"]);
		await run(f.first, ["switch", "master"]);
		await writeFile(join(f.first, "hello.txt"), "master\n");
		await run(f.first, ["commit", "-am", "master side"]);
		// git prints "CONFLICT (content): ..." on stdout, not stderr.
		await assert.rejects(git(f.first, ["merge", "--no-edit", "other"]), {
			code: "GIT_CONFLICT",
		});
		await run(f.first, ["merge", "--abort"]);
	});

	test("one failing fetch or lock is reported per workspace without stopping the others", async (t) => {
		const f = await fixture(t);
		const missingBase = await registerWorkspace({
			name: "missing-base",
			path: f.second,
			group: "other",
			base: "no-such-branch",
		});
		await f.publish();
		const fetched = await fetchWorkspaces([f.a, missingBase]);
		assert.deepEqual(
			fetched.map((item) => [item.name, item.result, item.error ?? ""]),
			[
				["first", "fetched", ""],
				["missing-base", "failed", "GIT_REMOTE_REF"],
			],
		);
		assert.ok(fetched[1]?.message);
		const [ok, skipped] = await syncWorkspaces([f.a, missingBase], {
			fetch: true,
		});
		assert.equal(ok?.result, "updated");
		assert.equal(skipped?.reason, "fetch-failed");
		assert.equal(skipped?.error, "GIT_REMOTE_REF");
		// Results pair by position: a repeated name (a hand-edited registry) never mixes them.
		const twin = { ...missingBase, name: "first" };
		const paired = await fetchWorkspaces([f.a, twin]);
		assert.deepEqual(
			paired.map((item) => item.result),
			["fetched", "failed"],
		);
		// Output past the read limit is named as such, not as a timeout.
		await writeFile(join(f.first, "big.bin"), "x".repeat(9 * 1024 * 1024));
		try {
			const blob = await run(f.first, ["hash-object", "-w", "big.bin"]);
			await assert.rejects(git(f.first, ["cat-file", "-p", blob]), {
				code: "GIT_OUTPUT_TOO_LARGE",
			});
		} finally {
			await rm(join(f.first, "big.bin"), { force: true });
		}
		// A stale lock from another Git process is named, not just "Git failed".
		await f.publish("lock.txt");
		await fetchWorkspaces([f.a]);
		await writeFile(join(f.first, ".git", "index.lock"), "");
		const [locked] = await syncWorkspaces([f.a]);
		assert.equal(locked?.result, "failed");
		assert.equal(locked?.error, "GIT_LOCKED");
		assert.match(locked?.message ?? "", /lock/);
	});

	test("clones of one repository fetch from the network once and copy from each other", async (t) => {
		const f = await fixture(t);
		const published = await f.publish();
		const fetched = await fetchWorkspaces([f.a, f.b]);
		assert.deepEqual(
			fetched.map((item) => [item.name, item.result, item.source]),
			[
				["first", "fetched", undefined],
				["second", "fetched", "first"],
			],
		);
		assert.equal(
			await run(f.second, ["rev-parse", "refs/remotes/origin/master"]),
			published,
		);
		// When the first clone's fetch fails, the others still fetch from the network.
		const broken = await registerWorkspace({
			name: "broken",
			path: f.first,
			group: "demo",
			base: "no-such-branch",
		});
		const next = await f.publish("next.txt");
		const fallback = await fetchWorkspaces([broken, f.b]);
		assert.equal(fallback[0]?.result, "failed");
		assert.equal(fallback[1]?.result, "fetched");
		assert.equal(fallback[1]?.source, undefined);
		assert.equal(
			await run(f.second, ["rev-parse", "refs/remotes/origin/master"]),
			next,
		);
	});

	test("sync journals each move with a backup, and restore undoes it only once", async (t) => {
		const f = await fixture(t);
		const before = await run(f.first, ["rev-parse", "HEAD"]);
		const after = await f.publish();
		assert.equal(
			(await syncWorkspaces([f.a], { fetch: true }))[0]?.result,
			"updated",
		);
		const [move] = await listOperations(f.a);
		assert.equal(move?.kind, "fast-forward");
		assert.equal(move?.state, "done");
		assert.equal(move?.from, before);
		assert.equal(move?.tip, after);
		assert.equal(await run(f.first, ["rev-parse", move?.backup ?? ""]), before);
		assert.equal((await inspectWorkspace(f.a)).interrupted, 0);

		const id = move?.id ?? "";
		const plan = await restoreOperation(f.a, id, { dryRun: true });
		assert.equal(plan.result, "planned");
		assert.equal(await run(f.first, ["rev-parse", "HEAD"]), after);
		const restored = await restoreOperation(f.a, id);
		assert.equal(restored.result, "restored");
		assert.equal(await run(f.first, ["rev-parse", "HEAD"]), before);
		assert.equal(
			await run(f.first, ["rev-parse", restored.backup ?? ""]),
			after,
		);
		assert.equal((await restoreOperation(f.a, id)).reason, "already-restored");
		// The restore is journaled too, so it can itself be undone.
		const [undo] = await listOperations(f.a);
		assert.equal(undo?.kind, "restore");
		assert.equal(
			(await restoreOperation(f.a, undo?.id ?? "")).result,
			"restored",
		);
		assert.equal(await run(f.first, ["rev-parse", "HEAD"]), after);
	});

	test("a locked ref move blocks concurrent commits and checks the old tip", async (t) => {
		const f = await fixture(t);
		const first = await run(f.first, ["rev-parse", "HEAD"]);
		await run(f.first, ["commit", "--allow-empty", "-m", "second"]);
		const second = await run(f.first, ["rev-parse", "HEAD"]);
		const ref = "refs/heads/master";
		// A stale expected tip moves nothing and never runs the callback.
		let ran = false;
		await assert.rejects(
			moveRefLocked(
				f.first,
				ref,
				{ oldTip: first, newTip: second },
				async () => {
					ran = true;
				},
			),
		);
		assert.equal(ran, false);
		assert.equal(await run(f.first, ["rev-parse", ref]), second);
		// While the move holds the ref lock, another tool's commit fails instead of being lost.
		await moveRefLocked(
			f.first,
			ref,
			{ oldTip: second, newTip: first },
			async () => {
				await assert.rejects(
					run(f.first, ["commit", "--allow-empty", "-m", "racing"]),
				);
			},
		);
		assert.equal(await run(f.first, ["rev-parse", ref]), first);
		// A failing callback leaves the ref where it was.
		await assert.rejects(
			moveRefLocked(
				f.first,
				ref,
				{ oldTip: first, newTip: second },
				async () => {
					throw new Error("stop");
				},
			),
			/stop/,
		);
		assert.equal(await run(f.first, ["rev-parse", ref]), first);
	});

	test("restore refuses a branch that moved since or a workspace with local changes", async (t) => {
		const f = await fixture(t);
		await f.publish();
		await syncWorkspaces([f.a], { fetch: true });
		const [move] = await listOperations(f.a);
		const id = move?.id ?? "";
		await writeFile(join(f.first, "hello.txt"), "edited\n");
		assert.equal((await restoreOperation(f.a, id)).reason, "workspace-busy");
		await run(f.first, ["commit", "-am", "local work"]);
		const head = await run(f.first, ["rev-parse", "HEAD"]);
		assert.equal((await restoreOperation(f.a, id)).reason, "moved-since");
		assert.equal(await run(f.first, ["rev-parse", "HEAD"]), head);
		await assert.rejects(
			restoreOperation(f.b, id),
			/WRONG_WORKSPACE|No recorded/,
		);
	});

	test("restore returns a rebased feature branch to its pre-rebase commit", async (t) => {
		const f = await fixture(t);
		await run(f.first, ["switch", "-c", "feature"]);
		await writeFile(join(f.first, "feature.txt"), "feature\n");
		await run(f.first, ["add", "feature.txt"]);
		await run(f.first, ["commit", "-m", "feature"]);
		const before = await run(f.first, ["rev-parse", "HEAD"]);
		await f.publish();
		await syncWorkspaces([f.a], { rebase: true, fetch: true });
		const move = (await listOperations(f.a)).find(
			(item) => item.kind === "rebase",
		);
		assert.equal(move?.tip, await run(f.first, ["rev-parse", "HEAD"]));
		assert.equal(
			(await restoreOperation(f.a, move?.id ?? "")).result,
			"restored",
		);
		assert.equal(await run(f.first, ["rev-parse", "HEAD"]), before);
		assert.equal(await run(f.first, ["branch", "--show-current"]), "feature");
	});

	test("a move that started but never finished reads as interrupted", async (t) => {
		const f = await fixture(t);
		const state = await inspectWorkspace(f.a);
		const head = state.head;
		await run(f.first, ["update-ref", "refs/clonelane/backups/manual", head]);
		const id = await begin(state.commonDir, {
			workspace: "first",
			path: f.a.path,
			kind: "fast-forward",
			ref: "refs/heads/master",
			from: head,
			to: head,
			backup: "refs/clonelane/backups/manual",
		});
		assert.equal((await inspectWorkspace(f.a)).interrupted, 1);
		assert.equal((await inspectWorkspace(f.b)).interrupted, 0);
		assert.equal((await listOperations(f.a))[0]?.state, "interrupted");
		// While a Clonelane lock is held the entry is still running, not interrupted.
		await writeFile(join(state.commonDir, "clonelane.lock"), "");
		assert.equal((await listOperations(f.a))[0]?.state, "started");
		assert.equal(
			(await restoreOperation(f.a, id, { dryRun: true })).reason,
			"in-progress",
		);
		// A torn trailing line from a hard stop is ignored.
		await writeFile(
			join(state.commonDir, "clonelane-journal.jsonl"),
			'{"id":"broken',
			{ flag: "a" },
		);
		assert.equal((await listOperations(f.a)).length, 1);
		// A lock left by a killed process (dead pid) does not hide the interruption.
		await writeFile(join(state.commonDir, "clonelane.lock"), "2147483646\n");
		assert.equal((await listOperations(f.a))[0]?.state, "interrupted");
		// A damaged started record is skipped rather than breaking readers.
		await writeFile(
			join(state.commonDir, "clonelane-journal.jsonl"),
			'\n{"id":"0badf00d","state":"started"}\n',
			{ flag: "a" },
		);
		assert.equal((await listOperations(f.a)).length, 1);
		// A later move of the same branch clears the warning.
		await rm(join(state.commonDir, "clonelane.lock"));
		await f.publish();
		await syncWorkspaces([f.a], { fetch: true });
		assert.equal((await inspectWorkspace(f.a)).interrupted, 0);
	});

	test("CLI history lists moves and restore --dry-run plans without moving", async (t) => {
		const f = await fixture(t);
		const config = join(f.root, "registry.json");
		await addWorkspace(config, { name: "a", path: f.first, group: "demo" });
		const after = await f.publish();
		await syncWorkspaces(
			[(await readRegistry(config)).workspaces[0] as typeof f.a],
			{ fetch: true },
		);
		const cli = (args: string[]) =>
			exec(process.execPath, ["src/cli.ts", ...args, "--config", config], {
				cwd: resolve("."),
				encoding: "utf8",
			});
		const history = JSON.parse((await cli(["history", "--json"])).stdout) as {
			id: string;
			kind: string;
		}[];
		assert.equal(history[0]?.kind, "fast-forward");
		const plan = JSON.parse(
			(await cli(["restore", history[0]?.id ?? "", "--dry-run"])).stdout,
		) as { result: string };
		assert.equal(plan.result, "planned");
		assert.equal(await run(f.first, ["rev-parse", "HEAD"]), after);
		await assert.rejects(cli(["restore", "0123456789abcdef"]), /NOT_FOUND/);
	});

	test("CLI status reports a missing folder and still shows the other workspaces", async (t) => {
		const f = await fixture(t);
		const config = join(f.root, "registry.json");
		await addWorkspace(config, { name: "a", path: f.first, group: "demo" });
		await addWorkspace(config, { name: "b", path: f.second, group: "demo" });
		await rm(f.second, { recursive: true, force: true });
		const outcome = await exec(
			process.execPath,
			["src/cli.ts", "status", "--json", "--config", config],
			{ cwd: resolve("."), encoding: "utf8" },
		).then(
			(result) => ({ code: 0, stdout: result.stdout }),
			(error: { code: number; stdout: string }) => error,
		);
		assert.equal(outcome.code, 1);
		const states = JSON.parse(outcome.stdout) as {
			workspace: { name: string };
			branch?: string;
			error?: { code: string };
		}[];
		assert.equal(states[0]?.branch, "master");
		assert.equal(states[1]?.error?.code, "GIT_NO_FOLDER");
	});

	test("CLI rejects env apply --dry-run rather than silently writing", async (t) => {
		const f = await fixture(t);
		try {
			await exec(
				process.execPath,
				[
					"src/cli.ts",
					"env",
					"apply",
					"--dry-run",
					"--config",
					join(f.root, "absent.json"),
				],
				{ cwd: resolve("."), encoding: "utf8" },
			);
			assert.fail("CLI should reject the unsupported flag");
		} catch (error) {
			assert.match((error as { stderr: string }).stderr, /USAGE/);
		}
	});

	test("a single non-origin remote is used by default; a missing remote is named", async (t) => {
		const { first } = await fixture(t);
		await run(first, ["remote", "rename", "origin", "upstream"]);
		const workspace = await registerWorkspace({
			name: "renamed",
			path: first,
			group: "demo",
		});
		assert.equal(workspace.remote, "upstream");
		await assert.rejects(
			registerWorkspace({
				name: "renamed",
				path: first,
				group: "demo",
				remote: "origin",
			}),
			{
				code: "REMOTE_MISSING",
				message: 'Remote "origin" does not exist. Available remotes: upstream.',
			},
		);
	});

	test("registered workspace path is canonical", async (t) => {
		const f = await fixture(t);
		assert.equal(f.a.path, await realpath(f.first));
	});

	test("a linked worktree cannot move a base checked out by its owner", async (t) => {
		const f = await fixture(t);
		const path = join(f.root, "linked");
		await run(f.first, ["worktree", "add", "-b", "feature", path]);
		const linked = await registerWorkspace({
			name: "linked",
			path,
			group: "demo",
		});
		const original = await run(f.first, ["rev-parse", "HEAD"]);
		await f.publish();
		await fetchWorkspaces([linked]);
		const result = await syncWorkspaces([linked]);
		assert.equal(
			result[0]?.baseUpdate?.reason,
			"base-checked-out-in-another-worktree",
		);
		assert.equal(await run(f.first, ["rev-parse", "HEAD"]), original);
	});

	test("env rejects hard-linked target files", async (t) => {
		const f = await fixture(t);
		await writeFile(join(f.first, ".env"), "TOKEN=source\n");
		const outside = join(f.root, "external.env");
		await writeFile(outside, "TOKEN=outside\n");
		await link(outside, join(f.second, ".env"));
		await assert.rejects(
			applyEnv(f.a, f.b, { file: ".env", keys: ["TOKEN"], overwrite: true }),
			{ code: "UNSAFE_FILE" },
		);
		assert.equal(await readFile(outside, "utf8"), "TOKEN=outside\n");
	});
});
