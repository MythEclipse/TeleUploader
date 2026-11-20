// Semver bump driven by the commits about to be pushed.
//
// PORTED FROM 9router (`scripts/bump-version.mjs`). The mechanism is identical on
// purpose — one local hook decides the version, commits it, and every tracked
// manifest moves together — because CI-owned versioning had two defects here:
//
//   1. DRIFT. `.semrel/prepare.mjs` bumped ONLY the root `package.json`, so after
//      1.12.19 the root said 1.12.19 while `apps/api` and `apps/web` were still
//      frozen on 1.2.9. 9router's script carries a comment about exactly this
//      ("Bumping only the root left apps/web on 4.2.0 for the whole 5.x line, and
//      the dashboard read that file"). This file writes every manifest that has a
//      version, so the three can never disagree again.
//   2. INVISIBILITY. The version was derived inside GitHub Actions, so nothing on
//      the workstation could tell you what the next release would be, and a
//      release that produced no version looked the same as one that failed. The
//      bump now happens in `pre-push`, where you can see it.
//
// RULES, in precedence order:
//   1. a `BREAKING CHANGE:` footer or a `type!:` subject -> major
//   2. any `feat:` commit in the push range               -> minor
//   3. otherwise                                          -> patch
//
// That is the CONVENTIONAL mapping, and it is deliberately NOT 9router's
// ("any feat: -> major"). 9router is at 25.0.0 because of its rule; this repo is
// at 1.12.x and its published image tags follow feat->minor, so copying the rule
// verbatim would publish 2.0.0 for the next feature commit and silently claim a
// compatibility break that never happened. If the 9router rule is wanted after
// all, it is the single line in `bumpKind()`.
//
// Run manually (`pnpm run bump`) and by the lefthook pre-push hook. Safe to
// re-run: when the newest commit already carries exactly the bump this range
// asks for, the script exits 0 instead of bumping a second time.
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** The commit message the bumped version must be committed under. */
const BUMP_SUBJECT = "chore: adjust package.json version (bump)";
const BLOCK_PUSH_AFTER_BUMP = process.argv.includes("--block-push-after-bump");

/** Run git, returning stdout, or "" when the command fails. */
function git(args) {
	try {
		return execFileSync("git", args, {
			cwd: projectRoot,
			encoding: "utf8",
			stdio: ["ignore", "pipe", "ignore"],
		}).trim();
	} catch {
		return "";
	}
}

/** Resolve the remote-tracking ref this branch pushes to. */
function upstreamRef(branch) {
	const configured = git([
		"rev-parse",
		"--abbrev-ref",
		"--symbolic-full-name",
		`${branch}@{upstream}`,
	]);
	if (configured) return configured;
	return `origin/${branch}`;
}

/** Full commit messages (subject + body) in the push range, oldest first. */
function pendingMessages(base, branch) {
	const range = base ? `${base}...${branch}` : branch;
	return git(["log", "--format=%B%x00", range])
		.split("\x00")
		.map((message) => message.trim())
		.filter(Boolean);
}

/** Subject lines of the commits in the push range, oldest first. */
function pendingSubjects(base, branch) {
	const range = base ? `${base}...${branch}` : branch;
	return git(["log", "--format=%s", range])
		.split("\n")
		.map((line) => line.trim())
		.filter(Boolean);
}

/** Repo-relative paths touched in the push range. */
function pendingFiles(base, branch) {
	const range = base ? `${base}...${branch}` : branch;
	return git(["diff", "--name-only", range])
		.split("\n")
		.map((line) => line.trim())
		.filter(Boolean);
}

/** Read a manifest by its repo-relative path. */
function readManifest(file) {
	return JSON.parse(readFileSync(resolve(projectRoot, file), "utf8"));
}

/**
 * Every tracked manifest that carries a version, root first.
 *
 * `git ls-files` is the source rather than a glob: it lists tracked files only,
 * so node_modules and build output can never enter the sweep.
 */
function versionedManifests() {
	const manifests = git(["ls-files"])
		.split("\n")
		.filter((file) => file === "package.json" || file.endsWith("/package.json"))
		.filter((file) => typeof readManifest(file).version === "string");
	return manifests.sort((a, b) =>
		a === "package.json" ? -1 : b === "package.json" ? 1 : a.localeCompare(b)
	);
}

/** Write `version` into one manifest without reformatting the rest of it. */
function writeVersion(file, version) {
	const path = resolve(projectRoot, file);
	const original = readFileSync(path, "utf8");
	const pkg = JSON.parse(original);
	if (pkg.version === version) return false;
	// A bump commit that also reformats a manifest hides the one number it was
	// supposed to change. Refuse rather than produce that diff.
	if (`${JSON.stringify(pkg, null, 2)}\n` !== original) {
		throw new Error(`${file} is not canonical 2-space JSON — format it before bumping`);
	}
	pkg.version = version;
	writeFileSync(path, `${JSON.stringify(pkg, null, 2)}\n`);
	return true;
}

/**
 * Decide the bump kind from the push range.
 *
 * @param messages - Full commit messages (bodies included, for the footer).
 * @returns `"major"`, `"minor"` or `"patch"`.
 */
