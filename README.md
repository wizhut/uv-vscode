# UV VS Code Integration

A VS Code extension for working with Python dependency files. Supports both [uv](https://github.com/astral-sh/uv) / PEP 621 `pyproject.toml` and pip's `requirements.txt`. Provides TOML syntax highlighting, dependency version management via PyPI, and project version bumping.

## Features

### 🔍 Outdated Dependency Detection

Automatically checks your dependencies against PyPI and highlights outdated versions with inline diagnostics. Works in both `pyproject.toml` and `requirements.txt`.

![Dependency update](contrib/screenshots/deoendency-update.png)

### 🐍 Pip / `requirements.txt` Support

The extension auto-detects pip-style files and applies the same outdated-detection, hover, code actions, and dashboard. Recognized files:

- `requirements.txt`
- `requirements-*.txt` and `requirements_*.txt` (e.g. `requirements-dev.txt`)
- Any `*.txt` inside a `requirements/` directory

Comments (`#`), blank lines, pip directives (`-r`, `-e`, `-c`, `--index-url`, …), direct URL specs (`pkg @ https://…`), and PEP 508 environment markers (`; python_version >= "3.8"`) are handled correctly.

### 🚀 Convert pip Project to uv

When a `requirements.txt` file is the active editor, a **`$(arrow-up) Convert to uv`** action appears in the status bar (and **UV: Convert requirements.txt to uv project** is available in the command palette).

It runs the appropriate sequence in the integrated terminal at the workspace folder root:

- If no `pyproject.toml` exists: `uv init` followed by `uv add -r <requirements file>`
- If `pyproject.toml` already exists: just `uv add -r <requirements file>` to import the deps

You'll be prompted to confirm before anything is executed.

### ⚡ Quick Fix: Upgrade to Latest

Click the lightbulb (or press `Cmd+.` / `Ctrl+.`) on an outdated dependency to instantly upgrade it to the latest version.

### 📋 Version Selection

Choose from all available versions on PyPI via a quick pick menu.

### 📦 Project Version Bumping (`pyproject.toml` only)

Place your cursor on the `version = "x.y.z"` line under `[project]` and bump the major, minor, or build version:

- **Bump build** — `0.1.0` → `0.1.1`
- **Bump minor** — `0.1.0` → `0.2.0`
- **Bump major** — `0.1.0` → `1.0.0`

![Version bump](contrib/screenshots/version-bump.png)

### 🐍 Python Version Selection (`pyproject.toml` only)

Place your cursor on the `requires-python` line to quickly switch Python versions. Quick-fix actions show the latest patch release of each major version from 3.10 onwards (e.g., 3.14.3, 3.13.12, …), fetched dynamically from the [endoflife.date](https://endoflife.date/python) API. Choose **"More Python versions…"** to browse all versions from 3.1 onwards.

### 🔧 Hover Information

Hover over a package name in a dependency section to see its latest PyPI version with a link to the project page.

### 📊 Dependency Dashboard

Run **UV: Show Dependencies** from the command palette to open an interactive webview panel that lists all your dependencies with:

- **Package name** and **current version**
- **Latest version** from PyPI
- **Status indicator** — ✅ if up-to-date, or an **Upgrade** button to update outdated packages

### 🖥️ UV Commands

Run common `uv` commands directly from the command palette (`Cmd+Shift+P`):

| Command | Description |
|---------|-------------|
| `UV: Sync` | Run `uv sync` |
| `UV: Add` | Add a package via `uv add` |
| `UV: Run` | Run a command via `uv run` |
| `UV: Show Dependencies` | Open the dependency dashboard |
| `UV: Convert requirements.txt to uv project` | Run `uv init` (if needed) and `uv add -r <file>` &mdash; only shown when a `requirements.txt` is active |

## Supported Sources

In `pyproject.toml`, dependencies are parsed using a real TOML parser ([`@iarna/toml`](https://www.npmjs.com/package/@iarna/toml)) — both inline (`dependencies = ['x==1.0', ...]`) and multi-line array styles, with single or double quotes, are handled identically. Recognized sections:

- `[project]` → `dependencies = [...]`
- `[project.optional-dependencies]` → `dev = [...]`, etc.
- `[dependency-groups]` → `dev = [...]`, etc.

In `requirements.txt` (and the variants listed above), each line is parsed as a PEP 508 requirement.

## Requirements

- VS Code `^1.85.0`
- Internet access for PyPI lookups

## Development

```bash
# Install dependencies
npm install

# Compile
npm run compile

# Watch for changes
npm run watch

# Run unit tests (parser + requirements.txt)
npm test

# Build .vsix for both registries (output in dist/)
npm run package           # vscode + openvsx
npm run package:vscode    # VS Code Marketplace only
npm run package:openvsx   # Open VSX only
```

The two registries require different `(name, publisher)` pairs. Edit [`build/targets.json`](build/targets.json) to change them. The script overrides `package.json` in place during each build and restores it afterwards.

Press `F5` to launch the Extension Development Host for testing.

Tests use the built-in [`node:test`](https://nodejs.org/api/test.html) runner and live in `src/test/`.

## License

MIT
