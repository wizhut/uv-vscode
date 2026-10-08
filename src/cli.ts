#!/usr/bin/env node
// `npx @wizhut_tech/practical-uv convert [requirements file]` — the same
// conversion as "UV: Convert requirements.txt to uv project", outside VS Code.
// The plan (which group, which commands, the text that lists them) comes from
// convert.ts, so the CLI and the extension cannot disagree about what runs.
// No `vscode` imports and no runtime dependencies: this file and what it
// imports are all the npm package ships (see cli/).
import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import * as readline from 'readline';
import {
    ConvertChoice,
    ConvertPrompt,
    ImportTarget,
    classifyRequirementsFile,
    collectMainIncludes,
    convertChoices,
    convertCommands,
    convertPrompt,
} from './convert';

export const USAGE = `Usage: practical-uv convert [requirements-file] [options]

Turns a pip project into a uv project: "uv init --bare" when there is no
pyproject.toml yet, then "uv add -r <file>". Development requirements
(requirements-dev.txt, requirements/test.txt, ...) go into uv's dev group.

Arguments:
  requirements-file    defaults to requirements.txt in the project folder

Options:
  -C, --project <dir>  the project folder, where pyproject.toml is (default: .)
      --dev            import into uv's dev group
      --main           import into the project's dependencies
  -n, --dry-run        print the commands, run nothing
  -y, --yes            run without asking
  -h, --help           show this help
  -V, --version        show the version`;

export interface CliOptions {
    command: 'convert' | 'help' | 'version';
    requirements?: string;
    project?: string;
    target?: ImportTarget;
    dryRun: boolean;
    yes: boolean;
}

export class UsageError extends Error {}

/**
 * Reads the command line. `convert` may be left out, so
 * `npx @wizhut_tech/practical-uv requirements-dev.txt` works too.
 */
export function parseArgs(argv: string[]): CliOptions {
    const options: CliOptions = { command: 'convert', dryRun: false, yes: false };
    const positional: string[] = [];
    for (let i = 0; i < argv.length; i++) {
        const arg = argv[i];
        const eq = arg.startsWith('--') ? arg.indexOf('=') : -1;
        const flag = eq > 0 ? arg.slice(0, eq) : arg;
        const value = () => {
            if (eq > 0) {
                return arg.slice(eq + 1);
            }
            const next = argv[++i];
            if (next === undefined) {
                throw new UsageError(`${flag} needs a value`);
            }
            return next;
        };
        switch (flag) {
            case '-h': case '--help': options.command = 'help'; return options;
            case '-V': case '--version': options.command = 'version'; return options;
            case '-C': case '--project': options.project = value(); break;
            case '-n': case '--dry-run': options.dryRun = true; break;
            case '-y': case '--yes': options.yes = true; break;
            case '--dev': case '--main': {
                const target: ImportTarget = flag === '--dev' ? 'dev' : 'main';
                if (options.target && options.target !== target) {
                    throw new UsageError('--dev and --main cannot be used together');
                }
                options.target = target;
                break;
            }
            default:
                if (arg.startsWith('-') && arg !== '-') {
                    throw new UsageError(`unknown option ${arg}`);
                }
                positional.push(arg);
        }
    }
    if (positional[0] === 'convert') {
        positional.shift();
    } else if (positional[0] === 'help') {
        options.command = 'help';
        return options;
    }
    if (positional.length > 1) {
        throw new UsageError(`expected one requirements file, got ${positional.join(', ')}`);
    }
    options.requirements = positional[0];
    return options;
}

/**
 * Splits a command from convertCommands into argv. Those commands quote a path
 * only when it has whitespace, and only with plain double quotes (shellArg), so
 * this reverses that exactly and uv runs without a shell in between.
 */
export function splitCommand(command: string): string[] {
    const args: string[] = [];
    const re = /"([^"]*)"|(\S+)/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(command)) !== null) {
        args.push(m[1] ?? m[2]);
    }
    return args;
}

export interface ConvertPlan {
    projectDir: string;
    requirementsPath: string;
    choice: ConvertChoice;
    /** The other choice the file allows, for the hint under the plan. */
    alternative?: ConvertChoice;
    commands: string[];
    prompt: ConvertPrompt;
}

export interface PlanInput {
    projectDir: string;
    /** The requirements file, absolute. */
    requirementsFile: string;
    hasPyproject: boolean;
    target?: ImportTarget;
    readText: (absolutePath: string) => Promise<string | undefined>;
}

/** Works out the commands, as the extension does for its confirmation. */
export async function planConversion(input: PlanInput): Promise<ConvertPlan> {
    const { projectDir, requirementsFile, hasPyproject } = input;
    const relative = (fsPath: string) => path.relative(projectDir, fsPath) || path.basename(fsPath);
    const requirementsPath = relative(requirementsFile);
    const choices = convertChoices(classifyRequirementsFile(requirementsFile));
    // requirements.txt offers only "Convert" (main); --dev still wins there.
    const choice: ConvertChoice = input.target
        ? choices.find(c => c.target === input.target) ?? { label: 'Dev Group', target: input.target }
        : choices[0];
    const alternative = choices.find(c => c.target !== choice.target);

    let mainIncludes: string[] = [];
    let inheritedPackages: string[] = [];
    if (choice.target === 'dev') {
        const text = await input.readText(requirementsFile);
        if (text === undefined) {
            throw new Error(`${requirementsPath} could not be read`);
        }
        const included = await collectMainIncludes(requirementsFile, text, input.readText);
        mainIncludes = included.mainIncludes.map(relative);
        inheritedPackages = included.inheritedPackages;
    }
    const commands = convertCommands({ hasPyproject, requirementsPath, target: choice.target, mainIncludes, inheritedPackages });
    const prompt = convertPrompt({
        folderName: path.basename(projectDir),
        requirementsPath,
        choices: [choice],
        commands: { main: commands, dev: commands },
        mainIncludes,
    });
    return { projectDir, requirementsPath, choice, alternative, commands, prompt };
}