function bumpKind(messages) {
	// A `BREAKING CHANGE:` / `BREAKING-CHANGE:` footer, or a `type!:` subject.
	// The footer is matched anywhere in the body because that is where the
	// convention puts it; the `!` is matched only in the subject position so a
	// `!` inside prose cannot trigger a major release.
	if (messages.some((message) => /(^|\n)BREAKING[ -]CHANGE:/.test(message))) return "major";
	if (messages.some((message) => /^[a-z]+(\([^)]*\))?!:/.test(message.split("\n")[0] ?? ""))) {
		return "major";
	}
	if (messages.some((message) => /^feat(\([^)]*\))?:/.test(message.split("\n")[0] ?? ""))) {
		return "minor";
	}
	return "patch";
}

function nextVersion(current, kind) {
	const [major, minor, patch] = current.split(".").map(Number);
	if ([major, minor, patch].some((part) => Number.isNaN(part))) {
		throw new Error(`Unparsable version in package.json: ${current}`);
	}
	if (kind === "major") return `${major + 1}.0.0`;
	if (kind === "minor") return `${major}.${minor + 1}.0`;
	return `${major}.${minor}.${patch + 1}`;
}

/**
 * True when HEAD is the bump commit for this very range — same message, and the
 * only files it touched are the manifests the bump owns. Anything else (a real
 * commit stacked on top, or a bump that also carried edits) means the range has
 * grown since the last bump and owes a new one.
 *
 * This cannot compare against `target`: that value is derived from the current
 * version, so it is never equal to it.
 */
function bumpAlreadyApplied(branch, manifests) {
	if (git(["log", "-1", "--format=%s", branch]) !== BUMP_SUBJECT) return false;
	return git(["diff-tree", "--no-commit-id", "--name-only", "-r", "HEAD", branch])
		.split("\n")
		.filter(Boolean)
		.every((file) => manifests.includes(file));
}

function main() {
	const manifests = versionedManifests();
	const current = readManifest("package.json").version;

	const branch = git(["rev-parse", "--abbrev-ref", "HEAD"]);
	if (!branch || branch === "HEAD") {
		console.error("[bump] Detached HEAD — cannot determine what is being pushed. Skipping.");
		process.exit(0);
	}

	const base = upstreamRef(branch);
	if (!git(["rev-parse", "--verify", "--quiet", base])) {
		// The branch has never been pushed. There is no range to compare against, so
		// any bump here would be guessed from the entire history. Nothing to do.
		console.log(`[bump] No upstream ${base} yet - first push of this branch. Skipping.`);
		return;
	}

	const messages = pendingMessages(base, branch);
	const subjects = pendingSubjects(base, branch);
	const files = pendingFiles(base, branch);
	const kind = bumpKind(messages);

	// Re-bumping an already-bumped range would skip a release number, and the
	// pre-push hook always runs after the bump commit was made.
	if (bumpAlreadyApplied(branch, manifests)) {
		console.log(
			`[bump] HEAD is already the bump commit for this range (${subjects.length} pending commit(s), ${files.length} changed file(s) vs ${base}). No change.`
		);
		return;
	}

	const target = nextVersion(current, kind);
	const written = manifests.filter((file) => writeVersion(file, target));

	console.log(
		`[bump] ${current} -> ${target} (${kind}) — ${written.length}/${manifests.length} manifest(s)`
	);
	for (const file of written) console.log(`[bump]   ${file}`);
	console.log(`[bump] ${subjects.length} pending commit(s), ${files.length} changed file(s) vs ${base}`);
	for (const subject of subjects) console.log(`[bump]   - ${subject}`);

	// Commit it here rather than printing an instruction. The hook runs on
	// pre-push: the push is already in flight, so a version left in the working
	// tree ships as the OLD number and stays behind as dirt that the next push
	// bumps again from the stale base. An unstaged bump is an unshipped bump.
	execFileSync("git", ["add", ...manifests], {
		cwd: projectRoot,
		stdio: ["ignore", "ignore", "inherit"],
	});
	execFileSync("git", ["commit", "-m", BUMP_SUBJECT, "--no-verify"], {
		cwd: projectRoot,
		stdio: ["ignore", "ignore", "inherit"],
	});
	console.log(`[bump] Committed ${target} as "${BUMP_SUBJECT}".`);

	// Tag the bump commit, locally. This is the ONE deliberate difference from
	// 9router, and it exists because of what this repo has that 9router's bump
	// script does not know about: a GHCR image lane keyed on `v*` tags. Without a
	// tag there is nothing for release.yml to build, so removing semantic-release
	// would silently kill image publishing.
	//
	// Annotated, not lightweight: `git describe` needs the tag object to name the
	// release, and the message is what shows up in `git tag -n`.
	//
	// Idempotent on purpose. A re-run after a stopped push must not fail because
	// the tag it just created is still there.
	if (!git(["rev-parse", "--verify", "--quiet", `refs/tags/v${target}`])) {
		execFileSync("git", ["tag", "-a", `v${target}`, "-m", `v${target}`], {
			cwd: projectRoot,
			stdio: ["ignore", "ignore", "inherit"],
		});
		console.log(`[bump] Tagged v${target}. Push it with \`git push --follow-tags\` to publish.`);
	}

	if (BLOCK_PUSH_AFTER_BUMP) {
		console.error(
			"[bump] Version bump committed. Push stopped once so the bump commit is included on the next push."
		);
		process.exitCode = 1;
	}
}

main();
