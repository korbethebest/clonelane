import { layout } from "./graph.js";
import { reasons } from "./labels.js";

const $ = (selector) => document.querySelector(selector);
const plural = (count, one, many = `${one}s`) =>
	`${count} ${count === 1 ? one : many}`;
const reasonText = (reason) => reasons[reason] ?? reason;
const relative = new Intl.RelativeTimeFormat("en", { numeric: "auto" });

function ago(ms) {
	const seconds = Math.round((ms - Date.now()) / 1000);
	for (const [unit, size] of [
		["day", 86400],
		["hour", 3600],
		["minute", 60],
	])
		if (Math.abs(seconds) >= size)
			return relative.format(Math.round(seconds / size), unit);
	return "just now";
}

// Build DOM with text nodes only: branch names, paths and messages are never parsed as HTML.
function el(tag, { dataset = {}, ...props } = {}, ...children) {
	const node = Object.assign(document.createElement(tag), props);
	Object.assign(node.dataset, dataset);
	node.append(
		...children
			.flat(Infinity)
			.filter((child) => child != null && child !== false)
			.map((child) => (child instanceof Node ? child : String(child))),
	);
	return node;
}

function table(headers, rows, className = "") {
	return el(
		"table",
		{ className },
		el("thead", {}, el("tr", {}, ...headers.map((h) => el("th", {}, h)))),
		el(
			"tbody",
			{},
			rows.map((cells) =>
				el("tr", {}, ...cells.map((cell) => el("td", {}, cell ?? "—"))),
			),
		),
	);
}

let registry = { workspaces: [] };
let loaded = false; // Avoid an "empty" flash before the registry is read.
const view = { statuses: null, sync: null, env: null, loading: 0 };
let syncPreview = null;
let envPreview = null;

function say(text = "", busy = false) {
	const status = $("#message");
	status.classList.toggle("busy", busy);
	status.replaceChildren(
		...(busy ? [el("span", { className: "spinner", ariaHidden: "true" })] : []),
		// No empty text node, so the status bar can hide itself when idle.
		...(text ? [text] : []),
	);
}

function showError(id, error) {
	const node = $(`#${id}`);
	node.hidden = !error;
	node.textContent = error?.message ?? "";
	node.title = error?.code ?? "";
}

const controls = ["#refresh", "#fetch", "#group"];

// Locks the UI while any action runs (a History panel can still start one, so count
// them); errors appear next to the control that caused them.
let pending = 0;
async function call(name, input, { busy, alert = "footer-alert" } = {}) {
	pending++;
	const focused = document.activeElement;
	$("#ui").disabled = true;
	for (const id of controls) $(id).disabled = true;
	showError(alert, null);
	showError("footer-alert", null);
	if (busy) say(busy, true);
	try {
		const response = await window.clonelane.call(name, input);
		if (busy) say();
		if (!response.ok) {
			showError(alert, { message: response.message, code: response.error });
			return null;
		}
		return response.data;
	} finally {
		pending--;
		if (pending === 0) {
			$("#ui").disabled = false;
			for (const id of controls) $(id).disabled = false;
			// Disabling dropped keyboard focus; give it back if its control survived.
			if (focused?.isConnected && document.activeElement === document.body)
				focused.focus();
		}
		gate();
	}
}

const group = () => $("#group").value;
const syncKey = () => JSON.stringify([group(), $("#rebase").checked]);
const envInput = () => Object.fromEntries(new FormData($("#env-form")));
const envKey = () => JSON.stringify(envInput());
const workspaceNamed = (name) =>
	registry.workspaces.find((item) => item.name === name);
const baseRef = (workspace) =>
	workspace ? `${workspace.remote}/${workspace.base}` : "base";
const capitalize = (text) => `${text[0]?.toUpperCase() ?? ""}${text.slice(1)}`;

