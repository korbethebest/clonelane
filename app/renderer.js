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
const view = {
	statuses: null,
	sync: null,
	// Env preview or result: { key, input, results, applied, overwrite }.
	env: null,
	loading: 0,
};
let syncPreview = null;

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
// The automatic fetch in progress, if any (see autoFetch).
let backgroundFetch = null;
async function call(name, input, { busy, alert = "footer-alert" } = {}) {
	pending++;
	const focused = document.activeElement;
	$("#ui").disabled = true;
	for (const id of controls) $(id).disabled = true;
	showError(alert, null);
	showError("footer-alert", null);
	try {
		// Never run beside an automatic fetch: both could take the same Git ref locks.
		if (backgroundFetch) {
			say("Waiting for the automatic fetch to finish…", true);
			await backgroundFetch;
			say();
		}
		if (busy) say(busy, true);
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

const writing = (change) =>
	["add", "conflict", "remove"].includes(change.state);
// Replacing or removing a value needs the explicit tick; adding one never does.
function riskText(changes) {
	const differ = changes.filter((c) => c.state === "conflict").length;
	const removed = changes.filter((c) => c.state === "remove").length;
	const parts = [
		differ &&
			`${plural(differ, "key")} ${differ === 1 ? "has" : "have"} a different value`,
		removed && `${plural(removed, "key")} would be removed`,
	].filter(Boolean);
	return parts.length
		? `${capitalize(parts.join(" and "))}. Tick “Replace differing values and remove keys” to continue.`
		: null;
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
					: "Nothing to update. Preview does not fetch: click Fetch remote, then preview again.";
	}
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
	const sourceName = form.elements.source.value;
	const source = workspaceNamed(sourceName);
	const names = peers(sourceName);
	const list = $("#target-list");
	// Rebuilt with the registry: keep what was ticked and typed for the same source.
	const before = new Map(
		list.dataset.source === sourceName
			? [...list.children].map((row) => [
					row.dataset.name,
					{
						checked: row.querySelector("[name=target]").checked,
						keep: row.querySelector("[type=text]").value,
					},
				])
			: [],
	);
	list.dataset.source = sourceName;
	list.replaceChildren(
		...names.map((name) => {
			const was = before.get(name);
			const box = el("input", {
				type: "checkbox",
				name: "target",
				value: name,
				checked: was?.checked ?? true,
			});
			const keep = el("input", {
				type: "text",
				name: `keep:${name}`,
				value: was?.keep ?? "",
				placeholder: "PORT, DB_NAME",
				ariaLabel: `Keys kept local in ${name}`,
				disabled: !box.checked,
			});
			box.addEventListener("change", () => {
				keep.disabled = !box.checked;
			});
			return el(
				"div",
				{ className: "target-row", dataset: { name } },
				el("label", { className: "inline" }, box, name),
				el("label", { className: "inline keep" }, "Keep local", keep),
			);
		}),
	);
	$("#targets-legend").textContent = source
		? `To (others in ${source.group})`
		: "To";
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
		// The guide carries the first-run message when it is open.
		list.replaceChildren(
			...(guideShown()
				? []
				: [
						el(
							"p",
							{ className: "empty" },
							"No workspaces yet. Add a clone or worktree of a repository to get started.",
						),
					]),
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
				"Could not read the workspaces. Click Reload local to try again.",
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
	if (view.env && view.env.key !== envKey()) view.env = null;
	$("#env-result").replaceChildren(
		...(view.env ? renderEnvResult(view.env) : []),
	);
	renderProfiles();
	renderGuide();
	gate();
}

async function refresh() {
	const data = await call("registry", {}, { busy: "Reading workspaces…" });
	if (!data) return;
	registry = data;
	loaded = true;
	// Someone who already has workspaces is not new: keep the guide closed for them.
	if (recall(GUIDE) == null)
		remember(GUIDE, registry.workspaces.length > 0 ? "hidden" : "shown");
	renderRegistry();
	if (registry.workspaces.length === 0) {
		view.statuses = null;
		render();
		$("#register-panel").open = true;
		return;
	}
	// First load shows the last known state (controls stay disabled until it is fresh), or
	// card-shaped placeholders; later refreshes keep the old cards up.
	const first = !view.statuses;
	const saved = first
		? await window.clonelane.call("cachedStatus", { group: group() })
		: null;
	if (saved?.ok && saved.data) view.statuses = saved.data.statuses;
	else if (first)
		view.loading = registry.workspaces.filter(
			(item) => !group() || item.group === group(),
		).length;
	render();
	const statuses = await call(
		"status",
		{ group: group() },
		{
			busy: saved?.data
				? `Showing the last known state (${ago(saved.data.at)}). Reading workspaces…`
				: "Reading workspaces…",
		},
	);
	view.loading = 0;
	if (statuses) view.statuses = statuses;
	// The last known state was only a stand-in: never leave it up as if it were current.
	else if (saved?.data) view.statuses = null;
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
			"An update was interrupted — open Branch moves to see its backup",
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
		!state.error &&
			el(
				"details",
				{
					dataset: { key: `${workspace.name}:moves` },
					ontoggle: (event) => loadMoves(event.currentTarget, state),
				},
				el("summary", {}, "Branch moves"),
				el(
					"p",
					{ className: "hint" },
					"Every branch Clonelane moved, with a backup of where it was. Restore puts a branch back, only if nothing changed since.",
				),
				el("p", { className: "moves-slot empty" }, "Loading…"),
			),
	);
}

const moveKinds = {
	"fast-forward": "Fast-forward",
	rebase: "Rebase",
	"base-fast-forward": "Base fast-forward",
	restore: "Restore",
};
const short = (sha) => sha?.slice(0, 7) ?? "—";
const branchName = (ref) => ref.slice("refs/heads/".length);

// Read on first open, like the history graph.
async function loadMoves(details, state) {
	if (!details.open || details.dataset.loaded) return;
	details.dataset.loaded = "true";
	const operations = await call("operations", { name: state.workspace.name });
	const slot = details.querySelector(".moves-slot");
	if (!operations) {
		delete details.dataset.loaded;
		if (slot)
			slot.textContent =
				"Could not read the branch moves. Close and reopen to retry.";
		return;
	}
	// Newest first: once a branch has a later move that can be undone, older ones would only
	// be refused. A rebase that stopped before recording its result cannot be undone (the
	// core refuses it), so it neither gets a button nor hides the older moves.
	const moved = new Set();
	const restorable = (operation) =>
		(operation.state === "done" ||
			(operation.state === "interrupted" && operation.kind !== "rebase")) &&
		!moved.has(operation.ref) &&
		moved.add(operation.ref);
	slot?.replaceWith(
		operations.length
			? table(
					["When", "Branch", "Move", "From → to", "State", ""],
					operations.map((operation) => [
						el(
							"span",
							{ title: operation.time },
							ago(Date.parse(operation.time)),
						),
						pill("local", branchName(operation.ref)),
						moveKinds[operation.kind] ?? operation.kind,
						el(
							"code",
							{},
							`${short(operation.from)} → ${short(operation.tip ?? operation.to)}`,
						),
						operation.state,
						// The core still checks everything; this only hides the hopeless ones.
						restorable(operation) &&
							el(
								"button",
								{
									type: "button",
									className: "small",
									onclick: () => restoreMove(state.workspace, operation),
								},
								"Restore…",
							),
					]),
					"moves",
				)
			: el("p", { className: "empty" }, "No branch moves recorded yet."),
	);
}

// Preview first (changes nothing), then ask, then restore with the same checks again.
async function restoreMove(workspace, operation) {
	const input = { name: workspace.name, id: operation.id };
	const plan = await call("restore", { ...input, dryRun: true });
	if (!plan) return;
	const branch = branchName(plan.ref);
	if (plan.result === "refused") {
		showError("footer-alert", { message: plan.message, code: plan.reason });
		return;
	}
	if (
		!confirm(
			`Move ${branch} in ${workspace.name} from ${short(plan.from)} back to ${short(plan.to)}? Its current commit is backed up first, so this can be undone too.`,
		)
	)
		return;
	const result = await call("restore", input, {
		busy: `Restoring ${branch}…`,
	});
	if (!result) return;
	await refresh();
	if (result.result === "refused")
		showError("footer-alert", { message: result.message, code: result.reason });
	else say(`Restored ${branch} in ${workspace.name} to ${short(result.to)}.`);
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
	kept: "kept local in the target",
	remove: "will be removed",
};
// After a write, the same states read as what happened.
const writtenText = {
	...stateText,
	add: "added",
	conflict: "replaced",
	remove: "removed",
};

function renderEnv(plan, written = false) {
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
					(written ? writtenText : stateText)[change.state] ?? change.state,
				),
			]),
		),
	];
}

