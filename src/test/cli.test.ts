import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as path from 'path';
import { UsageError, parseArgs, planConversion, splitCommand } from '../cli';
import { INIT_COMMAND, convertCommands } from '../convert';

test('parseArgs: convert is the default command', () => {
    assert.deepEqual(parseArgs([]), { command: 'convert', dryRun: false, yes: false, requirements: undefined });
    assert.equal(parseArgs(['requirements-dev.txt']).requirements, 'requirements-dev.txt');
    assert.equal(parseArgs(['convert', 'requirements-dev.txt']).requirements, 'requirements-dev.txt');
});

test('parseArgs: options', () => {
    const options = parseArgs(['convert', '-C', 'app', '--dev', '-n', '-y', 'reqs/dev.txt']);
    assert.equal(options.project, 'app');
    assert.equal(options.target, 'dev');
    assert.equal(options.dryRun, true);
    assert.equal(options.yes, true);
    assert.equal(options.requirements, 'reqs/dev.txt');
    assert.equal(parseArgs(['--project=my app']).project, 'my app');
    assert.equal(parseArgs(['--main']).target, 'main');
    assert.equal(parseArgs(['x.txt', '--help']).command, 'help');
    assert.equal(parseArgs(['help']).command, 'help');
    assert.equal(parseArgs(['-V']).command, 'version');
});

test('parseArgs: mistakes are usage errors', () => {
    assert.throws(() => parseArgs(['--dev', '--main']), UsageError);
    assert.throws(() => parseArgs(['--frobnicate']), UsageError);
    assert.throws(() => parseArgs(['-C']), UsageError);
    assert.throws(() => parseArgs(['a.txt', 'b.txt']), UsageError);
});

test('splitCommand reverses shellArg quoting', () => {
    assert.deepEqual(splitCommand('uv init --bare'), ['uv', 'init', '--bare']);
    const [command] = convertCommands({ hasPyproject: true, requirementsPath: 'my reqs/base.txt', target: 'main' });
    assert.deepEqual(splitCommand(command), ['uv', 'add', '-r', 'my reqs/base.txt']);
    assert.deepEqual(splitCommand('uv remove --dev a b-c'), ['uv', 'remove', '--dev', 'a', 'b-c']);
});

function files(map: Record<string, string>) {
    return async (fsPath: string) => map[fsPath];
}

const root = path.resolve('/work/app');

test('planConversion: requirements.txt in a folder without pyproject.toml', async () => {
    const plan = await planConversion({
        projectDir: root,
        requirementsFile: path.join(root, 'requirements.txt'),
        hasPyproject: false,
        readText: files({}),
    });
    assert.equal(plan.choice.target, 'main');
    assert.equal(plan.alternative, undefined);
    assert.deepEqual(plan.commands, [INIT_COMMAND, 'uv add -r requirements.txt']);
    assert.equal(plan.prompt.message, 'Convert app to a uv project?');
    assert.match(plan.prompt.detail, /uv add -r requirements\.txt/);
});

test('planConversion: a dev file that includes requirements.txt is split', async () => {
    const plan = await planConversion({
        projectDir: root,
        requirementsFile: path.join(root, 'requirements-dev.txt'),
        hasPyproject: true,
        readText: files({
            [path.join(root, 'requirements-dev.txt')]: '-r requirements.txt\npytest\n',
            [path.join(root, 'requirements.txt')]: 'Django>=5\nrequests\n',
        }),
    });
    assert.equal(plan.choice.target, 'dev');
    assert.equal(plan.alternative?.target, 'main');
    assert.deepEqual(plan.commands, [
        'uv add -r requirements.txt',
        'uv add --dev -r requirements-dev.txt',
        'uv remove --dev django requests',
    ]);
});

test('planConversion: --main overrides the file name', async () => {
    const plan = await planConversion({
        projectDir: root,
        requirementsFile: path.join(root, 'requirements-dev.txt'),
        hasPyproject: true,
        target: 'main',
        readText: files({}),
    });
    assert.deepEqual(plan.commands, ['uv add -r requirements-dev.txt']);
    assert.equal(plan.alternative?.target, 'dev');
});

test('planConversion: --dev works on requirements.txt too', async () => {
    const plan = await planConversion({
        projectDir: root,
        requirementsFile: path.join(root, 'requirements.txt'),
        hasPyproject: true,
        target: 'dev',
        readText: files({ [path.join(root, 'requirements.txt')]: 'requests\n' }),
    });
    assert.deepEqual(plan.commands, ['uv add --dev -r requirements.txt']);
});

test('planConversion: a file outside the project folder keeps its relative path', async () => {
    const plan = await planConversion({
        projectDir: root,
        requirementsFile: path.resolve('/work/shared/requirements.txt'),
        hasPyproject: true,
        readText: files({}),
    });
    assert.deepEqual(plan.commands, [`uv add -r ${path.join('..', 'shared', 'requirements.txt')}`]);
});