// Sort a sync result by what the user has to decide about.
function outcome(item, applied) {
	if (item.result === "failed") return "failed";
	const changes = applied
		? item.result === "updated" || item.baseUpdate?.result === "updated"
		: ["fast-forward", "rebase"].includes(item.action) ||
			item.baseUpdate?.action === "fast-forward";
	if (changes) return applied ? "updated" : "update";
	if (item.action === "skip" && item.reason !== "rebase-not-enabled")
		return "blocked";
	return "none";
}

// Apply buttons always say why they are (or are not) available.
function gate() {
	const sync = view.sync;
	if (!sync || sync.applied || syncPreview !== syncKey()) {
		$("#sync-apply").disabled = true;
		$("#sync-reason").textContent = sync?.applied
			? ""
			: "Preview first to see what will change.";
	} else {
		const count = sync.results.filter(
			(item) => outcome(item, false) === "update",
		).length;
		$("#sync-apply").disabled = count === 0;
		const blocked = sync.results.some(
			(item) => outcome(item, false) === "blocked",
		);
		// Preview reads cached remote refs; it never fetches.
		$("#sync-reason").textContent =
			count > 0
				? `Updates ${plural(count, "workspace")}.`
				: blocked
					? "Nothing can be updated yet. Resolve what needs attention, then preview again."
					: "Nothing to update. Preview does not fetch: click Fetch, then preview again.";
	}

	const plan = view.env;
	const changes = plan?.changes ?? [];
	const conflicts = changes.filter((c) => c.state === "conflict").length;
	const writes = changes.filter((c) => c.state !== "same").length;
	$("#overwrite-row").hidden = !plan || conflicts === 0;
	let reason;
	if (!plan || envPreview !== envKey())
		reason = "Preview first to see what will change.";
	else if (writes === 0)
		reason = "Nothing to write. The target already matches.";
	else if (conflicts > 0 && !$("#overwrite").checked)
		reason = `${plural(conflicts, "key")} already ${conflicts === 1 ? "has" : "have"} a different value. Tick “Replace conflicting values” to continue.`;
	$("#env-apply").disabled = reason != null;
	$("#env-reason").textContent =
		reason ?? `Writes ${plural(writes, "key")} to ${plan.target}.`;
}

function fillSelect(select, values, labels = values) {
	const previous = select.value;
	select.replaceChildren(
		...values.map((value, i) => el("option", { value }, labels[i])),
	);
	if (values.includes(previous)) select.value = previous;
}

function renderRegistry() {
	const groups = [...new Set(registry.workspaces.map((item) => item.group))];
	// A group picker only matters once there is something to choose between.
	$("#group-picker").hidden = groups.length < 2;
	fillSelect($("#group"), ["", ...groups], ["All groups", ...groups]);
	$("#group-options").replaceChildren(
		...groups.map((value) => el("option", { value })),
	);
	const source = $("#env-form [name=source]");
	fillSelect(
		source,
		registry.workspaces.map((item) => item.name),
	);
	// Start from a workspace that has someone to share with.
	if (peers(source.value).length === 0) {
		const shared = registry.workspaces.find(
			(item) => peers(item.name).length > 0,
		);
		if (shared) source.value = shared.name;
	}
	fillTargets();
}

// Keys are only copied within one group, so "To" only offers the source's group.
const peers = (name) => {
	const source = workspaceNamed(name);
	return registry.workspaces
		.filter((item) => source && item.group === source.group && item !== source)
		.map((item) => item.name);
};

function fillTargets() {
	const form = $("#env-form");
	const source = workspaceNamed(form.elements.source.value);
	const names = peers(form.elements.source.value);
	fillSelect(form.elements.target, names);
	form.elements.target.disabled = names.length === 0;
	$("#env-plan").disabled = names.length === 0;
	const note = $("#env-peers");
	note.textContent =
		source && names.length === 0
			? `No other workspace is in group "${source.group}". Keys are only copied within one group: register another clone of this repository in "${source.group}", or change a group with Edit on the Workspaces tab.`
			: "";
	note.hidden = !note.textContent;
}

