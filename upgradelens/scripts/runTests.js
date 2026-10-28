// Portable test runner. `node --test <glob>` behaves differently depending on
// (a) whether the shell expands the glob (bash's globstar is OFF by default, so
// `**` is passed through literally) and (b) which Node version receives the
// literal pattern (only newer Node versions expand globs themselves). Rather
// than depend on either, this script enumerates the compiled test files
// explicitly and hands Node a plain list of paths - identical behavior on
// Node 18/20/22 and on Linux, macOS, and Windows.
const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");

const testRoot = path.join(__dirname, "..", "out", "test");

function findTestFiles(dir) {
  const results = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "fixtures") continue; // sample project files, not tests
      results.push(...findTestFiles(full));
    } else if (entry.name.endsWith(".test.js")) {
      results.push(full);
    }
  }
  return results.sort();
}

if (!fs.existsSync(testRoot)) {
  console.error(`No compiled tests found at ${testRoot}. Run "npm run compile" first.`);
  process.exit(1);
}

const files = findTestFiles(testRoot);
if (files.length === 0) {
  console.error(`No *.test.js files found under ${testRoot}.`);
  process.exit(1);
}

const result = spawnSync(process.execPath, ["--test", ...files], { stdio: "inherit" });
process.exit(result.status ?? 1);
