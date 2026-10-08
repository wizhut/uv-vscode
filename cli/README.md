# practical-uv

Convert a pip project into a [uv](https://github.com/astral-sh/uv) project from the command line. It does the same conversion as **UV: Convert requirements.txt to uv project** in the [Practical UV](https://wizhut.tech/practical-uv) VS Code extension, and plans its commands with the same code.

```bash
npx @wizhut_tech/practical-uv convert
```

Run it in the project folder. It prints the exact commands, asks once, then runs them:

- `uv init --bare` when there is no `pyproject.toml` yet. That creates `pyproject.toml` and nothing else: no sample code, build backend, README, `.python-version` or git repository.
- `uv add -r requirements.txt`, which imports the requirements into the project's dependencies, writes `uv.lock` and installs `.venv`.

Your requirements files are read, never changed.

## Development requirements

```bash
npx @wizhut_tech/practical-uv convert requirements-dev.txt
```

A file whose name marks it as development requirements (dev, test, lint, docs or local in the name, such as `requirements-dev.txt`, `requirements_test.txt` or `requirements/dev.txt`) goes into uv's dev group with `uv add --dev -r`.

Most of these files start with `-r requirements.txt`, and uv follows that line, so a dev-group import alone would copy every runtime package into the dev group too. The conversion imports the included runtime file into the project's dependencies first, then the development file into the dev group, then takes the included packages back out with `uv remove --dev`. One command migrates both files.

`--main` and `--dev` override what the file name says.

## Options

```
practical-uv convert [requirements-file] [options]

  requirements-file    defaults to requirements.txt in the project folder
  -C, --project <dir>  the project folder, where pyproject.toml is (default: .)
      --dev            import into uv's dev group
      --main           import into the project's dependencies
  -n, --dry-run        print the commands, run nothing
  -y, --yes            run without asking (required when not in a terminal)
  -h, --help           show the help
  -V, --version        show the version
```

`convert` can be left out: `npx @wizhut_tech/practical-uv requirements-dev.txt` works too.

## Requirements

- Node.js 18 or newer, for `npx`.
- [uv](https://docs.astral.sh/uv/getting-started/installation/) 0.5.29 or newer on `PATH` (`uv init --bare`).

uv sets `requires-python` from the Python it finds.

## As a library

The planning functions are exported, with no runtime dependencies:

```js
const { classifyRequirementsFile, convertCommands } = require('@wizhut_tech/practical-uv');

classifyRequirementsFile('requirements-dev.txt'); // 'dev'
convertCommands({ hasPyproject: false, requirementsPath: 'requirements.txt', target: 'main' });
// [ 'uv init --bare', 'uv add -r requirements.txt' ]
```

## About Wizhut.tech

practical-uv is developed and maintained by [Wizhut.tech](https://wizhut.tech). We make sharp, focused software that removes busywork from the working day, and our tools are meant to stay out of your way.

- **[Practical UV for VS Code](https://wizhut.tech/practical-uv)**: this conversion plus outdated-dependency checks, security advisories from OSV, hover info and version pickers for `pyproject.toml` and `requirements.txt`. On the [VS Code Marketplace](https://marketplace.visualstudio.com/items?itemName=wizhut-tech.wiz-practical-uv) and [Open VSX](https://open-vsx.org/extension/wizhut/uv-vscode).
- **[Kyori](https://wizhut.tech/kyori)** ([`@wizhut_tech/kyori`](https://www.npmjs.com/package/@wizhut_tech/kyori)): string distance and similarity for JavaScript, with a ranking score for autocomplete.
- **[WizJS](https://wizhut.tech/wizjs)** ([`@wizhut_tech/wizjs`](https://www.npmjs.com/package/@wizhut_tech/wizjs)): everyday JavaScript utilities with zero runtime dependencies.

More at [wizhut.tech](https://wizhut.tech). Source and issues: [github.com/wizhut/uv-vscode](https://github.com/wizhut/uv-vscode) (the CLI lives in `cli/`).

## License

MIT