function render() {
	const list = $("#workspace-list");
	// Cards are rebuilt from data; keep what the user opened or typed.
	const opened = [...list.querySelectorAll("details[open][data-key]")].map(
		(node) => node.dataset.key,
	);
	// Read fields directly: FormData skips them while the UI is locked (disabled).
	const draft = [...($("#edit-form")?.elements ?? [])]
		.filter((field) => field.name)
		.map((field) => [field.name, field.value]);
	list.ariaBusy = String(Boolean(view.loading));
	if (loaded && registry.workspaces.length === 0)
		list.replaceChildren(
			el(
				"p",
				{ className: "empty" },
				"No workspaces yet. Add a clone or worktree of a repository to get started.",
			),
		);
	else if (!view.statuses && view.loading)
		list.replaceChildren(
			...Array.from({ length: view.loading }, () =>
				el(
					"article",
					{ className: "card skeleton", ariaHidden: "true" },
					["short", "long", "medium"].map((size) =>
						el("span", { className: `bar ${size}` }),
					),
				),
			),
		);
	else if (loaded && !view.statuses)
		list.replaceChildren(
			el(
				"p",
				{ className: "empty" },
				"Could not read the workspaces. Refresh to try again.",
			),
		);
	else list.replaceChildren(...(view.statuses ?? []).map(renderWorkspace));
	for (const node of list.querySelectorAll("details[data-key]"))
		if (opened.includes(node.dataset.key)) node.open = true;
	const form = $("#edit-form");
	if (form)
		for (const [key, value] of draft)
			if (form.elements[key]) form.elements[key].value = value;
	$("#sync-result").replaceChildren(
		...(view.sync ? renderSync(view.sync) : []),
	);
	$("#env-result").replaceChildren(...(view.env ? renderEnv(view.env) : []));
	gate();
}

async function refresh() {
	const data = await call("registry", {}, { busy: "Reading workspaces…" });
	if (!data) return;
	registry = data;
	loaded = true;
	renderRegistry();
	if (registry.workspaces.length === 0) {
		view.statuses = null;
		render();
		$("#register-panel").open = true;
		return;
	}
	// First load shows card-shaped placeholders; later refreshes keep the old cards up.
	view.loading = registry.workspaces.filter(
		(item) => !group() || item.group === group(),
	).length;
	render();
	const statuses = await call(
		"status",
		{ group: group() },
		{ busy: "Reading workspaces…" },
	);
	view.loading = 0;
	if (statuses) view.statuses = statuses;
	render();
}

function workspaceStatus(state) {
	if (state.error) return [[state.error, "warn"]];
	const ref = baseRef(state.workspace);
	const items = [];
	if (state.operation) items.push(["Git operation in progress", "warn"]);
	if (state.dirty) items.push(["Uncommitted changes", "warn"]);
	if (state.interrupted > 0)
		items.push([
			"An update was interrupted — run clonelane history to see its backup",
			"warn",
		]);
	if (state.baseHead == null) items.push([`${ref} not fetched yet`, "warn"]);
	else {
		if (state.baseBehind > 0)
			items.push([
				`${plural(state.baseBehind, "commit")} behind ${ref}`,
				"warn",
			]);
		if (state.baseAhead > 0)
			items.push([
				`${plural(state.baseAhead, "commit")} ahead of ${ref}`,
				// Unique commits on the base branch itself block a fast-forward.
				state.branch === state.workspace.base ? "warn" : "",
			]);
		if (items.length === 0) items.push([`Up to date with ${ref}`, ""]);
	}
	return items;
}

