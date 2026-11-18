import assert from "node:assert/strict";
import { test } from "node:test";

// Non-literal specifier: app/ is plain JS outside the TypeScript project.
const { layout } = (await import("../app/graph.js" as string)) as {
	layout: (commits: { hash: string; parents: string[] }[]) => {
		cols: number[];
		segments: { x1: number; r1: number; x2: number; r2: number }[];
		width: number;
	};
};

const c = (hash: string, ...parents: string[]) => ({ hash, parents });

test("graph lanes: a branch forks into its own column and bends back at the merge base", () => {
	// M merges F into main; both sides start from A.
	const { cols, segments, width } = layout([
		c("M", "B", "F"),
		c("F", "A"),
		c("B", "A"),
		c("A"),
	]);
	assert.deepEqual(cols, [0, 1, 0, 0]);
	assert.equal(width, 2);
	// The merge opens lane 1 from M's node.
	assert.ok(segments.some((s) => s.r1 === 0 && s.x1 === 0 && s.x2 === 1));
	// Lane 0 passes F's row on its way to B.
	assert.ok(segments.some((s) => s.r1 === 1 && s.x1 === 0 && s.x2 === 0));
	// Lane 1 bends into A, where both lines meet.
	assert.ok(segments.some((s) => s.r1 === 2 && s.x1 === 1 && s.x2 === 0));
});

test("graph lanes: unrelated tips get separate columns and history past the limit runs off", () => {
	const { cols, segments } = layout([c("X", "P"), c("Y", "Q")]);
	assert.deepEqual(cols, [0, 1]);
	const last = segments.filter((s) => s.r1 === 1);
	assert.ok(last.every((s) => s.r2 === 1.5));
	assert.equal(last.length, 2);
});
