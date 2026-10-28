# Contributing to UpgradeLens

Thanks for your interest in improving UpgradeLens! This project is a small,
focused VS Code extension, and contributions of all sizes are welcome -
bug reports, documentation fixes, new known-breaking-change entries, and
new features alike.

## Getting set up

```bash
git clone https://github.com/AnandShah10/upgradelens.git
cd upgradelens
npm install
npm run compile
```

Press **F5** in VS Code (or run the "Run UpgradeLens" launch configuration)
to open an Extension Development Host with your local changes loaded.

## Before you open a pull request

```bash
npm run lint      # ESLint over src/
npm run compile   # TypeScript build
npm test          # Unit test suite
```

All three should pass cleanly. If you're adding a new analysis rule,
change provider, or command, please add or update unit tests alongside it -
the test suite is what keeps the risk-scoring and impact-correlation logic
honest as the codebase grows.

## Where things live

See the **Architecture** section in [README.md](README.md) for a map of
`src/`. A few pointers for common contribution types:

- **A new known breaking change for a popular package** →
  `src/changelog/KnownChangesProvider.ts`. This is the easiest, lowest-risk
  contribution: add an entry, add a test asserting it fires for the right
  version range and doesn't fire outside it.
- **A new evidence source** (e.g. a changelog-file parser) → implement the
  `PackageChangeProvider` interface in `src/models/PackageChange.ts` and add
  a new file under `src/changelog/`. Wire it into `SimulationService`
  behind a settings toggle, following the pattern of the existing
  providers.
- **A new package manager** (yarn, pnpm, bun) → implement the
  `PackageManager` interface in `src/package/PackageManager.ts`.
- **UI changes** → `src/ui/webview/` (styles.css, app.js, index.html). Keep
  using VS Code theme CSS variables rather than hard-coded colors so it
  keeps working across light/dark/high-contrast themes.

## Reporting bugs

Please include:
- VS Code version and OS.
- The dependency name + versions you were simulating (from and to).
- Whether the project is a single package or an npm workspaces monorepo.
- Anything relevant from the report itself (risk level, a specific finding
  that looked wrong) - not the whole webview if it contains anything
  proprietary, just the shape of the issue.

## Code style

- TypeScript strict mode is on; please don't introduce `any` without a
  comment explaining why it's unavoidable.
- Keep new analysis/evidence logic behind small, testable
  classes/functions rather than growing `SimulationService` directly -
  it's already an orchestrator, not a place for new logic.
- Never make the extension write to a project's `package.json`,
  `package-lock.json`, or any source file. UpgradeLens is read-only by
  design; a pull request that changes this will not be accepted.

## License

By contributing, you agree that your contributions will be licensed under
the project's [MIT License](LICENSE).
