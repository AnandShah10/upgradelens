import assert from "node:assert/strict";
import { test } from "node:test";
import { extractBreakingLines, parseRepoFromUrl, splitChangelogByVersion } from "../changelog/GitHubChangeProvider";

test("parseRepoFromUrl extracts owner/repo from a plain GitHub URL", () => {
  assert.deepEqual(parseRepoFromUrl("https://github.com/remix-run/react-router"), {
    owner: "remix-run",
    repo: "react-router",
  });
});

test("parseRepoFromUrl strips a trailing .git suffix", () => {
  assert.deepEqual(parseRepoFromUrl("https://github.com/axios/axios.git"), { owner: "axios", repo: "axios" });
});

test("parseRepoFromUrl returns null for non-GitHub URLs", () => {
  assert.equal(parseRepoFromUrl("https://gitlab.com/foo/bar"), null);
  assert.equal(parseRepoFromUrl(undefined), null);
});

test("extractBreakingLines finds inline BREAKING CHANGE callouts", () => {
  const body = "This release adds features.\n\nBREAKING CHANGE: removed the legacy client export.\n";
  const lines = extractBreakingLines(body);
  assert.ok(lines.some((l) => l.includes("removed the legacy client export")));
});

test("extractBreakingLines finds bullets under a 'Breaking Changes' heading", () => {
  const body = "## Breaking Changes\n- Removed `oldApi()`\n- Renamed `Client` to `HttpClient`\n\n## Features\n- Added retries\n";
  const lines = extractBreakingLines(body);
  assert.ok(lines.some((l) => l.includes("Removed `oldApi()`")));
  assert.ok(lines.some((l) => l.includes("Renamed `Client`")));
  assert.ok(!lines.some((l) => l.includes("Added retries")));
});

test("extractBreakingLines returns an empty array when nothing is flagged", () => {
  const body = "Just a regular release with some fixes and features.";
  assert.deepEqual(extractBreakingLines(body), []);
});

test("extractBreakingLines caps and de-dupes results", () => {
  const body = Array.from({ length: 20 }, (_, i) => `BREAKING CHANGE: change number ${i}`).join("\n");
  const lines = extractBreakingLines(body);
  assert.ok(lines.length <= 8);
});

test("splitChangelogByVersion divides a changelog into per-version sections", () => {
  const changelog = `# Changelog

## [2.0.0] - 2024-03-01
### Breaking Changes
- Removed \`oldApi()\`

## [1.5.0] - 2024-01-01
### Features
- Added retries
`;
  const sections = splitChangelogByVersion(changelog);
  assert.equal(sections.length, 2);
  assert.equal(sections[0].version, "2.0.0");
  assert.ok(sections[0].section.includes("Removed `oldApi()`"));
  assert.equal(sections[1].version, "1.5.0");
  assert.ok(!sections[1].section.includes("oldApi"));
});

test("splitChangelogByVersion handles plain '# X.Y.Z' headings without brackets", () => {
  const changelog = `# 3.0.0\nBREAKING CHANGE: dropped Node 16 support\n\n# 2.9.0\nMinor fixes\n`;
  const sections = splitChangelogByVersion(changelog);
  assert.equal(sections[0].version, "3.0.0");
  assert.equal(sections[1].version, "2.9.0");
});

test("splitChangelogByVersion returns nothing for a changelog with no recognizable version headings", () => {
  assert.deepEqual(splitChangelogByVersion("Just some prose, no headings here."), []);
});