// Env sharing: one source, then every other workspace of its group as a checkbox (all
// ticked by default), each with its own kept keys. A profile is this form, saved.
const profiles = () => registry.profiles ?? [];

// What the form asks for, as flat fields: kept keys travel as "keep:<workspace>".
function envInput() {
	const data = new FormData($("#env-form"));
	const source = String(data.get("source") ?? "");
	const targets = data.getAll("target").map(String);
	const input = {
		source,
		targets: targets.join(","),
		allTargets: targets.length > 0 && targets.length === peers(source).length,
		scope: String(data.get("scope") ?? "all"),
		keys: String(data.get("keys") ?? ""),
		publicKeys: String(data.get("publicKeys") ?? ""),
		file: String(data.get("file") ?? ""),
		prune: data.get("prune") === "on",
	};
	for (const name of targets) {
		const keep = String(data.get(`keep:${name}`) ?? "").trim();
		if (keep) input[`keep:${name}`] = keep;
	}
	return input;
}
// A preview stands for the form and the group as registered when it was made.
const envKey = () =>
	JSON.stringify([
		envInput(),
		registry.workspaces.map((item) => [item.name, item.group]),
	]);

function applyScope() {
	const form = $("#env-form");
	const selected = form.elements.scope.value === "selected";
	form.elements.keys.disabled = !selected;
	form.elements.keys.hidden = !selected;
	form.elements.publicKeys.disabled = !selected;
	// Removing keys the source lacks only makes sense when mirroring the whole file.
	form.elements.prune.disabled = selected;
	if (selected) form.elements.prune.checked = false;
}

