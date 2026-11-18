import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { test } from "node:test";

// Non-literal specifier: app/ is plain JS outside the TypeScript project.
const { reasons } = await import("../app/labels.js" as string);

test("every sync reason the core can report has a label", async () => {
	const dir = new URL("../src/", import.meta.url);
	const source = (
		await Promise.all(
			(
				await readdir(dir)
			)
				.filter((name) => name.endsWith(".ts"))
				.map((name) => readFile(new URL(name, dir), "utf8")),
		)
	).join("\n");
	const used = [...source.matchAll(/(?:reason: |skip\()"([a-z-]+)"/g)].map(
		(match) => match[1] as string,
	);
	assert.ok(used.length > 15);
	for (const reason of used)
		assert.ok(Object.hasOwn(reasons, reason), `missing label: ${reason}`);
});
