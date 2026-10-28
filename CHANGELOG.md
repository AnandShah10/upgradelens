# Changelog

All notable changes to the "UpgradeLens" extension will be documented in this file.

## [0.1.7]

### Fixed / polish
- Removed leftover `PythonUsageAnalyzer.ts.bak`.
- Clarified `SimpleUsageAnalyzer` as regex **fallback** (tree-sitter owns shadowing).
- Marketplace description and keywords now cover all ecosystems, not only npm.
- **Cargo workspaces** (`[workspace].members`, including `crates/*` globs).
- **Go workspaces** (`go.work` + multi-module `go.sum` merge).
- **Maven multi-module** aggregation via `<modules>`.
- Kotlin (`.kt`) uses the Java import scanner path explicitly.
- Unit tests for tree-sitter usage, Cargo/Go/Maven managers, type-position filtering.

### Notes
- Tree-sitter WASM grammars (~2.3MB total) load **lazily on first analysis**
  of that language; they are not parsed at extension activation.

## [0.1.6]

### Added
- **Full `bun.lockb` parsing** via `@hyrious/bun.lockb` (Bun Zig serializer → yarn.lock v1), with heuristic fallback.
- **Type-position filtering** in JS/TS usage analysis: identifiers used only as types no longer count as runtime usage (reduces ambient-global / type-value-merge false positives).
- **Static `__getattr__` re-export detection** for Python (PEP 562 patterns without executing code).
- **Tree-sitter AST/scope analysis for Rust, Go, and Java** (WASM grammars under `resources/tree-sitter/`), with regex fallback.
- **Gradle version catalogs** (`gradle/libs.versions.toml`) and `libs.xxx` reference resolution.

## [0.1.5]

### Added
- **Gradle** support (`build.gradle` / `build.gradle.kts`) via the JVM package
  manager — pure-Gradle projects are detected without a pom.xml.
- **Best-effort `bun.lockb` version extraction**: scans the binary string pool
  for `name@version` tokens so lockfile-exact pins are recovered when only the
  legacy binary lockfile is present (text `bun.lock` still preferred).
- Stronger **Rust / Go / Java usage detection**: comment/string masking,
  braced Rust imports, parenthesized Go import blocks, static Java imports.

### Notes
- Full binary schema parsing for `bun.lockb` is still not claimed; the
  heuristic is conservative and may miss some transitive pins.
- Rust/Go/Java still lack lexical scope/shadow analysis.
- Ambient-global and type/value-merge edge cases still require a type checker.

## [0.1.4]

### Added
- **Python `__init__.py` re-export tracing** (`PythonReExportResolver`): follows
  relative and project-local absolute re-exports to third-party packages,
  with the same depth/cycle bounds as JS/TS barrel resolution.
- **Pipfile / Pipfile.lock** parsing for Python projects.
- **Expanded known-breaking-changes database** (rxjs, date-fns, zod, socket.io,
  redux, react-query, @tanstack/react-query, moment, styled-components,
  requests, scipy, sqlalchemy, pydantic, fastapi, pillow, scikit-learn).
- **Rust (Cargo), Go modules, and Maven** package managers: manifest/lock
  reading, registry metadata, and regex-based usage detection (`SimpleUsageAnalyzer`).
  These plug into the same impact/risk pipeline as npm and PyPI.

### Notes
- Binary `bun.lockb` remains unparsed (text `bun.lock` is supported).
- Ambient-global and type/value-merge edge cases still require a full type
  checker and are intentionally out of scope for the lexical analyzers.
- Rust/Go/Java usage detection is regex-based (no full AST/scope analysis yet).

## [0.1.3]

### Changed
- **Python usage detection is now AST/scope-aware.** `PythonUsageAnalyzer`
  uses web-tree-sitter plus the official tree-sitter-python WASM grammar
  (~660KB under `resources/tree-sitter/`) instead of regex/text matching.
  Real lexical shadowing is handled: a function parameter, for/with target,
  nested def, except handler, or local assignment that shares a name with
  an imported binding is no longer miscounted as package usage. `analyzeSource`
  is async (parser init is lazy and shared across files). SimulationService
  and the unit tests were updated to match.