function describeProfile(profile) {
	const group = workspaceNamed(profile.source)?.group;
	const to = profile.targets
		? profile.targets.join(", ")
		: group
			? `every other workspace in ${group}`
			: "its group (source not registered)";
	const kept = Object.entries(profile.keep ?? {}).map(
		([name, keys]) => `${name} keeps ${keys.join(", ")}`,
	);
	return [
		`From ${profile.source} to ${to}`,
		profile.file,
		profile.keys === "all" ? "all keys" : profile.keys.join(", "),
		profile.prune && "removes keys the source lacks",
		...kept,
	]
		.filter(Boolean)
		.join(" · ");
}

function renderProfiles() {
	const list = profiles();
	$("#profiles").hidden = list.length === 0;
	$("#profile-list").replaceChildren(
		...list.map((profile) =>
			el(
				"div",
				{ className: "profile" },
				el(
					"div",
					{ className: "profile-text" },
					el("strong", {}, profile.name),
					el("p", { className: "profile-meta" }, describeProfile(profile)),
				),
				el(
					"button",
					{
						type: "button",
						ariaLabel: `Open profile ${profile.name}`,
						onclick: () => openProfile(profile),
					},
					"Open",
				),
				el(
					"button",
					{
						type: "button",
						className: "small",
						ariaLabel: `Delete profile ${profile.name}`,
						onclick: () => deleteProfile(profile),
					},
					"Delete",
				),
			),
		),
	);
}

