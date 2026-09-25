// The logic behind "UV: Convert requirements.txt to uv project": which
// dependency group a requirements file belongs in, what it pulls in from
// other files, the exact uv commands to run, and the confirmation that lists
// them. No `vscode` imports, so it stays unit-testable (src/test/convert.test.ts).
import * as path from 'path';
import { normalizePackageName } from './parser';

/** What a requirements file's name says about its contents. */
export type RequirementsKind = 'main' | 'dev' | 'other';

/** Where an import puts the packages: the project's dependencies, or uv's dev group. */
export type ImportTarget = 'main' | 'dev';

/**
 * `--bare` writes pyproject.toml and nothing else (uv 0.5.29+). Plain
 * `uv init` also creates a src/ package with a hello-world entry point, a
 * build backend, README.md, .python-version and a git repository (uv 0.12) —
 * none of which belongs in a project that is being migrated.
 */
export const INIT_COMMAND = 'uv init --bare';

// Name tokens that mark requirements the project does not need at runtime:
// requirements-dev.txt, requirements_test.txt, requirements/local.txt
// (cookiecutter-django's development file), requirements/docs.txt, ...
const DEV_TOKENS = new Set([
    'dev', 'devel', 'develop', 'development', 'local',
    'test', 'tests', 'testing', 'lint', 'docs', 'doc',
]);

// Name tokens that mark the runtime requirements: requirements.txt,
// requirements/base.txt, requirements-prod.txt, ...
const MAIN_TOKENS = new Set([
    'requirements', 'base', 'common', 'core', 'main', 'default',
    'prod', 'production', 'runtime',
]);

/**
 * Classifies a requirements file by its name alone: `requirements-dev.txt`,
 * `requirements_test.txt` and `requirements/dev.txt` are 'dev';
 * `requirements.txt`, `requirements/base.txt` and `requirements-prod.txt` are
 * 'main'; a name that says neither (`requirements-ml.txt`) is 'other'.
 */
export function classifyRequirementsFile(filePath: string): RequirementsKind {
    const base = path.basename(filePath).toLowerCase();
    const ext = base.endsWith('.txt') ? '.txt' : base.endsWith('.in') ? '.in' : '';
    const stem = base.slice(0, base.length - ext.length).replace(/^requirements(?:[-_.]|$)/, '');
    const tokens = stem.split(/[-_.]+/).filter(Boolean);
    if (tokens.length === 0) {
        return 'main';
    }
    if (tokens.some(t => DEV_TOKENS.has(t))) {
        return 'dev';
    }
    if (tokens.every(t => MAIN_TOKENS.has(t))) {
        return 'main';
    }
    return 'other';
}

/**
 * The file's logical lines as pip reads them: a line ending in a backslash is
 * joined to the next, and comments (`#` at the start or after whitespace) are
 * dropped. pip-compile writes each `--hash` on a continuation line, so without
 * the join those would look like stray options.
 */
