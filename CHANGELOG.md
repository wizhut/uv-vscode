# Changelog

All notable changes to **Practical UV** are documented in this file.

Releases before 0.1.9 predate this file and are not documented here; see the
git history for details.

## [0.2.2]

### Changed

- **A new icon.** A list of requirements, an arrow and a package — pip to
  uv — in white on teal, the same icon wizhut.tech now uses for Practical
  UV.

- **Updated packages.** The tools the extension is built and packaged with
  are on their latest versions — TypeScript 7, `@vscode/vsce` 4 and the
  current Node.js type definitions — which also clears every known
  vulnerability `npm audit` reported in them. None of them ship inside the
  extension; its one runtime dependency, `@iarna/toml`, was already current.
  It still runs on VS Code 1.125 and later.

- **A smaller download.** The extension's original high-resolution artwork
  is no longer packaged, which takes the download from about 500 KB to
  90 KB.

- The README opens with the icon and a section on Wizhut.tech, now up to
  date with what the company makes.

## [0.2.1]

### Changed

- **Converting a pip project no longer adds files you did not ask for.** When
  there is no `pyproject.toml` yet, **Convert to uv** now runs
  `uv init --bare`, which creates `pyproject.toml` and nothing else. It used
  to run plain `uv init`, which in current uv versions also creates a `src/`
  package with a hello-world entry point, a build backend, `README.md`,
  `.python-version` and a git repository — inside the project you were
  migrating. Needs uv 0.5.29 or newer.

- **Development requirements go into uv's dev group.** Converting a file
  whose name marks it as development requirements — `requirements-dev.txt`,
  `requirements_test.txt`, `requirements/dev.txt`, `requirements/local.txt`
  and the like — now offers **Dev Group** first, which imports it with
  `uv add --dev -r`, and **Main Dependencies** as the alternative. Such files
  used to land in the project's main dependencies. A file whose name says
  neither gets both choices, main first; `requirements.txt` itself is never
  asked about.

- **A development file that includes `requirements.txt` is split the right
  way.** uv follows the `-r requirements.txt` line most development files
  start with, so a dev-group import alone would copy every runtime package
  into the dev group as well. The conversion now imports the included file
  into the project's dependencies first, then takes those packages back out
  of the dev group, which ends up holding only what the development file
  lists itself. One click on `requirements-dev.txt` migrates both files.

- The confirmation now lists the exact commands each choice runs.

### Fixed

- Converting a requirements file with unsaved changes imported the version on
  disk, leaving the edits out. The file is now saved first.

## [0.2.0]

### Added

- **Known-vulnerability detection for your dependencies.** Dependencies are
  checked against the [OSV](https://osv.dev) advisory database — the PyPA
  Advisory Database and GitHub Security Advisories — and reported with the CVE,
  its severity, and the version that fixes it. Findings appear as diagnostics
  in their own `uv-security` collection, so you can filter them apart from the
  outdated-dependency warnings in the Problems panel; in the package hover; as
  an **Upgrade … (fixes CVE-…)** quick fix; and in a new Security column in the
  dependency dashboard. Every finding links out to the advisory.

  **Off by default.** `uv.security.enabled` turns on background checking, and
  **UV: Check Dependencies for Security Advisories** runs a one-off check
  without changing the setting.

- **A per-dependency security check in the code-action menu.** `Cmd+.` on any
  dependency now offers **Check &lt;package&gt; for security advisories**
  alongside the existing version options, and **Re-check …** once results
  exist. It is offered even while `uv.security.enabled` is off, because it
  checks a single package rather than the whole file, and it never wipes
  results already gathered for the rest of the document.

  The outcome is reported precisely rather than reassuringly: "no advisories"
  is distinguished from "no exact version to check", so a dependency that could
  not be resolved says so instead of implying a safety the check did not
  establish.

- **`uv.lock` is read to resolve your dependencies to exact versions.** An
  advisory applies to a concrete version, but dependencies are usually declared
  as ranges. When a lockfile sits next to your `pyproject.toml`, each dependency
  is matched against the version you actually install, so a finding means *you
  are affected* rather than *your constraint permits it*. An `==` pin resolves
  the same way without a lockfile.

  Only your own top-level dependencies are checked, so every finding is fixable
  by editing the file in front of you. A vulnerability in a package you did not
  declare is not reported.

- `uv.security.includeRangeFindings` (default `false`) reports advisories that a
  declared range *permits* when no exact version could be resolved. Accurate but
  noisy — an open constraint like `requests>=2.0` permits every advisory ever
  published for that package — so it is suppressed unless asked for.

- Package names are now normalized, so `Flask`, `typing_extensions` and
  `typing-extensions` match their lockfile and advisory entries. They
  previously would not have.

### Notes

- **Privacy.** With security checking enabled, the names and versions of your
  declared dependencies are sent to `api.osv.dev`. This is why the feature ships
  off by default: it is the first thing in the extension that transmits anything
  about your project to a service other than PyPI. No request is made while the
  setting is off unless you invoke the command explicitly.

- A single CVE is often published to more than one advisory database. Duplicate
  records are collapsed onto the most informative one, so you get one finding
  per vulnerability, carrying a real severity.

- Known gap, unchanged by this release: multi-constraint specifiers such as
  `flask>=2.0,<3` are still skipped by the parser, so those dependencies get no
  outdated check, hover, or security check.

## [0.1.10]

### Fixed

- The README's stated requirement was still `VS Code ^1.85.0`, forty releases
  behind the real one. Corrected to `^1.125.0`.

### Changed

- The README's top-level heading is now **Practical UV**, matching the
  extension's name on both marketplace listings. It was the last place still
  carrying the old "UV VS Code Integration" name.

### Notes

- No code changes — this release exists to ship documentation that never
  reached the registries. The 0.1.9 artifact was packaged moments before this
  changelog was first written, so neither listing has ever shown one, and
  registries do not allow republishing an existing version.

## [0.1.9]

### Fixed

- The "UV PyPI" output panel no longer forces itself open every time VS Code
  starts. It still receives all its logging; it is now reached through the
  Output dropdown.

### Changed

- **Minimum supported VS Code is now 1.125**, raised from 1.118. Installs on
  VS Code 1.118–1.124 will no longer receive updates to this extension.
- Updated build dependencies, clearing 11 advisories (7 high, 4 moderate) in
  the toolchain.

### Notes

- No runtime dependency changes. The extension still ships only
  `@iarna/toml`, which was unaffected by the advisories above.