function renderWorkspace(state) {
	const { workspace } = state;
	const items = workspaceStatus(state);
	const attention = items.some(([, kind]) => kind === "warn");
	const showGroup = !$("#group-picker").hidden && !group();
	return el(
		"article",
		{ className: `card${attention ? " attention" : ""}` },
		el(
			"div",
			{ className: "card-head" },
			el("span", { className: "dot", ariaHidden: "true" }),
			el("strong", { className: "name" }, workspace.name),
			!state.error &&
				pill("local", state.branch ?? "detached HEAD", { current: true }),
			el(
				"span",
				{ className: "card-tools" },
				showGroup && el("span", { className: "group-tag" }, workspace.group),
				el(
					"button",
					{
						type: "button",
						className: "small",
						ariaLabel: `Edit ${workspace.name}`,
						dataset: { edit: workspace.name },
						ariaExpanded: String(editing === workspace.name),
						onclick: () => toggleEdit(workspace.name),
					},
					"Edit",
				),
			),
		),
		editing === workspace.name && editForm(workspace),
		!state.error &&
			el(
				"p",
				{ className: "commit-line" },
				el(
					"code",
					{ className: "hash", title: state.head },
					state.head.slice(0, 7),
				),
				" ",
				state.subject,
			),
		el(
			"p",
			{ className: "status-line" },
			items.map(([text, kind], i) => [
				i > 0 && el("span", { className: "sep", ariaHidden: "true" }, " · "),
				el("span", { className: kind }, text),
			]),
		),
		el(
			"p",
			{ className: "meta" },
			el("code", { className: "path" }, workspace.path),
			!state.error &&
				el(
					"span",
					{},
					state.lastFetch ? `Fetched ${ago(state.lastFetch)}` : "Never fetched",
				),
		),
		!state.error &&
			el(
				"details",
				{ dataset: { key: `${workspace.name}:branches` } },
				el(
					"summary",
					{},
					plural(state.branches.length, "local branch", "local branches"),
				),
				table(
					["Branch", "Upstream", "Ahead", "Behind"],
					state.branches.map((branch) => [
						[
							pill("local", branch.name, { current: branch.current }),
							branch.current && el("span", { className: "none" }, " current"),
						],
						branch.upstream?.startsWith("refs/remotes/")
							? pill("remote", branch.upstream.slice(13))
							: branch.upstream?.startsWith("refs/heads/")
								? pill("local", branch.upstream.slice(11))
								: el("span", { className: "none" }, "no upstream"),
						branch.ahead ?? "",
						branch.behind ?? "",
					]),
					"branches",
				),
			),
		!state.error &&
			el(
				"details",
				{
					dataset: { key: `${workspace.name}:history` },
					ontoggle: (event) => loadGraph(event.currentTarget, state),
				},
				el("summary", {}, "History"),
				el(
					"p",
					{ className: "legend" },
					pill("local", "local branch"),
					pill("remote", "remote branch"),
					pill("tag", "tag"),
				),
				el("p", { className: "graph-slot empty" }, "Loading history…"),
			),
	);
}

// Read on first open; a refresh rebuilds the card, so the next open reads again.
async function loadGraph(details, state) {
	if (!details.open || details.dataset.loaded) return;
	details.dataset.loaded = "true";
	const commits = await call("graph", { name: state.workspace.name });
	// On failure the error shows in the footer and the next open tries again.
	if (!commits) {
		delete details.dataset.loaded;
		const slot = details.querySelector(".graph-slot");
		if (slot)
			slot.textContent =
				"Could not load the history. Close and reopen to retry.";
		return;
	}
	details
		.querySelector(".graph-slot")
		?.replaceWith(
			commits.length
				? renderGraph(commits, state.head)
				: el("p", { className: "empty" }, "No commits yet."),
		);
}

const ROW = 28;
const STEP = 16;
const PAD = 10;
const LANE_COLORS = 8;

function svg(tag, attrs = {}) {
	const node = document.createElementNS("http://www.w3.org/2000/svg", tag);
	for (const [key, value] of Object.entries(attrs))
		node.setAttribute(key, String(value));
	return node;
}

