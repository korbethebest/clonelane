// Prints the GitHub release notes for one version: the install line, then that version's
// CHANGELOG.md section. Usage: node .github/release-notes.mjs 0.8.0
import { readFileSync } from "node:fs";

const version = process.argv[2]?.replace(/^v/, "");
if (!version || !/^\d+\.\d+\.\d+$/.test(version)) {
	console.error("usage: release-notes.mjs <version>");
	process.exit(1);
}
const changelog = readFileSync(
	new URL("../CHANGELOG.md", import.meta.url),
	"utf8",
);
const start = changelog.indexOf(`\n## [${version}] - `);
if (start < 0) {
	console.error(`CHANGELOG.md has no section for ${version}`);
	process.exit(1);
}
const body = changelog.slice(changelog.indexOf("\n", start + 1) + 1);
const end = body.search(/^## \[|^\[[^\]]+\]: /m);
console.log(
	`Install with \`npm install --global clonelane\` or try it with \`npx clonelane --help\`. Requires Node.js 24+ and Git 2.38+.\n\n${(end < 0 ? body : body.slice(0, end)).trim()}`,
);