function renderEnvResult(shown) {
	const { results, applied } = shown;
	const plans = results.filter((item) => item.plan);
	const changes = plans.flatMap((item) => item.plan.changes);
	const risk = riskText(changes);
	const writes = changes.filter(writing).length;
	const failed = results.length - plans.length;
	// Cards re-render often (auto-fetch, reloads): the tick lives in the view, not the DOM.
	const overwrite = el("input", {
		type: "checkbox",
		checked: shown.overwrite === true,
	});
	const apply = el(
		"button",
		{ type: "button", className: "primary" },
		results.length > 1 ? `Apply to ${results.length} workspaces` : "Apply",
	);
	const reason = el("span", { className: "reason" });
	const gateApply = () => {
		const text =
			writes === 0
				? results.length > 1
					? "Nothing to write. Every target already matches."
					: "Nothing to write. The target already matches."
				: risk && !overwrite.checked
					? risk
					: null;
		apply.disabled = text != null;
		reason.textContent =
			text ??
			`Writes ${plural(writes, "key")}${results.length > 1 ? `, one workspace at a time` : ""}.${failed ? ` ${plural(failed, "workspace")} failed in the preview and will be tried again.` : ""}`;
	};
	overwrite.addEventListener("change", () => {
		shown.overwrite = overwrite.checked;
		gateApply();
	});
	apply.addEventListener("click", () => applyEnvForm(shown));
	gateApply();
	return [
		applied &&
			el(
				"p",
				{ className: "plan-title" },
				"Written. Preview again to compare.",
			),
		...results.flatMap((item) =>
			item.plan
				? renderEnv(item.plan, applied)
				: [el("p", { className: "error" }, `${item.target}: ${item.message}`)],
		),
		!applied &&
			el(
				"div",
				{ className: "commit" },
				risk &&
					el(
						"label",
						{ className: "inline" },
						overwrite,
						"Replace differing values and remove keys",
					),
				apply,
				reason,
			),
	].filter(Boolean);
}

async function previewEnv() {
	const key = envKey();
	const input = envInput();
	const results = await call(
		"envSync",
		{ ...input, dryRun: true },
		{ busy: "Comparing keys…", alert: "env-error" },
	);
	view.env = results ? { key, input, results, applied: false } : null;
	render();
}

async function applyEnvForm(shown) {
	const count = shown.results.length;
	if (
		!confirm(
			`Write keys to ${plural(count, "workspace")}${shown.overwrite ? ", replacing differing values and removing keys" : ""}?`,
		)
	)
		return;
	const results = await call(
		"envSync",
		{ ...shown.input, overwrite: shown.overwrite === true },
		{ busy: "Writing keys…", alert: "env-error" },
	);
	if (!results) return;
	view.env = { ...shown, results, applied: true };
	render();
	const failed = results.filter((item) => item.error).length;
	say(
		failed
			? `Wrote ${results.length - failed} of ${plural(results.length, "workspace")}; see the errors above.`
			: `Wrote ${plural(results.length, "workspace")}.`,
	);
}

// Fill the form from a saved profile, then preview it.
async function openProfile(profile) {
	const form = $("#env-form");
	if (!workspaceNamed(profile.source)) {
		showError("profile-error", {
			message: `Workspace "${profile.source}" is not registered. Delete this profile or register it again.`,
		});
		return;
	}
	showError("profile-error", null);
	form.elements.source.value = profile.source;
	fillTargets();
	const keep = profile.keep ?? {};
	for (const row of $("#target-list").children) {
		const name = row.dataset.name;
		const box = row.querySelector("[name=target]");
		const field = row.querySelector("[type=text]");
		box.checked = !profile.targets || profile.targets.includes(name);
		field.disabled = !box.checked;
		field.value = Object.hasOwn(keep, name) ? keep[name].join(", ") : "";
	}
	form.elements.scope.value = profile.keys === "all" ? "all" : "selected";
	applyScope();
	form.elements.keys.value =
		profile.keys === "all" ? "" : profile.keys.join(", ");
	form.elements.publicKeys.value = (profile.publicKeys ?? []).join(", ");
	form.elements.prune.checked = profile.prune === true;
	form.elements.file.value = profile.file === ".env" ? "" : profile.file;
	$("#profile-name").value = profile.name;
	await previewEnv();
}

