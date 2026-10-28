// Plain Node script (no build-tool dependency) that copies the webview's
// static assets alongside the compiled JS output, since tsc only emits
// .ts files and ignores .html/.css/.js siblings.
const fs = require("fs");
const path = require("path");

const srcDir = path.join(__dirname, "..", "src", "ui", "webview");
const outDir = path.join(__dirname, "..", "out", "ui", "webview");

fs.mkdirSync(outDir, { recursive: true });

for (const file of ["index.html", "styles.css", "app.js"]) {
  fs.copyFileSync(path.join(srcDir, file), path.join(outDir, file));
}

// Test fixtures (plain .ts/.tsx/.json sample files, intentionally excluded
// from the tsc build since they reference a package that doesn't exist)
// need to sit alongside the compiled test files too.
function copyDir(from, to) {
  fs.mkdirSync(to, { recursive: true });
  for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
    const src = path.join(from, entry.name);
    const dest = path.join(to, entry.name);
    if (entry.isDirectory()) copyDir(src, dest);
    else fs.copyFileSync(src, dest);
  }
}
const fixturesSrc = path.join(__dirname, "..", "src", "test", "fixtures");
const fixturesOut = path.join(__dirname, "..", "out", "test", "fixtures");
if (fs.existsSync(fixturesSrc)) copyDir(fixturesSrc, fixturesOut);

console.log(`UpgradeLens: copied webview assets to ${outDir}`);
console.log(`UpgradeLens: copied test fixtures to ${fixturesOut}`);