### Fixed
- False-positive usage counts when a local binding shadows an imported name
  (e.g. `def f(requests): requests.get(...)`).

## [0.1.2]

### Fixed
- CI/`npm test` reliability: the `test` script used a `node --test
  out/test/**/*.test.js` glob that depends on bash's `globstar` option (off
  by default) to expand recursively - since it didn't expand, the literal,
  unexpanded string was passed straight to Node, and whether that
  "happened" to work depended entirely on which Node version received it.
  This passed locally (Node 22) but failed in CI (Node 18.x/20.x) with
  "Could not find ... out/test/\*\*/\*.test.js". Replaced with
  `scripts/runTests.js`, which enumerates compiled test files directly and
  passes explicit paths to `node --test` - verified identical (235/235
  passing) under a strict non-interactive bash with `globstar` off, on
  Node 18.x, 20.x, and 22.x.

## [0.1.1]

### Added
- **Python/PyPI support**, UpgradeLens' first non-JS/TS ecosystem:
  - `PyPiPackageManager`/`PyPiRegistryClient`: manifest reading for
    `requirements.txt` (with `==` exact pins treated as resolved versions)
    and `pyproject.toml` (both PEP 621 native and Poetry styles, including
    dependency groups), `poetry.lock` for resolved versions, and the PyPI
    JSON API for registry metadata (`requires_python`, yanked status,
    GitHub repository links).
  - `PythonUsageAnalyzer`: regex/text-based `import`/`from ... import`
    usage detection (including multi-line parenthesized imports, star
    imports, and namespace-style `pkg.member` access resolution), backed
    by a Python-aware comment/string masker that correctly keeps real code
    inside f-string interpolations (`f"{old_api()}"`) live while masking
    literal text, comments, and docstrings.
  - PyPI package names that differ from their Python import name (`Pillow`
    -> `PIL`, `beautifulsoup4` -> `bs4`, etc.) are resolved via a curated
    table plus a normalization fallback.
  - `PackageManagerFactory` now detects Python projects (via
    `requirements.txt`/`pyproject.toml`/`poetry.lock`) alongside the
    existing npm-family detection; `SimulationService` picks the matching
    usage analyzer, source-file glob, and registry per detected ecosystem,
    and skips JS/TS-only evidence (deep type-declaration diffing) for
    Python projects rather than attempting it and finding nothing.
  - Known-changes database entries for django, flask, numpy, and pandas.
  - Fixed extension activation: `activationEvents` and the `package.json`
    right-click menu previously only recognized npm-family projects, so
    the extension would never even activate for a pure-Python project.
  - Fixed a latent per-project-registry bug this surfaced: commands used
    to share one hardcoded npm-backed registry client for target-version
    listing regardless of the actual project's ecosystem - harmless while
    every ecosystem shared the npm registry, but a real bug the moment a
    non-npm ecosystem existed. Every registry operation now goes through
    the correctly-detected per-project `PackageManager`.

- Cross-file "barrel file" re-export resolution: a symbol imported from a
  local file that itself re-exports from the target package (directly or
  through a chain of further re-exports, up to 6 hops, with cycle
  detection) is now correctly recognized as real usage - previously,
  usage detection only looked at each file's own direct imports and
  silently missed anything routed through a local barrel/index file.
- Namespace member-access resolution: `import * as pkg from "some-package";
  pkg.oldApi()` now correctly correlates against a breaking-change symbol
  named `oldApi`, the same way a named import would - previously, a
  namespace import only tracked the opaque namespace binding itself, so
  no specific member access through it could ever match a symbol-level
  finding. This also works through a local barrel that re-exports the
  package (`import * as api from "./api-client"; api.oldApi()`), unifying
  namespace-member resolution with the re-export chain resolution above.