async function deleteProfile(profile) {
	if (!confirm(`Delete profile ${profile.name}? No .env file is changed.`))
		return;
	if (
		!(await call(
			"profileRemove",
			{ name: profile.name },
			{ alert: "profile-error" },
		))
	)
		return;
	await reloadRegistry();
	say(`Deleted profile ${profile.name}.`);
}

// Profiles live in the registry; re-read it without re-reading every workspace.
async function reloadRegistry() {
	const data = await call("registry", {});
	if (!data) return;
	registry = data;
	renderRegistry();
	render();
}

$("#profile-name").addEventListener("keydown", (event) => {
	if (event.key !== "Enter") return;
	event.preventDefault();
	$("#profile-save").click();
});

$("#profile-save").addEventListener("click", async () => {
	const name = $("#profile-name").value.trim();
	const saved = await call(
		"profileSave",
		{ ...envInput(), name },
		{ busy: "Saving profile…", alert: "env-error" },
	);
	if (!saved) return;
	await reloadRegistry();
	say(`Saved profile ${saved.name}.`);
});

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
// The key list only applies to "Only these keys"; disabled fields stay out of the form data.
$("#env-form").addEventListener("change", (event) => {
	if (event.target.name === "source") fillTargets();
	if (event.target.name !== "scope") return;
	applyScope();
	if (event.currentTarget.elements.scope.value === "selected")
		event.currentTarget.elements.keys.focus();
});
// Any change to the form makes an earlier preview stand for something else.
$("#env-form").addEventListener("input", () => {
	if (view.env && view.env.key !== envKey()) {
		view.env = null;
		render();
	}
});

async function fetchRemote() {
	const fetched = await call(
		"fetch",
		{ group: group() },
		{ busy: "Fetching from the remote…" },
	);
	if (!fetched) return false;
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
	else {
		const copied = fetched.filter((item) => item.source).length;
		say(
			`Fetched ${plural(fetched.length, "workspace")}${copied ? ` (${copied} copied from another clone on this computer)` : ""}.`,
		);
	}
	return failed.length === 0;
}
$("#fetch").addEventListener("click", fetchRemote);

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

async function previewSync() {
	const key = syncKey();
	const results = await call(
		"sync",
		{ group: group(), dryRun: true, rebase: $("#rebase").checked },
		{ busy: "Preparing preview…", alert: "sync-error" },
	);
	view.sync = results ? { results, applied: false } : null;
	syncPreview = results ? key : null;
	if (results) markPreviewed(results);
	render();
}
$("#sync-preview").addEventListener("click", previewSync);

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

$("#env-form").addEventListener("submit", (event) => {
	event.preventDefault();
	previewEnv();
});

// First-run guide: three real steps that check themselves off from real state. The hidden
// choice and the previewed workspaces live in localStorage under versioned keys, with an
// in-memory copy so the guide still behaves within a session when storage is unavailable.
const GUIDE = "clonelane.guide:v1";
const PREVIEWED = "clonelane.guide.previewed:v2";
const memory = new Map();
function recall(key) {
	if (memory.has(key)) return memory.get(key);
	try {
		return localStorage.getItem(key);
	} catch {
		return null;
	}
}
function remember(key, value) {
	memory.set(key, value);
	try {
		localStorage.setItem(key, value);
	} catch {
		// Kept in memory for this session only.
	}
}
const guideShown = () => recall(GUIDE) !== "hidden";

// Paths of workspaces that have been in a successful sync preview, so step 3 follows the
// registry in use rather than any preview ever made.
function previewedPaths() {
	try {
		const paths = JSON.parse(recall(PREVIEWED) ?? "[]");
		return Array.isArray(paths) ? paths : [];
	} catch {
		return [];
	}
}
function markPreviewed(results) {
	const paths = results
		.map((item) => workspaceNamed(item.name)?.path)
		.filter(Boolean);
	if (paths.length)
		remember(
			PREVIEWED,
			JSON.stringify([...new Set([...previewedPaths(), ...paths])]),
		);
}

