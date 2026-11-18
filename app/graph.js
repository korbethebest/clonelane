// Lane layout for commits in date order (newest first), the way Git Graph, Fork and
// GitKraken draw history: each open line of descent keeps one column until it ends.
// Returns each commit's column and the segments between consecutive rows.
export function layout(commits) {
	const lanes = []; // lanes[i] = hash the line in column i is heading for
	const free = () => {
		const i = lanes.indexOf(null);
		return i === -1 ? lanes.length : i;
	};
	const rows = commits.map((commit) => {
		let col = lanes.indexOf(commit.hash);
		if (col === -1) col = free();
		// Other lines heading for this commit end here (the previous row bent them in).
		for (let i = 0; i < lanes.length; i++)
			if (i !== col && lanes[i] === commit.hash) lanes[i] = null;
		const passing = lanes.map((hash, i) => i !== col && hash != null);
		const edges = [];
		lanes[col] = commit.parents[0] ?? null;
		if (lanes[col] != null) edges.push({ from: col, lane: col });
		for (const parent of commit.parents.slice(1)) {
			let lane = lanes.indexOf(parent);
			if (lane === -1) {
				lane = free();
				lanes[lane] = parent;
			}
			edges.push({ from: col, lane });
		}
		// Lines passing by keep their column.
		passing.forEach((open, i) => {
			if (open) edges.push({ from: i, lane: i });
		});
		while (lanes.length > 0 && lanes.at(-1) == null) lanes.pop();
		return {
			col,
			edges: edges.map((edge) => ({ ...edge, hash: lanes[edge.lane] })),
		};
	});

	const segments = [];
	rows.forEach((row, r) => {
		const next = commits[r + 1];
		for (const edge of row.edges) {
			const ends = next?.hash === edge.hash;
			segments.push({
				x1: edge.from,
				r1: r,
				x2: ends ? rows[r + 1].col : edge.lane,
				// The last row's open lines run off the bottom edge.
				r2: next ? r + 1 : r + 0.5,
				lane: edge.lane,
			});
		}
	});
	const width = Math.max(
		1,
		...rows.map((row) => row.col + 1),
		...segments.map((s) => Math.max(s.x1, s.x2) + 1),
	);
	return { cols: rows.map((row) => row.col), segments, width };
}