const ICONS = {
	remote:
		"M4.5 13h7.2a3.3 3.3 0 0 0 .5-6.56A4.5 4.5 0 0 0 3.6 6.3 3.4 3.4 0 0 0 4.5 13Z",
	tag: "M2 2.8V7.6l6.6 6.6 5.6-5.6L7.6 2H2.8a.8.8 0 0 0-.8.8ZM5 4.2a1 1 0 1 1 0 2 1 1 0 0 1 0-2Z",
};

function icon(kind) {
	const node = svg("svg", {
		class: "icon",
		viewBox: "0 0 16 16",
		"aria-hidden": "true",
	});
	node.append(svg("path", { d: ICONS[kind] }));
	return node;
}

// One look for a ref everywhere: local is green (filled when checked out), remote is
// blue with a cloud, tag is grey. `remote` names the remote of a twin on the same commit.
function pill(kind, name, { current = false, remote = null } = {}) {
	return el(
		"span",
		{ className: `ref ${kind}${current ? " current" : ""}` },
		ICONS[kind] && icon(kind),
		el("span", { className: "ref-name" }, name),
		remote && el("span", { className: "twin" }, icon("remote"), remote),
	);
}

// A local branch and its remote counterpart on the same commit share one pill.
function refPills(refs) {
	const remotes = refs.filter((ref) => ref.kind === "remote");
	const twins = new Set();
	const locals = refs
		.filter((ref) => ref.kind === "head" || ref.kind === "branch")
		.sort((a, b) => (b.kind === "head") - (a.kind === "head"))
		.map((ref) => {
			const twin = remotes.find(
				(other) => other.name.slice(other.name.indexOf("/") + 1) === ref.name,
			);
			if (twin) twins.add(twin);
			return pill("local", ref.name, {
				current: ref.kind === "head",
				remote: twin?.name.slice(0, twin.name.indexOf("/")),
			});
		});
	return [
		...locals,
		...remotes
			.filter((ref) => !twins.has(ref))
			.map((ref) => pill("remote", ref.name)),
		...refs
			.filter((ref) => ref.kind === "tag")
			.map((ref) => pill("tag", ref.name)),
	];
}

// Commit graph in the style of Git Graph and Fork: coloured lanes, curved forks and
// merges, branch pills, then subject, author, age and hash.
function renderGraph(commits, head) {
	const { cols, segments, width } = layout(commits);
	const x = (col) => PAD + col * STEP;
	const y = (row) => row * ROW + ROW / 2;
	const lane = (col) => `c${col % LANE_COLORS}`;
	const drawing = svg("svg", {
		class: "lanes",
		width: x(width - 1) + PAD,
		height: commits.length * ROW,
		"aria-hidden": "true",
	});
	for (const s of segments) {
		const [x1, y1, x2, y2] = [x(s.x1), y(s.r1), x(s.x2), y(s.r2)];
		const mid = (y1 + y2) / 2;
		drawing.append(
			svg("path", {
				class: lane(s.lane),
				d:
					x1 === x2
						? `M${x1} ${y1}V${y2}`
						: `M${x1} ${y1}C${x1} ${mid} ${x2} ${mid} ${x2} ${y2}`,
			}),
		);
	}
	commits.forEach((commit, r) => {
		drawing.append(
			svg("circle", {
				class: `${lane(cols[r])}${commit.hash === head ? " head" : ""}`,
				cx: x(cols[r]),
				cy: y(r),
				r: commit.hash === head ? 5 : 4,
			}),
		);
	});
	return el(
		"div",
		{ className: "graph" },
		drawing,
		el(
			"ol",
			{},
			commits.map((commit) =>
				el(
					"li",
					{
						className: commit.hash === head ? "current" : "",
						title: `${commit.hash}\n${new Date(commit.time).toLocaleString("en")}`,
					},
					el(
						"span",
						{ className: "message" },
						refPills(commit.refs),
						el("span", { className: "subject" }, commit.subject),
					),
					el("span", { className: "author" }, commit.author),
					el("span", { className: "age" }, ago(commit.time)),
					el("code", { className: "hash" }, commit.hash.slice(0, 7)),
				),
			),
		),
	);
}