### Fixed
- Scope-shadow detection now also recognizes a nested `interface`, `type`
  alias, or `enum` declaration as shadowing an imported name, matching how
  nested `const`/`function`/`class` declarations were already handled -
  previously, a locally-redeclared type with the same name as an import
  was incorrectly counted as a usage of the import.

### Added (previous batch)
- Full AST/scope-aware usage detection, replacing the previous regex-based
  scanner: `UsageAnalyzer` now uses the TypeScript compiler's own parser
  (`ts.createSourceFile`, not a full type-checked `ts.Program` - kept fast
  and bounded, no module-graph resolution) with real lexical scope
  tracking, so a local variable or parameter that shadows an imported name
  is correctly excluded from "usage", while references in arrow functions,
  shorthand object properties, and template-literal interpolations are
  correctly included. This makes the earlier comment/string-literal masker
  unnecessary (removed) - the AST simply never sees comments/strings as
  code in the first place.
- `typescript` is now a genuine runtime dependency (previously dev-only);
  only its actual entry point (`lib/typescript.js` + `package.json`, ~1MB)
  ships in the packaged extension, not the full ~23MB package.
- Yarn Berry (v2+) `yarn.lock` support (YAML-based format, `npm:`-protocol
  descriptor resolution), alongside the existing classic (v1) parser.
- Comment/string-literal masking in usage detection: a symbol mentioned
  inside a comment or string no longer counts as real usage, while a real
  call inside a template-literal interpolation (`` `${oldApi()}` ``) still
  does.
- `.gitignore`, plus `homepage`/`bugs`/`galleryBanner` marketplace metadata
  in `package.json`.
- Multi-package-manager support: npm, Yarn (classic v1 `yarn.lock`), pnpm
  (`pnpm-lock.yaml` via `js-yaml`, plus `pnpm-workspace.yaml`), and Bun
  (text `bun.lock`) are now auto-detected per project via
  `PackageManagerFactory`, sharing a common `NpmRegistryClient` for all
  registry-facing operations.
- PAX extended tar header support in the from-scratch gzip/tar reader, so
  cross-version type diffing correctly resolves file paths beyond the
  classic ustar 100-byte name field.
- GitHub evidence scanning now falls back to a repository's
  CHANGELOG.md/CHANGES.md/HISTORY.md file, split by version heading, when
  tagged Releases don't yield a breaking-change callout.
- Known-breaking-changes database expanded from 4 to 14 packages
  (added react-dom, vue, webpack, eslint, jest, node-fetch, chalk, uuid,
  mongoose, next).
- New, better anti-aliased extension icon (supersampled rendering, diagonal
  gradient, cleaner magnifying-glass-with-upgrade-arrow silhouette).
- Community health files: CONTRIBUTING.md, CODE_OF_CONDUCT.md, SECURITY.md,
  GitHub issue/PR templates, and a CI workflow (lint + compile + test on
  Node 18.x/20.x).

## [0.1.0] - 2026-08-20

### Added
- Initial MVP release.
- `UpgradeLens: Simulate Upgrade` - dependency + target version picker, full
  read-only impact simulation, native webview report.
- `UpgradeLens: Analyze Current Dependencies` - overview of every dependency
  vs. its latest published version.
- `UpgradeLens: Refresh Analysis` - re-runs the currently displayed report.
- `UpgradeLens: Run Demo Simulation` - deterministic demo pipeline, no
  project required.
- Usage scanner covering default/named/aliased/namespace imports, `require`,
  destructured `require`, dynamic `import()`, and subpath imports.
- Layered breaking-change evidence: live npm registry metadata, a curated
  known-changes database for popular packages, GitHub release-notes
  scanning, and TypeScript declaration diffing (installed-version fallback
  plus full two-version tarball diffing when reachable).
- Deterministic, explainable risk scoring and a generated migration
  checklist.
- npm workspaces / monorepo dependency aggregation.
- Peer-dependency conflict detection against the project's own resolved
  versions, not just "a peer requirement changed."
- Unit test suite (semver, usage detection, impact correlation, risk
  scoring, webview message validation, semver range satisfaction, tar/gzip
  parsing, end-to-end demo scenario).