const groupCounts = () => {
	const counts = new Map();
	for (const item of registry.workspaces)
		counts.set(item.group, (counts.get(item.group) ?? 0) + 1);
	return counts;
};

function openRegister(groupName = "") {
	selectTab($("#tab-workspaces"));
	const panel = $("#register-panel");
	panel.open = true;
	// Suggest the group only; never replace what the user already typed.
	const field = $("#register").elements.group;
	if (groupName && !field.value) field.value = groupName;
	panel.scrollIntoView({ block: "nearest", behavior: "smooth" });
	$("#browse").focus();
}

const steps = [
	{
		title: "Add a workspace",
		body: "Pick the folder of a clone or worktree. Clonelane reads its repository and remote for you.",
		action: "Add workspace",
		done: () => registry.workspaces.length > 0,
		run: () => openRegister(),
	},
	{
		title: "Add another clone of the same repository",
		body: "Put it in the same group. Sync and .env sharing work between the workspaces of one group.",
		action: "Add another",
		done: () => [...groupCounts().values()].some((count) => count > 1),
		// The group that still has a single clone is the one waiting for its second.
		run: () =>
			openRegister(
				[...groupCounts()].find(([, count]) => count === 1)?.[0] ?? "",
			),
	},
	{
		title: "Fetch, then preview a sync",
		body: "Fetch remote downloads each base branch; Reload local only re-reads this computer. Preview shows what Apply would change and changes nothing itself.",
		action: "Fetch and preview",
		done: () => {
			const previewed = previewedPaths();
			return registry.workspaces.some((item) => previewed.includes(item.path));
		},
		run: async () => {
			// A failed fetch stays on screen; previewing stale refs would hide it.
			if (!(await fetchRemote())) return;
			selectTab($("#tab-sync"));
			await previewSync();
			$("#tab-sync").focus();
		},
	},
];

function check() {
	const icon = svg("svg", {
		class: "check",
		viewBox: "0 0 16 16",
		"aria-hidden": "true",
	});
	icon.append(svg("path", { d: "M3.5 8.5l3 3 6-7" }));
	return icon;
}

// Completion per step as last drawn; null means the list must be drawn from scratch.
let drawn = null;
function renderGuide() {
	const shown = loaded && guideShown();
	$("#guide").hidden = !shown;
	$("#guide-toggle").ariaExpanded = String(shown);
	if (!shown) {
		drawn = null;
		return;
	}
	const states = steps.map((step) => step.done());
	const current = states.indexOf(false);
	$("#guide-progress").textContent =
		`${states.filter(Boolean).length} of ${steps.length} done`;
	$("#guide-done").hidden = current !== -1;
	// Redraw only when completion changes, so the check animation is not restarted.
	if (drawn && states.every((done, index) => done === drawn[index])) return;
	const before = drawn;
	drawn = states;
	const focused = $("#guide-steps").contains(document.activeElement);
	$("#guide-steps").replaceChildren(
		...steps.map((step, index) => {
			const done = states[index];
			// Only the next step offers its action: later steps need the earlier ones.
			const action =
				index === current
					? el("button", { type: "button", className: "primary" }, step.action)
					: null;
			action?.addEventListener("click", step.run);
			return el(
				"li",
				{
					className: [
						done ? "done" : "",
						index === current ? "current" : "",
						// Animate only a step that was open a moment ago, not on first draw.
						done && before?.[index] === false ? "just-done" : "",
					]
						.filter(Boolean)
						.join(" "),
				},
				el(
					"span",
					{ className: "marker", ariaHidden: "true" },
					el("span", { className: "number" }, String(index + 1)),
					check(),
				),
				el(
					"div",
					{ className: "step-text" },
					el(
						"p",
						{ className: "step-title" },
						step.title,
						done
							? el("span", { className: "visually-hidden" }, " (done)")
							: null,
					),
					done ? null : el("p", { className: "step-body" }, step.body),
				),
				action,
			);
		}),
	);
	// Keyboard users keep their place when the list they were in is redrawn.
	if (focused) ($("#guide-steps button") ?? $("#guide-title")).focus();
}