function logicalLines(text: string): string[] {
    const lines: string[] = [];
    let pending = '';
    for (const raw of text.split(/\r?\n/)) {
        if (raw.endsWith('\\') && !/^\s*#/.test(raw)) {
            pending += raw.slice(0, -1);
            continue;
        }
        const line = (pending + raw).replace(/(^|\s)#.*$/, '').trim();
        pending = '';
        if (line) {
            lines.push(line);
        }
    }
    if (pending.trim()) {
        lines.push(pending.replace(/(^|\s)#.*$/, '').trim());
    }
    return lines;
}

/**
 * The files a requirements file pulls in with `-r` / `--requirement`, as
 * written in it. Constraint files (`-c`) add no packages, and remote includes
 * are not files the conversion can read, so neither is returned.
 */
export function requirementIncludes(text: string): string[] {
    const includes: string[] = [];
    for (const line of logicalLines(text)) {
        const m = line.match(/^(?:-r\s*|--requirement(?:\s*=\s*|\s+))(.+)$/);
        if (!m) {
            continue;
        }
        let target = m[1].trim();
        const quoted = target.match(/^(["'])(.*)\1$/);
        if (quoted) {
            target = quoted[2];
        }
        if (target && !/^[a-z][a-z0-9+.-]*:\/\//i.test(target)) {
            includes.push(target);
        }
    }
    return includes;
}

/**
 * The normalized names of the packages a requirements file lists itself.
 * Options, includes, editable installs, and bare paths, URLs or archives are
 * skipped: those are not names uv writes into pyproject.toml.
 */
export function requirementNames(text: string): string[] {
    const names: string[] = [];
    for (const line of logicalLines(text)) {
        if (line.startsWith('-')) {
            continue;
        }
        // A PEP 508 name, followed by the end of the line or by what may follow
        // a name (extras, a version, a marker, `@ url`). `https://…`, `./lib`
        // and `git+https://…` fail the lookahead, which is the point.
        const m = line.match(/^([A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?)(?=$|[\s[<>=!~;@(,])/);
        if (!m || /\.(?:whl|zip|tar|tgz|tar\.gz|tar\.bz2)$/i.test(m[1])) {
            continue;
        }
        const name = normalizePackageName(m[1]);
        if (!names.includes(name)) {
            names.push(name);
        }
    }
    return names;
}

/** What a requirements file brings in from the runtime requirements. */
export interface IncludedRequirements {
    /** Runtime ('main') files it includes directly, as absolute paths. */
    mainIncludes: string[];
    /**
     * Packages those files list — following their own includes, as uv does —
     * that the file does not list itself. Normalized names, in the order found.
     */
    inheritedPackages: string[];
}

/**
 * Finds the runtime requirements a file includes. A development file usually
 * starts with `-r requirements.txt`, and uv follows that line: importing the
 * file into the dev group would copy every runtime package into it as well.
 * These are the files to import into the project's dependencies first, and
 * the packages to take back out of the dev group afterwards.
 *
 * `readText` returns a file's contents, or undefined when it cannot be read;
 * an unreadable file simply contributes nothing.
 */
export async function collectMainIncludes(
    filePath: string,
    text: string,
    readText: (absolutePath: string) => Promise<string | undefined>,
): Promise<IncludedRequirements> {
    const self = path.resolve(filePath);
    const own = new Set(requirementNames(text));
    const mainIncludes = requirementIncludes(text)
        .map(include => path.resolve(path.dirname(self), include))
        .filter(include => include !== self && classifyRequirementsFile(include) === 'main')
        .filter((include, i, all) => all.indexOf(include) === i);

    // Everything reachable from those files, whatever it is called: importing
    // them into the project follows every include, and so did the dev import.
    const inheritedPackages: string[] = [];
    const seen = new Set<string>([self]);
    const queue = [...mainIncludes];
    while (queue.length > 0) {
        const file = queue.shift()!;
        if (seen.has(file)) {
            continue;
        }
        seen.add(file);
        const contents = await readText(file);
        if (contents === undefined) {
            continue;
        }
        for (const name of requirementNames(contents)) {
            if (!own.has(name) && !inheritedPackages.includes(name)) {
                inheritedPackages.push(name);
            }
        }
        for (const include of requirementIncludes(contents)) {
            queue.push(path.resolve(path.dirname(file), include));
        }
    }
    return { mainIncludes, inheritedPackages };
}

/**
 * Quotes a path for the terminal when it contains whitespace. A plain path in
 * double quotes means the same thing in bash, zsh, fish, PowerShell and cmd.
 */
export function shellArg(value: string): string {
    return /\s/.test(value) ? `"${value}"` : value;
}

export interface ConvertCommandsInput {
    /** Whether the workspace folder already has a pyproject.toml. */
    hasPyproject: boolean;
    /** The requirements file, relative to the workspace folder. */
    requirementsPath: string;
    target: ImportTarget;
    /** For a dev import: the runtime files it includes, relative to the workspace folder. */
    mainIncludes?: string[];
    /** For a dev import: the packages to take back out of the dev group. */
    inheritedPackages?: string[];
}

/** The uv commands a conversion runs, in order, exactly as they are sent to the terminal. */
export function convertCommands(input: ConvertCommandsInput): string[] {
    const commands: string[] = [];
    if (!input.hasPyproject) {
        commands.push(INIT_COMMAND);
    }
    const file = shellArg(input.requirementsPath);
    if (input.target === 'main') {
        commands.push(`uv add -r ${file}`);
        return commands;
    }
    for (const include of input.mainIncludes ?? []) {
        commands.push(`uv add -r ${shellArg(include)}`);
    }
    commands.push(`uv add --dev -r ${file}`);
    const inherited = input.inheritedPackages ?? [];
    if (inherited.length > 0) {
        commands.push(`uv remove --dev ${inherited.join(' ')}`);
    }
    return commands;
}

/** A button on the confirmation. */
export interface ConvertChoice {
    label: string;
    target: ImportTarget;
}

/**
 * The confirmation's buttons, the one the file name suggests first.
 * requirements.txt and its runtime siblings are not asked about.
 */
export function convertChoices(kind: RequirementsKind): ConvertChoice[] {
    const main: ConvertChoice = { label: 'Main Dependencies', target: 'main' };
    const dev: ConvertChoice = { label: 'Dev Group', target: 'dev' };
    switch (kind) {
        case 'main':
            return [{ label: 'Convert', target: 'main' }];
        case 'dev':
            return [dev, main];
        default:
            return [main, dev];
    }
}

const DISPLAY_LIMIT = 100;

/**
 * A command as the confirmation shows it. A `uv remove --dev` that names every
 * package of a long requirements.txt is cut short with a count of the rest;
 * the terminal still receives the whole command.
 */
export function displayCommand(command: string): string {
    if (command.length <= DISPLAY_LIMIT) {
        return command;
    }
    const words = command.split(' ');
    let shown = words[0];
    let i = 1;
    while (i < words.length && shown.length + 1 + words[i].length <= DISPLAY_LIMIT) {
        shown += ' ' + words[i];
        i++;
    }
    return `${shown} … (+${words.length - i} more)`;
}

export interface ConvertPrompt {
    message: string;
    detail: string;
}

function listFiles(files: string[]): string {
    if (files.length <= 1) {
        return files.join('');
    }
    return `${files.slice(0, -1).join(', ')} and ${files[files.length - 1]}`;
}

/**
 * The confirmation's text. It lists the commands behind every button, so what
 * it says is what runs.
 */
export function convertPrompt(input: {
    folderName: string;
    requirementsPath: string;
    choices: ConvertChoice[];
    commands: Record<ImportTarget, string[]>;
    mainIncludes: string[];
    /** The open file has unsaved changes, which are saved before uv reads it. */
    unsaved?: boolean;
}): ConvertPrompt {
    const { folderName, requirementsPath: file, choices, commands, mainIncludes } = input;
    const initializes = commands[choices[0].target][0] === INIT_COMMAND;
    const indent = (list: string[]) => list.map(c => `    ${displayCommand(c)}`);

    const sections: string[] = [];
    if (choices.length === 1) {
        sections.push([`Runs in the terminal, in ${folderName}:`, ...indent(commands[choices[0].target])].join('\n'));
    } else {
        for (const choice of choices) {
            sections.push([`${choice.label} runs, in ${folderName}:`, ...indent(commands[choice.target])].join('\n'));
        }
    }

    const notes: string[] = [];
    if (initializes) {
        notes.push(`"${INIT_COMMAND}" creates pyproject.toml and nothing else.`);
    }
    const dev = choices.find(c => c.target === 'dev');
    if (dev && mainIncludes.length > 0) {
        const takesBack = commands.dev.some(c => c.startsWith('uv remove --dev '));
        notes.push(`${file} includes ${listFiles(mainIncludes)}, so ${dev.label} first imports ${mainIncludes.length === 1 ? 'it' : 'them'} into the project's dependencies`
            + (takesBack ? ', then takes those packages back out of the dev group.' : '.'));
    }
    notes.push(input.unsaved
        ? `Your unsaved changes to ${file} are saved first; uv only reads it.`
        : `${file} is read, not changed.`);
    sections.push(notes.join(' '));

    let message: string;
    if (choices.length > 1) {
        message = `Where should the packages in ${file} go?`;
    } else if (initializes) {
        message = `Convert ${folderName} to a uv project?`;
    } else {
        message = `Import ${file} into the uv project in ${folderName}?`;
    }
    return { message, detail: sections.join('\n\n') };
}
