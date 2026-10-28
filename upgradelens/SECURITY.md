# Security Policy

## Reporting a vulnerability

If you believe you've found a security issue in UpgradeLens, please
**do not open a public GitHub issue**. Instead, report it privately so it
can be fixed before details are public:

- Open a [GitHub Security Advisory](https://github.com/AnandShah10/upgradelens/security/advisories/new)
  on the repository, or
- Email the maintainer directly (see the GitHub profile at
  [github.com/AnandShah10](https://github.com/AnandShah10) for contact
  details).

Please include:
- A description of the issue and its potential impact.
- Steps to reproduce, or a minimal example if applicable.
- The extension version and VS Code version you tested against.

We'll acknowledge reports as quickly as possible and aim to ship a fix
promptly for any confirmed issue.

## Scope and design constraints relevant to security

UpgradeLens is designed with a few hard constraints that bound its attack
surface:

- **Read-only with respect to your project.** It never writes to
  `package.json`, `package-lock.json`, or any project source file, and
  never runs `npm install` or any package lifecycle script.
- **No source code leaves your machine.** The only network calls it makes
  are: npm registry metadata lookups (package name + version numbers),
  optional GitHub release-notes fetches (same), and optional in-memory
  tarball downloads from official npm registry URLs for type-declaration
  diffing. Your project's own source is never transmitted anywhere.
- **No temp files.** Tarball downloads used for type-declaration diffing
  are decompressed and parsed entirely in memory - nothing is written to
  disk or left behind.
- **Webview sandboxing.** The report webview runs under a strict Content
  Security Policy (`default-src 'none'`, nonce'd scripts only) and every
  message crossing the webview boundary is validated before any action
  (file navigation, clipboard writes) is taken on its behalf.

If you find a way around any of these constraints, that's exactly the kind
of report we want.

## Supported versions

Security fixes are made against the latest published version. Given the
early stage of this project, older versions are not separately patched -
please upgrade to the latest release.