// Registry edits: rename, move to another group, or forget the workspace.
let editing = null;

function toggleEdit(name) {
	editing = editing === name ? null : name;
	render();
	if (editing) $("#edit-form [name=newName]")?.focus();
	else focusEdit(name);
}

// When the form closes, keyboard focus returns to the card's Edit button.
const focusEdit = (name) => $(`[data-edit="${CSS.escape(name)}"]`)?.focus();

// A preview describes the registry and remotes it was made with.
function dropPreviews() {
	view.sync = null;
	view.env = null;
	syncPreview = null;
	envPreview = null;
}

function editForm(workspace) {
	const group = el("input", {
		name: "group",
		value: workspace.group,
		required: true,
	});
	group.setAttribute("list", "group-options");
	return el(
		"form",
		{ id: "edit-form", className: "edit grid", onsubmit: saveEdit },
		el(
			"label",
			{},
			"Name",
			el("input", { name: "newName", value: workspace.name, required: true }),
		),
		el("label", {}, "Group", group),
		el(
			"p",
			{ className: "hint wide" },
			"Workspaces in the same group sync together and can share .env keys. Use one group for every clone and worktree of a repository.",
		),
		el(
			"div",
			{ className: "actions wide" },
			el("button", { type: "submit", className: "primary" }, "Save"),
			el(
				"button",
				{ type: "button", onclick: () => toggleEdit(workspace.name) },
				"Cancel",
			),
			el(
				"button",
				{
					type: "button",
					className: "danger",
					onclick: () => forget(workspace.name),
				},
				"Remove from Clonelane…",
			),
		),
		el("p", {
			id: "edit-error",
			className: "alert wide",
			role: "alert",
			hidden: true,
		}),
	);
}

async function saveEdit(event) {
	event.preventDefault();
	const updated = await call(
		"update",
		{ name: editing, ...Object.fromEntries(new FormData(event.currentTarget)) },
		{ busy: "Saving…", alert: "edit-error" },
	);
	if (!updated) return;
	editing = null;
	dropPreviews();
	await refresh();
	focusEdit(updated.name);
	say(`Saved ${updated.name}.`);
}

async function forget(name) {
	if (
		!confirm(
			`Remove "${name}" from Clonelane? Only the registration is removed; the folder, branches and files stay as they are.`,
		)
	)
		return;
	const removed = await call(
		"remove",
		{ name },
		{ busy: "Removing…", alert: "edit-error" },
	);
	if (!removed) return;
	editing = null;
	dropPreviews();
	view.statuses = view.statuses?.filter(
		(state) => state.workspace.name !== name,
	);
	await refresh();
	say(`Removed ${name}. Add it again any time.`);
}

function syncLines(item) {
	const workspace = workspaceNamed(item.name);
	const ref = baseRef(workspace);
	// Failed before the workspace was read (fetch, lock): there is no branch to describe.
	if (!item.head) return [`Not synced — ${reasonText(item.reason)}`];
	const branch = item.branch ?? "detached HEAD";
	// After Apply, say what happened rather than what would.
	const done = item.result === "updated";
	const checkout = {
		"fast-forward": `${done ? "Fast-forwarded" : "Fast-forward"} ${branch} to ${ref}`,
		rebase: `${done ? "Rebased" : "Rebase"} ${branch} onto ${ref}`,
		"up-to-date": `${branch} is up to date`,
		skip: `${branch} stays as it is — ${reasonText(item.reason)}`,
	}[item.action];
	const base = item.baseUpdate;
	const local = `local ${workspace?.base ?? "base"}`;
	const baseLine =
		base &&
		// The checkout line already explains these.
		!["handled-by-checkout", "workspace-busy"].includes(base.reason) &&
		{
			"fast-forward": `${base.result === "updated" ? "Fast-forwarded" : "Fast-forward"} ${local} to ${ref}`,
			"up-to-date": `${capitalize(local)} is up to date`,
			skip: `${capitalize(local)} stays as it is — ${reasonText(base.reason)}`,
		}[base.action];
	return [checkout, baseLine].filter(Boolean);
}

