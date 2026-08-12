# Changelog

All notable changes to **Practical UV** are documented in this file.

Releases before 0.1.9 predate this file and are not documented here; see the
git history for details.

## [0.2.0]

### Added

- **Known-vulnerability detection for declared dependencies.** Dependencies are
  checked against the [OSV](https://osv.dev) advisory database — the PyPA
  Advisory Database and GitHub Security Advisories — and reported with the CVE,
  its severity, and the version that fixes it. Findings surface as diagnostics
  in a dedicated `uv-security` collection (kept separate from `uv-pypi` so the
  two can be filtered apart in the Problems panel), in the package hover, as an
  **Upgrade … (fixes CVE-…)** quick fix, and in a new Security column in the
  dependency dashboard. Diagnostics carry a clickable link to the advisory.

  **Off by default.** `uv.security.enabled` turns on background checking;
  **UV: Check Dependencies for Security Advisories** runs a one-off check
  without changing the setting.

- **A per-dependency security check in the code-action menu.** `Cmd+.` on any
  dependency now offers **Check &lt;package&gt; for security advisories**
  alongside the existing version options, and **Re-check …** once results
  exist. It is offered unconditionally — including while `uv.security.enabled`
  is off — because it checks a single package rather than the whole file. A
  single-package check replaces only that package's findings, so it never wipes
  results already gathered for the rest of the document.

  The outcome is reported precisely rather than reassuringly. "No advisories"
  is distinguished from "no exact version to check": a dependency with neither
  a `uv.lock` entry nor an `==` pin reports how many advisories its declared
  range permits and points at `uv.security.includeRangeFindings`, instead of
  implying a safety the check did not establish.

- **`uv.lock` is read to resolve declared dependencies to exact versions.** An
  advisory applies to a concrete version, but dependencies are usually declared
  as ranges. When a lockfile sits next to the `pyproject.toml`, each declared
  dependency is pinned to its locked version and the finding means *you are
  affected* rather than *your constraint permits it*. An `==` pin resolves the
  same way without a lockfile.

  Only **top-level** dependencies are checked. The lock's transitive tree is
  used solely for version resolution and is never queried, so every finding is
  fixable by editing the file in front of you. A vulnerability in a package you
  did not declare is not reported.

- `uv.security.includeRangeFindings` (default `false`) reports advisories that a
  declared range *permits* when no exact version could be resolved. Accurate but
  noisy — an open constraint like `requests>=2.0` permits every advisory ever
  published for that package — so it is suppressed unless asked for.

- `normalizePackageName` in the parser, applying PEP 503 name normalization.
  `Flask`, `typing_extensions` and `typing-extensions` previously would not have
  matched their lockfile or advisory entries.

- `src/audit.ts`, a `vscode`-free module holding PEP 440 version comparison,
  constraint/advisory interval intersection, the `uv.lock` reader and the OSV
  client, with 54 unit tests. Kept free of `vscode` imports for the same reason
  as `src/parser.ts`.

### Notes

- **Privacy.** With security checking enabled, the names and versions of your
  declared dependencies are sent to `api.osv.dev`. This is why the feature ships
  off by default rather than on: it is the first thing in the extension that
  transmits anything about your project to a service other than PyPI. No request
  is made while the setting is off unless you invoke the command explicitly.

- OSV returns one record per source database, so a single CVE typically arrives
  twice — a GHSA record carrying a severity and a PYSEC record usually without
  one. Alias-linked records are collapsed onto the most informative one, which
  roughly halves the finding count and means every reported finding carries a
  real severity rather than `UNKNOWN`.

- Severity is taken from each advisory's `database_specific.severity`. Records
  that carry only a raw CVSS vector are surfaced with the vector rather than a
  score computed here; a wrong computed score would be worse than an honest
  absence.

- Known gap, unchanged by this release: `parsePep508` still rejects
  multi-constraint specifiers such as `flask>=2.0,<3`, so those dependencies are
  skipped by the parser entirely and receive no outdated check, hover, or
  security check. The audit module already handles comma-separated constraints,
  so they will be covered once the parser stops dropping them.

## [0.1.10]

### Fixed

- The README's stated requirement was still `VS Code ^1.85.0`, forty releases
  behind the actual `engines.vscode` of `^1.125.0`. Corrected.

### Changed

- The README's top-level heading is now **Practical UV**, matching the
  extension's `displayName` and both marketplace listings. It was the last
  place still carrying the old "UV VS Code Integration" name.

### Notes

- No code changes — this release exists to ship documentation that never
  reached the registries. The 0.1.9 artifact published to the VS Code
  Marketplace and Open VSX was packaged moments before `CHANGELOG.md` was
  first written, so neither listing has ever shown a changelog. Registries do
  not allow republishing an existing version, so the fix required a new one.

## [0.1.9]

### Fixed

- The "UV PyPI" output panel no longer forces itself open on activation.
  Because the extension activates on `onStartupFinished`, the panel was
  revealed on every VS Code launch. The channel still receives diagnostics,
  hover and code-action logging; it is now reached via the Output dropdown.

### Changed

- **Minimum supported VS Code is now 1.125.** `engines.vscode` was raised from
  `^1.118.0` to `^1.125.0`. Installs on VS Code 1.118–1.124 will no longer
  receive updates to this extension.
- Updated development dependencies: `@types/node` to ^26.1.1, `@types/vscode`
  to ^1.125.0, `@vscode/vsce` to ^3.9.2. This clears 11 advisories (7 high,
  4 moderate) in the build toolchain.

### Notes

- No runtime dependency changes. The extension still ships only
  `@iarna/toml`, which was unaffected by the advisories above.
- TypeScript remains on ^6.0.3; the 7.x upgrade is deferred to a later release.
