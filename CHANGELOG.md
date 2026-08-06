# Changelog

All notable changes to **Practical UV** are documented in this file.

Releases before 0.1.9 predate this file and are not documented here; see the
git history for details.

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
