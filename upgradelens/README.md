# UpgradeLens

[![CI](https://github.com/AnandShah10/upgradelens/actions/workflows/ci.yml/badge.svg)](https://github.com/AnandShah10/upgradelens/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/github/license/AnandShah10/upgradelens)](LICENSE)
[![Issues](https://img.shields.io/github/issues/AnandShah10/upgradelens)](https://github.com/AnandShah10/upgradelens/issues)
[![Pull Requests](https://img.shields.io/github/issues-pr/AnandShah10/upgradelens)](https://github.com/AnandShah10/upgradelens/pulls)
[![Last Commit](https://img.shields.io/github/last-commit/AnandShah10/upgradelens)](https://github.com/AnandShah10/upgradelens/commits/main)
[![Stars](https://img.shields.io/github/stars/AnandShah10/upgradelens?style=social)](https://github.com/AnandShah10/upgradelens/stargazers)
[![PRs Welcome](https://img.shields.io/badge/PRs-welcome-brightgreen.svg)](CONTRIBUTING.md)

**Dependency Impact Simulator for VS Code.** Before you bump a version in
your project's manifest, UpgradeLens tells you what will probably happen to
*your* code if you do - for **JavaScript/TypeScript (npm, Yarn, pnpm, Bun)
Python (pip, Poetry, Pipenv), Rust (Cargo), Go modules, Maven, and Gradle projects alike**.

Not "there's a newer version available" - but:

> Upgrading `axios` from `1.7.2` → `2.0.0` is likely to affect **2 files**,
> with **1 breaking API change** and **1 deprecated usage**.

The analysis is entirely **read-only**: your manifest, lockfile, and source
files are never modified.

## What it does

1. Reads your project's manifest and lockfile. **npm, Yarn (classic and
   Berry), pnpm, and Bun are all auto-detected** on the JS/TS side; on the
   Python side, **pip (`requirements.txt`) and Poetry (`pyproject.toml` +
   `poetry.lock`), as well as PEP 621 native `pyproject.toml`**, are
   auto-detected too - all from whichever manifest/lockfile is present, so
   this works the same way regardless of which package manager or language
   your project uses. No changes are ever written back. If the project is
   a **workspaces monorepo** (npm/yarn `workspaces`, or pnpm's
   `pnpm-workspace.yaml`), member packages matched by the glob patterns are
   traversed too, so every dependency across every package is visible in
   one place.
2. Lets you pick a dependency and a target version (latest, latest major, or
   a specific version).
3. Scans your project's source for actual usage of that package - real
   `import`/`require`/dynamic-import usage for JS/TS (via a genuine
   AST/scope-aware parse, not text matching), and real `import`/
   `from ... import` usage for Python - not just "does this file mention
   it", but which symbols are imported *and actually referenced*. For
   Python, package names that differ from their import name (`Pillow` ->
   `PIL`, `beautifulsoup4` -> `bs4`) are resolved automatically.
4. Gathers evidence about what changed between the two versions from
   several independent, pluggable sources:
   - live **registry metadata** - the npm registry for JS/TS packages, the
     PyPI JSON API for Python packages (peer dependencies/`requires_python`,
     engine requirements, deprecation/yanked status, export surface),
   - **GitHub release notes**, when the package's repository is on GitHub -
     scanned for explicitly-flagged "BREAKING CHANGE" callouts and bulleted
     "Breaking Changes" sections (this evidence source works identically
     for either ecosystem),
   - **full cross-version TypeScript declaration diffing** (JS/TS projects
     only) - both published versions' tarballs are downloaded in memory (no
     disk writes, no installation) and their exported symbols are diffed
     directly, so "removed API" claims are checked against the *actual
     target version*, not just inferred,
   - a small curated **known-breaking-changes database** for popular
     JS/TS packages (react-router-dom, axios, express, lodash, ...) and
     Python packages (django, flask, numpy, pandas), as an explicit,
     honest fallback for the cases the sources above can't reach,
   - **locally installed TypeScript declarations** (JS/TS projects only),
     used as a fast, offline sanity check against what's actually present
     in `node_modules`.
5. Cross-checks any peer-dependency requirement change against what your
   project **actually has installed** (via a real semver-range check, not
   just "a peer changed") - a peer that's already satisfied is dropped from
   the report entirely; a genuine conflict is escalated to a high-confidence
   finding naming the exact installed version and the range it fails to
   satisfy.
6. Correlates all of that evidence against your project's real usage to
   produce a set of findings - each labeled **Confirmed** / **Likely** /
   **Potential** / **Unknown**, never presented as guaranteed breakage.
7. Scores an overall, explainable risk level (Critical/High/Medium/Low/Safe)
   with a plain-language "why" for every point on the scale.
8. Shows a report in a native-feeling Webview panel: summary cards, an
   impact bar, expandable findings (with a link to the source GitHub release
   when that's where the evidence came from), a clickable affected-files
   list, and a copyable migration checklist.

## Commands

| Command | What it does |
|---|---|
| **UpgradeLens: Simulate Upgrade** | Pick a dependency + target version, run a full simulation. |
| **UpgradeLens: Analyze Current Dependencies** | Lists every dependency with its current vs. latest published version; pick one to simulate. |
| **UpgradeLens: Refresh Analysis** | Re-runs whatever simulation produced the currently open report. |
| **UpgradeLens: Run Demo Simulation** | Runs the full pipeline against a bundled fixture (`demo-package` 1.4.0 → 2.0.0) - no project required, useful for seeing the UI immediately. |

All commands are also available from the Command Palette, and "Simulate
Upgrade" is available from the right-click menu on `package.json` (Explorer
and editor).

## Settings

| Setting | Default | Description |
|---|---|---|
| `upgradeLens.enableChangelogAnalysis` | `true` | Query the npm registry for version metadata. Disable for a fully offline pass. Also gates GitHub release scanning. |
| `upgradeLens.enableGitHubReleaseAnalysis` | `true` | When the package's repository is on GitHub, scan its tagged releases for explicitly-flagged breaking changes. No effect if Enable Changelog Analysis is disabled. |
| `upgradeLens.enableTypeAnalysis` | `true` | Cross-check claims against locally installed TypeScript declarations, and (network permitting) diff the two published versions' declaration files directly. |
| `upgradeLens.maxFiles` | `5000` | Cap on the number of project files scanned per analysis. |
| `upgradeLens.registryUrl` | `https://registry.npmjs.org` | Registry base URL (useful for private/mirrored registries). |

## Running it

```bash
npm install
npm run compile
```

Then open this folder in VS Code and press **F5** (or run the "Run
UpgradeLens" launch configuration) to start an Extension Development Host
with the extension loaded. Open any folder containing a `package.json` in
that window and run **UpgradeLens: Simulate Upgrade** from the Command
Palette (`Cmd/Ctrl+Shift+P`).

To try it without opening a project at all, run **UpgradeLens: Run Demo
Simulation**.

### Tests

```bash
npm test
```

Runs the unit test suite via Node's built-in test runner - no extra test
framework dependency. Coverage includes: semver classification and range
satisfaction, AST/scope-aware usage detection for JS/TS (aliased/namespace/
destructured imports, multi-line formatting, real shadow detection across
nested functions, parameters, blocks, catch clauses, for-loops, and nested
interface/type/enum declarations, plus cross-file "barrel file" re-export
resolution including transitive chains, star re-exports, cycle detection,
and depth limits), AST/scope-aware usage detection for Python via web-tree-sitter
(real lexical shadowing across function parameters, nested defs, for/with/
except targets, comprehensions; namespace member-access resolution;
PyPI-to-import-name mapping), impact correlation, risk scoring,
webview message validation, workspace aggregation (against real temp
directories), peer-dependency conflict enrichment, GitHub release-note and
CHANGELOG.md parsing, the from-scratch tar/gzip reader including PAX
extended headers (against synthetic tarballs), cross-version type-
declaration diffing (against a fake package manager + injected fetcher, no
real network calls), yarn.lock (classic and Berry) / pnpm-lock.yaml /
bun.lock / requirements.txt / pyproject.toml (PEP 621 and Poetry) /
poetry.lock parsing, package-manager/ecosystem auto-detection, and
end-to-end demo-scenario tests for both ecosystems.

### Lint

```bash
npm run lint
```

Runs ESLint (`@typescript-eslint`) over `src/`.

### Packaging

```bash
npm run package
```

Requires `vsce` (`npm i -g @vscode/vsce`) - produces a `.vsix` you can
install via **Extensions: Install from VSIX...**.

## WASM / size

Tree-sitter grammars for Python, Rust, Go, and Java ship under
`resources/tree-sitter/` (~2.3MB combined). Each grammar is loaded **only
when that language is analyzed**; activation does not pay the cost up front.

## Safety

- **Read-only by default.** The extension never writes to `package.json`,
  `package-lock.json`, or any project source file, and never runs `npm
  install` or any package lifecycle script in your project.
- **No source code leaves your machine.** Analysis runs entirely locally.
  Network calls are: npm registry metadata lookups (package name + version
  numbers), optional GitHub release-notes fetches (same), and optional
  in-memory tarball downloads for type diffing (official npm registry
  tarball URLs only) - never your project's own source.
- **Tarball downloads never touch disk.** The gzip/tar reader used for
  cross-version type diffing decompresses and parses entirely in memory;
  nothing is extracted to a temp directory or left behind.
- **Degrades gracefully offline.** If the registry is unreachable, you still
  get usage-scan and locally-known-changes results, clearly labeled as a
  partial/offline analysis rather than a failure. Every additional evidence
  source (GitHub, deep type diffing) is independently best-effort and never
  fails the overall analysis if it can't be reached.

## Architecture

```
src/
├── extension.ts              Activation & command wiring
├── commands/                 QuickPick flows for each command
├── analysis/
│   ├── SemverUtil.ts          Version parsing, classification, range satisfaction
│   ├── UsageAnalyzer.ts       AST/scope-aware import/require/dynamic-import usage detection (JS/TS)
│   ├── PythonUsageAnalyzer.ts AST/scope-aware import/usage detection (Python, web-tree-sitter)
│   ├── pythonCommentStringMasker.ts  Comment/string masking for Python (f-string aware)
│   ├── pythonImportNameMap.ts PyPI package name -> Python import name mapping
│   ├── ReExportResolver.ts    Cross-file "barrel file" re-export chain resolution (JS/TS)
│   ├── scriptKind.ts          Shared file-extension -> ts.ScriptKind helper
│   ├── ApiAnalyzer.ts         Local installed-types symbol lookup (fast path, JS/TS)
│   ├── dtsExportExtractor.ts  Shared .d.ts export-name extraction
│   ├── TypeDeclarationDiffer.ts  Downloads + diffs two versions' published types (JS/TS)
│   ├── ImpactEngine.ts        Correlates package changes with real usage
│   ├── RiskScorer.ts          Deterministic, explainable risk scoring
│   ├── PeerDependencyAnalyzer.ts  Real peer-conflict detection against installed versions
│   └── DependencyAnalyzer.ts  Manifest + workspace-aware dependency resolution
├── package/
│   ├── PackageManager.ts       Shared interface (readManifest/getVersionMetadata/listVersions)
│   ├── NpmRegistryClient.ts    Shared npm registry HTTP client (used by all 4 JS/TS managers)
│   ├── manifestUtils.ts        Shared package.json + workspace glob expansion
│   ├── NpmPackageManager.ts    package-lock.json parsing
│   ├── YarnPackageManager.ts   Classic (v1) and Berry (v2+) yarn.lock parsing
│   ├── PnpmPackageManager.ts   pnpm-lock.yaml parsing (via js-yaml) + pnpm-workspace.yaml
│   ├── BunPackageManager.ts    Text bun.lock (JSONC) parsing
│   ├── PyPiRegistryClient.ts   PyPI JSON API client (Python/PyPI's NpmRegistryClient equivalent)
│   ├── PyPiPackageManager.ts   requirements.txt + pyproject.toml (PEP 621/Poetry) + poetry.lock
│   ├── pythonRequirementParser.ts  Shared PEP 508 requirement-string parsing
│   ├── requirementsTxtParser.ts    requirements.txt line parsing
│   ├── pyprojectTomlParser.ts      pyproject.toml dependency extraction
│   ├── poetryLockParser.ts         poetry.lock resolved-version extraction
│   └── PackageManagerFactory.ts  Detects which of the above (incl. ecosystem) to use per project
├── changelog/                 PackageChangeProvider implementations:
│                              registry metadata, GitHub releases + CHANGELOG.md fallback,
│                              known-changes DB, type-diff-backed changes, demo fixture
├── models/                    Shared TypeScript interfaces
├── services/                  SimulationService (ecosystem-aware orchestrator), CacheService,
│                              WorkspaceService (ecosystem-aware source-file globbing)
├── ui/                        ImpactPanel (webview host) + webview assets
├── utils/                     HTTP helpers (JSON + raw buffer), the in-memory
│                              gzip/tar reader, error-message mapping
└── test/                      Unit tests + demo fixture project
```

`PackageManager` is a shared interface with implementations spanning two
ecosystems - npm/Yarn/pnpm/Bun (JS/TS) and PyPI (Python) - that reuse a
shared registry client per ecosystem and manifest-reading helpers where the
formats overlap. `SimulationService` detects the right ecosystem per
project (`PackageManagerFactory.detect`) and picks the matching usage
analyzer, source-file glob, and registry accordingly; JS/TS-only evidence
(deep type-declaration diffing) is skipped entirely for Python projects
rather than attempted and silently finding nothing.
`PackageChangeProvider` is the same kind of seam: every evidence source
(registry, GitHub, known-changes DB, type diffing, demo fixture) implements
it identically, so adding another source never requires touching
`ImpactEngine` or `RiskScorer`.

## Known limitations (by design)

- Import/usage detection is real AST/lexical-scope analysis, built on the
  TypeScript compiler's own parser (`ts.createSourceFile`) - see
  `UsageAnalyzer.ts`. It parses each file (not a full type-checked
  `ts.Program`, which would require resolving the entire module graph -
  exactly the unbounded cost the "must not freeze VS Code" requirement
  rules out) and does real scope tracking, so a local variable, parameter,
  or nested `interface`/`type`/`enum` that shadows an imported name
  (`function f(oldApi) { oldApi.toString(); }`) is correctly excluded from
  usage, while a reference at module scope, in an arrow function, in a
  shorthand object property, or inside a template-literal interpolation
  (`` `${oldApi()}` ``) is correctly included.
- Usage is also traced across a project's own "barrel file" re-exports:
  if `./api-client.ts` does `export { oldApi } from "some-package"` and
  another file does `import { oldApi } from "./api-client"`, that's
  correctly recognized as real usage of `some-package`, following chains
  of `export { x } from` / `export * from` up to 6 hops deep with cycle
  detection (see `ReExportResolver.ts`).
- A namespace import of the target package - whether directly
  (`import * as pkg from "some-package"; pkg.oldApi()`) or through a local
  barrel that re-exports it (`import * as api from "./api-client";
  api.oldApi()`, where `./api-client` does `export { oldApi } from
  "some-package"` or `export * from "some-package"`) - is resolved to the
  *specific member* accessed, exactly as a named import would be. A bare
  reference to the namespace itself with no `.member` access, and a case
  where the namespace binding is shadowed by a same-named local, are both
  still handled correctly in either case.
- What remains unhandled: without full type information, an artificial
  same-named ambient global could still be mistaken for an import in a
  contrived scenario, and a name that's both a type and a value merged
  through re-exports across files (rather than shadowed locally, which
  *is* handled) isn't distinguished at the type/value-namespace level.
  Both are narrow edge cases next to what real scope tracking, direct
  namespace-member resolution, and cross-file re-export resolution now
  correctly rule out.
- The in-memory tar reader supports plain ustar-format npm tarballs and PAX
  extended headers (used for file paths beyond the classic 100-byte name
  field) - it does not handle the older GNU long-name extension mechanism,
  which npm's own tarball creation doesn't use anyway.
- GitHub-sourced evidence checks tagged Releases first, then falls back to
  the repository's CHANGELOG.md/CHANGES.md/HISTORY.md file - but still
  depends on a recognizable "BREAKING CHANGE" convention somewhere in one
  of those two places. A maintainer who documents breaking changes only in
  prose, only on a wiki, or only in commit messages won't surface anything
  from this source, though every other source still runs.
- The known-breaking-changes database covers a deliberately curated set of
  very widely-used packages - JS/TS (react-router-dom, axios, lodash,
  express, react-dom, vue, webpack, eslint, jest, node-fetch, chalk, uuid,
  mongoose, next) and Python (django, flask, numpy, pandas) - as an
  explicit, honest fallback. It's additive and trivially extended, not a
  substitute for the registry-metadata, GitHub, and type-diffing evidence
  that drives most findings, and it will never cover every package in
  either ecosystem.
- Yarn support parses both the classic (Yarn 1.x) `yarn.lock` format and
  Yarn Berry (v2+)'s YAML-based format (identified by a `__metadata:` key),
  resolving `npm:`-protocol descriptors to their locked versions.
  `workspace:`/`patch:`/`portal:` protocol entries point at local paths or
  patched variants rather than a plain published version and aren't
  resolved from the lockfile - the same declared-range fallback any
  package manager uses when a lockfile can't supply an exact version.
- Bun support parses text `bun.lock` (JSONC) and binary `bun.lockb` (via
  `@hyrious/bun.lockb`, translated from Bun's Zig serializer, with a
  string-pool heuristic fallback). Prefer text `bun.lock` when both exist.
- **Python usage detection (`PythonUsageAnalyzer`) is AST/scope-aware** via
  web-tree-sitter and the official tree-sitter-python WASM grammar (~660KB
  of runtime files under `resources/tree-sitter/`). Real lexical shadowing
  is handled the same way as the JS/TS analyzer: a parameter, for/with
  target, nested def, or local assignment that shares a name with an
  imported binding is correctly *not* counted as package usage. Comments,
  strings, and docstrings never register as usage; a real call inside an
  f-string interpolation still does. Cross-file re-exports through
  `__init__.py` (and intermediate modules) are followed via
  `PythonReExportResolver`, with the same depth/cycle bounds as JS/TS
  barrel resolution. Static PEP 562 `__getattr__` patterns that forward
  to a third-party package are detected without executing Python.
  **Remaining limits:** fully dynamic `__getattr__` bodies still cannot
  be resolved; true ambient globals still need a type checker.
- PyPI package names that don't match their Python import name are resolved
  via a small curated table (`Pillow` -> `PIL`, `beautifulsoup4` -> `bs4`,
  etc.) plus a normalization fallback (hyphens/dots to underscores, which
  correctly handles the majority of "ordinary" packages with no exception
  needed) - not a lookup against the package's real distributed file list,
  so an unusual mismatch outside the curated table could still be missed.
- Python manifest support covers `requirements.txt`, `pyproject.toml`
  (both PEP 621 native and Poetry styles, with `poetry.lock` for resolved
  versions), and **Pipfile / Pipfile.lock**. The still-emerging PEP 665 /
  pylock.toml standard is not parsed yet.

## Contributing

Issues and pull requests are welcome. See [CONTRIBUTING.md](CONTRIBUTING.md)
for how to get set up, [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md) for
community expectations, and [SECURITY.md](SECURITY.md) for how to report a
vulnerability privately. Release history lives in [CHANGELOG.md](CHANGELOG.md).

---

Made with ❤️ by [Anand Shah](https://github.com/AnandShah10) for the developer community.

