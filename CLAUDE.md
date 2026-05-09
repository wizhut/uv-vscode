# CLAUDE.md

## Project Overview

**UV VS Code Integration** (`uv-vscode`) — a VSCode extension for Python dependency files. Supports both [uv](https://github.com/astral-sh/uv) / PEP 621 `pyproject.toml` and pip's `requirements.txt`. Provides outdated-dependency detection, version upgrades, hover info from PyPI, project version bumping, a dependency dashboard, and a one-shot pip → uv conversion command.

## Tech Stack

- **Language**: TypeScript (configured for ES2022, CommonJS modules)
- **VSCode API**: ^1.85.0 (engines field; `@types/vscode` may be newer)
- **Runtime dep**: `@iarna/toml` for TOML parsing
- **Build**: `tsc` (no bundler)
- **Tests**: built-in `node:test` runner (no Jest/Mocha)
- **Packaging**: `vsce`

## Project Structure

- `src/parser.ts` (~220 lines) — Pure parsing logic, no `vscode` imports. Exports `parseDocument` (TOML / pyproject), `parseRequirements` (pip), `parsePep508`, `buildSnapshot`, `hasVersionUpdates`, `findDepAtPosition`, `depsOnLine`, plus the shared `DepLocation` / `ParsedDocument` / `SnapshotState` types. Kept vscode-free so it's unit-testable.
- `src/extension.ts` (~857 lines) — VSCode-facing layer: activation, commands, diagnostics, hover/code-action providers, dependency dashboard webview, status-bar item, PyPI/Python version fetching.
- `src/test/parser.test.ts`, `src/test/requirements.test.ts` — `node:test` suites covering the parser module.
- `syntaxes/toml.tmLanguage.json` — TextMate grammar for TOML syntax highlighting.
- `out/` — Compiled JS output (committed). `.vscodeignore` excludes `out/test/**` from the .vsix.
- `package.json` — Extension manifest, commands, activation events. Runtime deps (`@iarna/toml`) must be allowlisted in `.vscodeignore` to ship inside the .vsix.

## Build & Run

```bash
npm install          # Install dependencies
npm run compile      # One-time compile
npm run watch        # Watch mode (used during development)
npm test             # tsc + node --test out/test/*.test.js
npm run package      # Package as .vsix via vsce
```

Press **F5** in VSCode to launch the Extension Development Host for testing.

## Commands Registered

User-facing (in command palette):
- `uv.sync` — Run `uv sync` in the integrated terminal
- `uv.add` — Prompt for a package name, run `uv add <pkg>`
- `uv.run` — Prompt for a command, run `uv run <cmd>`
- `uv.showDependencies` — Open the interactive dependency dashboard webview
- `uv.convertToUv` — Convert a `requirements.txt` project to uv (runs `uv init` if needed, then `uv add -r <file>`). Hidden from the palette unless `uv.requirementsActive` context key is true (set when the active editor is a recognized requirements file).

Internal (invoked by code actions, not visible to users):
- `uv.upgradeVersion` — Upgrade a dependency to latest
- `uv.selectVersion` — Pick from all available versions on PyPI
- `uv.selectPythonVersion` — Pick a Python version (from endoflife.date)

## Architecture Notes

- **Activation**: `onLanguage:toml` and `onStartupFinished`. Effectively always-on for any session.
- **Supported documents**: `isPyprojectTomlDocument` (basename `pyproject.toml`) OR `isRequirementsTxtDocument` (`requirements.txt`, `requirements-*.txt`, `requirements_*.txt`, or any `*.txt` in a `requirements/` directory). `isSupportedDocument` is the union.
- **Parsing dispatch**: `getParsedDocument` caches a `ParsedDocument` per `document.uri` keyed on `document.version`. Pyproject files go through `@iarna/toml` then a source-position search (`locateString`) to map each declared dep back to its `(line, contentStart, contentEnd)` in the original text. Requirements files are parsed line-by-line using `parsePep508`, with handling for `#` comments (line + inline), pip directives (`-`-prefixed), direct URL specs (`pkg @ url`), and PEP 508 environment markers (`; python_version >= "3.8"`).
- **Caching**: In-memory `Map` for PyPI JSON responses (avoids repeat network calls). Python versions cached after the first endoflife.date fetch.
- **Diagnostics**: Debounced (500ms) outdated-dependency checks against PyPI. Diagnostics, hover, and code actions are scoped to dependency locations from the parsed model — no per-line regex section detection.
- **Pyproject sections recognized**: `[project] dependencies`, `[project.optional-dependencies.*]`, `[dependency-groups.*]`. Each dep gets a section label like `project.dependencies`, `project.optional-dependencies.dev`, `dependency-groups.dev` for snapshot diffing.
- **uv-sync prompt**: On save, the snapshot is rebuilt and compared (`hasVersionUpdates`) against the previous; if dep or project versions changed, the user is offered "Run uv sync". Pyproject-only — requirements files don't get this prompt.
- **Version bump quick-fixes** (project version + `requires-python`): pyproject-only, still regex-based (`VERSION_LINE_REGEX`, `PYTHON_VERSION_REGEX`) because those need precise sub-version source positions that the TOML parser doesn't expose.
- **Status bar**: A single right-aligned item ("$(arrow-up) Convert to uv") shown only when the active editor is a requirements file. Its visibility and the `uv.requirementsActive` context key are both updated by `refreshActiveDocContext` on active-editor change.
- **No bundler**: Raw `tsc` output. `.vscodeignore` allowlists `node_modules/@iarna/toml/**` so the runtime dep is shipped.

## Conventions

- Keep `src/parser.ts` free of `vscode` imports so it stays unit-testable.
- Tests live under `src/test/` and compile to `out/test/`. They are excluded from the .vsix via `.vscodeignore`.
- External APIs: PyPI JSON API (`pypi.org/pypi/<pkg>/json`), endoflife.date Python API (with a hardcoded fallback list when offline).
- Add new commands to `package.json` `contributes.commands`. If a command should only appear in the palette under specific conditions, add an entry under `contributes.menus.commandPalette` with a `when` clause and toggle the corresponding context key from the extension via `setContext`.
- New runtime dependencies must be allowlisted in `.vscodeignore` (the default rule excludes all of `node_modules/`).