const REQUIREMENTS_NAME = /^requirements(?:[-_.].*)?\.(?:txt|in)$/i;

/** Requirements files in a folder, for the error when requirements.txt is missing. */
function findRequirementsFiles(dir: string): string[] {
    const found: string[] = [];
    const list = (sub: string) => {
        try {
            return fs.readdirSync(path.join(dir, sub));
        } catch {
            return [];
        }
    };
    for (const name of list('')) {
        if (REQUIREMENTS_NAME.test(name)) {
            found.push(name);
        }
    }
    for (const name of list('requirements')) {
        if (name.endsWith('.txt') || name.endsWith('.in')) {
            found.push(path.join('requirements', name));
        }
    }
    return found.sort();
}

function readTextFile(fsPath: string): Promise<string | undefined> {
    return fs.promises.readFile(fsPath, 'utf8').catch(() => undefined);
}

function ask(question: string): Promise<string> {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    return new Promise(resolve => rl.question(question, answer => {
        rl.close();
        resolve(answer);
    }));
}

function packageVersion(): string {
    // cli/dist/cli.js in the npm package, out/cli.js in the repo.
    for (const candidate of ['../package.json', '../cli/package.json']) {
        try {
            const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, candidate), 'utf8'));
            if (pkg.name === '@wizhut_tech/practical-uv') {
                return pkg.version;
            }
        } catch {
            // try the next one
        }
    }
    return 'unknown';
}

export async function main(argv: string[]): Promise<number> {
    let options: CliOptions;
    try {
        options = parseArgs(argv);
    } catch (err) {
        if (err instanceof UsageError) {
            console.error(`practical-uv: ${err.message}\n\n${USAGE}`);
            return 2;
        }
        throw err;
    }
    if (options.command === 'help') {
        console.log(USAGE);
        return 0;
    }
    if (options.command === 'version') {
        console.log(packageVersion());
        return 0;
    }

    const projectDir = path.resolve(options.project ?? '.');
    if (!fs.statSync(projectDir, { throwIfNoEntry: false })?.isDirectory()) {
        console.error(`practical-uv: ${projectDir} is not a folder`);
        return 1;
    }
    const requirementsFile = options.requirements
        ? path.resolve(options.requirements)
        : path.join(projectDir, 'requirements.txt');
    if (!fs.statSync(requirementsFile, { throwIfNoEntry: false })?.isFile()) {
        const shown = path.relative(process.cwd(), requirementsFile) || requirementsFile;
        const others = options.requirements ? [] : findRequirementsFiles(projectDir);
        console.error(`practical-uv: ${shown} not found`
            + (others.length > 0 ? `\nRequirements files in ${projectDir}:\n${others.map(f => `    ${f}`).join('\n')}` : ''));
        return 1;
    }

    const plan = await planConversion({
        projectDir,
        requirementsFile,
        hasPyproject: fs.existsSync(path.join(projectDir, 'pyproject.toml')),
        target: options.target,
        readText: readTextFile,
    });

    console.log(plan.prompt.detail);
    if (plan.alternative && !options.target) {
        const flag = plan.alternative.target === 'dev' ? '--dev' : '--main';
        console.log(`\n(${plan.alternative.target === 'dev' ? "For uv's dev group" : "For the project's dependencies"}, run again with ${flag}.)`);
    }
    if (options.dryRun) {
        return 0;
    }

    const uv = spawnSync('uv', ['--version'], { encoding: 'utf8' });
    if (uv.error || uv.status !== 0) {
        console.error('\npractical-uv: uv was not found on PATH. Install it from https://docs.astral.sh/uv/getting-started/installation/');
        return 1;
    }

    if (!options.yes) {
        if (!process.stdin.isTTY) {
            console.error('\npractical-uv: not a terminal, so nothing was run. Pass --yes to run without asking.');
            return 1;
        }
        const answer = await ask(`\n${plan.prompt.message} [y/N] `);
        if (!/^y(es)?$/i.test(answer.trim())) {
            console.log('Nothing was run.');
            return 1;
        }
    }

    for (const command of plan.commands) {
        console.log(`\n$ ${command}`);
        const [program, ...args] = splitCommand(command);
        const result = spawnSync(program, args, { cwd: projectDir, stdio: 'inherit' });
        if (result.error) {
            console.error(`practical-uv: ${result.error.message}`);
            return 1;
        }
        if (result.status !== 0) {
            console.error(`practical-uv: "${command}" failed, so the rest was not run.`);
            return result.status ?? 1;
        }
    }
    return 0;
}

if (require.main === module) {
    main(process.argv.slice(2)).then(
        code => { process.exitCode = code; },
        err => {
            console.error(`practical-uv: ${err instanceof Error ? err.message : err}`);
            process.exitCode = 1;
        },
    );
}