$("#guide-hide").addEventListener("click", () => {
	remember(GUIDE, "hidden");
	render();
	$("#guide-toggle").focus();
});
$("#guide-toggle").addEventListener("click", () => {
	// Before the registry is read, a click would override the first-run decision.
	if (!loaded) return;
	remember(GUIDE, guideShown() ? "hidden" : "shown");
	selectTab($("#tab-workspaces"));
	render();
	if (guideShown()) $("#guide-title").scrollIntoView({ block: "nearest" });
});

// Automatic fetch: while the app is open, fetch remote once the shown workspaces' last
// fetch is 15 minutes old. It never locks the UI; an action started meanwhile waits for
// it in call(). A failed attempt is retried after the same interval, not every minute.
const AUTO_FETCH = "clonelane.autoFetch:v1";
const INTERVAL = 15 * 60 * 1000;
let lastAttempt = 0;
const autoFetchOn = () => recall(AUTO_FETCH) !== "off";
$("#auto-fetch").checked = autoFetchOn();
$("#auto-fetch").addEventListener("change", (event) =>
	remember(AUTO_FETCH, event.currentTarget.checked ? "on" : "off"),
);

const readable = () => (view.statuses ?? []).filter((state) => !state.error);
const baseHeads = () =>
	new Map(readable().map((state) => [state.workspace.path, state.baseHead]));

function fetchDue(now = Date.now()) {
	const states = readable();
	if (!states.length || now - lastAttempt < INTERVAL) return false;
	return (
		now - Math.min(...states.map((state) => state.lastFetch ?? 0)) >= INTERVAL
	);
}

// The last failure shown, so a fetch that keeps failing is not announced every time.
let lastFailure = "";
async function autoFetch() {
	if (!autoFetchOn() || pending > 0 || backgroundFetch || !fetchDue()) return;
	lastAttempt = Date.now();
	const scope = group();
	const before = baseHeads();
	const failure = (error) => ({ ok: false, message: String(error) });
	backgroundFetch = (async () => {
		// Never rejects: actions waiting on it in call() must still run.
		const fetched = await window.clonelane
			.call("fetch", { group: scope })
			.catch(failure);
		// Read status inside the same wait, so no action can see it half-updated.
		const statuses = await window.clonelane
			.call("status", { group: scope })
			.catch(failure);
		return { fetched, statuses };
	})().finally(() => {
		backgroundFetch = null;
	});
	const { fetched, statuses } = await backgroundFetch;
	const current = group() === scope;
	if (current && statuses.ok) view.statuses = statuses.data;
	const moved = readable().filter(
		(state) =>
			before.has(state.workspace.path) &&
			before.get(state.workspace.path) !== state.baseHead,
	);
	// New remote commits make an earlier preview stale, as after Fetch remote. When the
	// new heads cannot be compared (another group, failed read), assume they moved.
	const comparable = current && statuses.ok;
	const anyFetched =
		fetched.ok && fetched.data.some((item) => item.result === "fetched");
	if (
		(comparable ? moved.length > 0 : anyFetched) &&
		view.sync &&
		!view.sync.applied
	) {
		view.sync = null;
		syncPreview = null;
	}
	render();
	const failed = fetched.ok
		? fetched.data.filter((item) => item.result === "failed")
		: [];
	const problem =
		!fetched.ok || failed.length
			? `Automatic fetch failed${failed.length ? ` for ${failed.map((item) => item.name).join(", ")}` : ""}. Click Fetch remote to see why.`
			: "";
	// An action that waited for this fetch owns the status bar now.
	if (pending > 0 || !current) return;
	if (problem && problem !== lastFailure) say(problem);
	else if (comparable && moved.length)
		say(
			`Fetched automatically: new commits on ${[...new Set(moved.map((state) => baseRef(state.workspace)))].join(", ")}.`,
		);
	lastFailure = problem;
}
setInterval(autoFetch, 60 * 1000);

refresh();