const groupTitles = {
	update: "Will update",
	updated: "Updated",
	blocked: "Needs attention",
	none: "No change",
	failed: "Failed",
};

function renderSync({ results, applied }) {
	const order = applied
		? ["failed", "updated", "blocked", "none"]
		: ["update", "blocked", "none"];
	return order.flatMap((kind) => {
		const rows = results.filter((item) => outcome(item, applied) === kind);
		if (rows.length === 0) return [];
		return [
			el(
				"section",
				{ className: `sync-group ${kind}` },
				el(
					"h2",
					{},
					groupTitles[kind],
					el("span", { className: "count" }, rows.length),
				),
				el(
					"ul",
					{},
					rows.map((item) =>
						el(
							"li",
							{ className: "sync-row" },
							el("strong", { className: "name" }, item.name),
							el(
								"div",
								{},
								syncLines(item).map((line) => el("p", {}, line)),
								[item.backup, item.baseUpdate?.backup]
									.filter(Boolean)
									.map((ref) =>
										el("p", { className: "backup" }, `Backup: ${ref}`),
									),
								item.error &&
									el(
										"p",
										{ className: "error", title: item.error },
										item.message ?? `Failed (${item.error})`,
									),
							),
						),
					),
				),
			),
		];
	});
}

const stateText = {
	add: "will be added",
	same: "already the same",
	conflict: "different value",
};

function renderEnv(plan) {
	return [
		el(
			"p",
			{ className: "plan-title" },
			`${plan.source} → ${plan.target} `,
			el("code", {}, plan.file),
		),
		table(
			["Key", "Change"],
			plan.changes.map((change) => [
				[
					el("code", {}, change.key),
					/^(VITE_|NEXT_PUBLIC_|PUBLIC_)/.test(change.key) &&
						el("span", { className: "none" }, " browser-exposed"),
				],
				el(
					"span",
					{ className: `state ${change.state}` },
					stateText[change.state] ?? change.state,
				),
			]),
		),
	];
}

// Tabs follow the WAI-ARIA pattern: one tab stop, arrow keys move between tabs.
const tabs = [...document.querySelectorAll("[role=tab]")];
function selectTab(tab, focus = false) {
	for (const other of tabs) {
		const selected = other === tab;
		other.setAttribute("aria-selected", String(selected));
		other.tabIndex = selected ? 0 : -1;
		$(`#${other.dataset.tab}`).hidden = !selected;
	}
	if (focus) tab.focus();
}
for (const tab of tabs) {
	tab.addEventListener("click", () => selectTab(tab));
	tab.addEventListener("keydown", (event) => {
		const index = tabs.indexOf(tab);
		const next = {
			ArrowRight: tabs[(index + 1) % tabs.length],
			ArrowLeft: tabs[(index - 1 + tabs.length) % tabs.length],
			Home: tabs[0],
			End: tabs.at(-1),
		}[event.key];
		if (!next) return;
		event.preventDefault();
		selectTab(next, true);
	});
}

// A preview only stands for the options it was made with.
function invalidateSync() {
	if (view.sync && !view.sync.applied && syncPreview !== syncKey()) {
		view.sync = null;
		syncPreview = null;
		render();
	}
}

$("#refresh").addEventListener("click", refresh);
$("#group").addEventListener("change", () => {
	invalidateSync();
	refresh();
});
$("#rebase").addEventListener("change", invalidateSync);
$("#overwrite").addEventListener("change", gate);
// The key list only applies to "Only these keys"; disabled fields stay out of the form data.
$("#env-form").addEventListener("change", (event) => {
	if (event.target.name === "source") fillTargets();
	if (event.target.name !== "scope") return;
	const form = event.currentTarget;
	const selected = form.elements.scope.value === "selected";
	form.elements.keys.disabled = !selected;
	form.elements.keys.hidden = !selected;
	form.elements.publicKeys.disabled = !selected;
	if (selected) form.elements.keys.focus();
});
$("#env-form").addEventListener("input", () => {
	if (view.env && envPreview !== envKey()) {
		view.env = null;
		envPreview = null;
		render();
	}
});

