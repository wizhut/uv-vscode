# CLAUDE.md

## Project Overview

**UV VS Code Integration** (`uv-vscode`) — a VSCode extension for Python projects managed with [uv](https://github.com/astral-sh/uv). It provides outdated dependency detection, version upgrades, hover info from PyPI, and uv command palette integration for `.toml` files.

## Tech Stack

- **Language**: TypeScript 5.3.3, targeting ES2022, CommonJS modules
- **VSCode API**: ^1.85.0
- **Build**: `tsc` (no bundler)
- **Packaging**: `vsce`

## Project Structure

- `src/extension.ts` — Single source file (~536 lines). Contains all logic: activation, commands, diagnostics, hover/code-action providers, PyPI/Python version fetching.
- `syntaxes/toml.tmLanguage.json` — TextMate grammar for TOML syntax highlighting.
- `out/` — Compiled JS output (committed).
- `package.json` — Extension manifest, commands, activation events.

## Build & Run

```bash
npm install          # Install dependencies
npm run compile      # One-time compile
npm run watch        # Watch mode (used during development)
npm run package      # Package as .vsix via vsce
```

Press **F5** in VSCode to launch the Extension Development Host for testing.

## Key Commands Registered

- `uv.sync` — Run `uv sync` in terminal
- `uv.add` — Prompt for package name, run `uv add <pkg>`
- `uv.run` — Prompt for command, run `uv run <cmd>`
- `uv.upgradeVersion` — Upgrade a dependency to latest (internal, via code action)
- `uv.selectVersion` — Pick from all available versions (internal, via code action)
- `uv.selectPythonVersion` — Select Python version from endoflife.date API

## Architecture Notes

- **Activation**: `onLanguage:toml` — lazy-loads when a TOML file is opened.
- **Caching**: In-memory `Map` for PyPI responses to avoid repeated network calls.
- **Diagnostics**: Debounced (500ms) outdated-dependency checks against PyPI.
- **Dependency sections**: Recognizes `[project]`, `[project.optional-dependencies.*]`, and `[dependency-groups.*]`.
- **No tests**: `npm test` is a placeholder (`No tests specified`).
- **No bundler**: Raw tsc output, no webpack/esbuild.

## Conventions

- All extension logic lives in a single `src/extension.ts` file.
- Regex patterns (`DEP_LINE_REGEX`, `VERSION_LINE_REGEX`, `PYTHON_VERSION_REGEX`) parse TOML dependency lines.
- External APIs: PyPI JSON API, endoflife.date API (with hardcoded fallback versions).
