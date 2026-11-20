// Plain-language text for the reason codes the core attaches to sync results.
// tests/labels.spec.ts fails when the core adds a reason that is missing here.
export const reasons = {
	"base-branch": "on the base branch",
	"base-became-checked-out": "it was checked out during sync",
	"base-checked-out-in-another-worktree": "checked out in another worktree",
	"base-has-local-commits": "local base has its own commits",
	"base-not-fetched": "base not fetched yet",
	"contains-base": "already contains the base",
	"detached-head": "detached HEAD",
	"explicit-rebase-request": "rebase requested",
	"git-operation-in-progress": "a Git operation is in progress",
	"handled-by-checkout": "handled by the checkout",
	"inspection-or-lock-failed": "could not inspect or lock it",
	leased: "in use by someone else (leased)",
	"local-base-current": "local base is current",
	"local-base-missing": "no local base branch",
	"published-or-merge-branch": "published or contains merges",
	"rebase-not-enabled": "rebase is off",
	"uncommitted-changes": "uncommitted changes",
	"unrelated-histories": "unrelated histories",
	"fetch-failed": "fetching the base branch failed",
	"local-files-in-the-way":
		"the update adds files that already exist locally (for example an ignored .env); move them aside first",
	"unused-local-base": "unused local base",
	"workspace-busy": "uncommitted changes or a Git operation in progress",
	"workspace-changed": "it changed during sync",
};