$("#fetch").addEventListener("click", async () => {
	const fetched = await call(
		"fetch",
		{ group: group() },
		{ busy: "Fetching from remotes…" },
	);
	if (!fetched) return;
	// Remote refs moved, so an earlier sync preview no longer holds.
	if (!view.sync?.applied) {
		view.sync = null;
		syncPreview = null;
	}
	await refresh();
	// Each workspace is fetched on its own; name the ones that failed and why.
	const failed = fetched.filter((item) => item.result === "failed");
	if (failed.length)
		showError("footer-alert", {
			message: `Fetched ${fetched.length - failed.length} of ${plural(fetched.length, "workspace")}. ${failed.map((item) => `${item.name}: ${item.message}`).join(" · ")}`,
			code: [...new Set(failed.map((item) => item.error))].join(", "),
		});
	else say(`Fetched ${plural(fetched.length, "workspace")}.`);
});

$("#browse").addEventListener("click", async () => {
	const path = await call("pickFolder", {}, { alert: "register-error" });
	if (!path) return;
	const form = $("#register");
	form.elements.path.value = path;
	// Suggest a name from the folder; the user can still change it.
	if (!form.elements.name.value)
		form.elements.name.value = path.split(/[\\/]/).filter(Boolean).at(-1) ?? "";
});

$("#register").addEventListener("submit", async (event) => {
	event.preventDefault();
	const form = event.currentTarget;
	const workspace = await call(
		"register",
		Object.fromEntries(new FormData(form)),
		{ busy: "Adding…", alert: "register-error" },
	);
	if (!workspace) return;
	form.reset();
	$("#register-panel").open = false;
	await refresh();
	say(`Added ${workspace.name}.`);
});

$("#sync-preview").addEventListener("click", async () => {
	const key = syncKey();
	const results = await call(
		"sync",
		{ group: group(), dryRun: true, rebase: $("#rebase").checked },
		{ busy: "Preparing preview…", alert: "sync-error" },
	);
	view.sync = results ? { results, applied: false } : null;
	syncPreview = results ? key : null;
	render();
});

$("#sync-apply").addEventListener("click", async () => {
	if (
		!confirm(
			"Fetch and apply this sync? If a remote moved since the preview, the result can differ.",
		)
	)
		return;
	const results = await call(
		"sync",
		{ group: group(), rebase: $("#rebase").checked },
		{ busy: "Fetching and syncing…", alert: "sync-error" },
	);
	syncPreview = null;
	if (!results) {
		gate();
		return;
	}
	await refresh();
	view.sync = { results, applied: true };
	render();
});

$("#env-form").addEventListener("submit", async (event) => {
	event.preventDefault();
	const key = envKey();
	const plan = await call("envPlan", envInput(), {
		busy: "Comparing keys…",
		alert: "env-error",
	});
	view.env = plan;
	envPreview = plan ? key : null;
	$("#overwrite").checked = false;
	render();
});

$("#env-apply").addEventListener("click", async () => {
	const overwrite = $("#overwrite").checked;
	if (
		!confirm(
			overwrite
				? "Write these keys and replace the conflicting values?"
				: "Write these keys to the target file?",
		)
	)
		return;
	const done = await call(
		"envApply",
		{ ...envInput(), overwrite },
		{ busy: "Writing keys…", alert: "env-error" },
	);
	if (!done) return;
	// Compare again so the table shows the file as it is now.
	const key = envKey();
	const plan = await call("envPlan", envInput(), { alert: "env-error" });
	view.env = plan;
	envPreview = plan ? key : null;
	$("#overwrite").checked = false;
	render();
	say("Keys written.");
});

refresh();
