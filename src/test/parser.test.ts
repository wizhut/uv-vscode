import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import {
    parsePep508,
    parseDocument,
    buildSnapshot,
    hasVersionUpdates,
    findDepAtPosition,
    depsOnLine,
} from '../parser';

test('parsePep508: basic == pin', () => {
    const r = parsePep508('faker==40.11.1');
    assert.deepEqual(r, {
        packageName: 'faker',
        packageWithExtras: 'faker',
        versionSpec: '==',
        currentVersion: '40.11.1',
    });
});

test('parsePep508: extras', () => {
    const r = parsePep508('fastapi[standard]==0.136.1');
    assert.deepEqual(r, {
        packageName: 'fastapi',
        packageWithExtras: 'fastapi[standard]',
        versionSpec: '==',
        currentVersion: '0.136.1',
    });
});

test('parsePep508: range specifier', () => {
    const r = parsePep508('email-validator>=2.3.0');
    assert.deepEqual(r, {
        packageName: 'email-validator',
        packageWithExtras: 'email-validator',
        versionSpec: '>=',
        currentVersion: '2.3.0',
    });
});

test('parsePep508: bare package without version', () => {
    const r = parsePep508('requests');
    assert.deepEqual(r, {
        packageName: 'requests',
        packageWithExtras: 'requests',
        versionSpec: '',
        currentVersion: '',
    });
});

test('parsePep508: rejects invalid input', () => {
    assert.equal(parsePep508('!!!nonsense'), null);
    assert.equal(parsePep508(''), null);
});

const SAMPLE_INLINE = `[dependency-groups]
dev = ['faker==40.11.1', 'pytest==9.0.2']

[project]
dependencies = ['cryptography==47.0.0', 'email-validator>=2.3.0', 'fastapi[standard]==0.136.1', 'pymongo==4.17.0', 'httpx>=0.28.1']
description = 'Innovative monitoring & observability service'
name = 'cloudproc-service'
readme = 'README.md'
requires-python = '>=3.14'
version = '0.2.6'
`;

test('parseDocument: handles single-quoted inline arrays (regression)', () => {
    const parsed = parseDocument(SAMPLE_INLINE);
    assert.equal(parsed.error, undefined);
    assert.equal(parsed.projectVersion, '0.2.6');

    const names = parsed.deps.map(d => d.packageName).sort();
    assert.deepEqual(names, [
        'cryptography',
        'email-validator',
        'faker',
        'fastapi',
        'httpx',
        'pymongo',
        'pytest',
    ]);
});

test('parseDocument: assigns correct sections', () => {
    const parsed = parseDocument(SAMPLE_INLINE);

    const bySection = new Map<string, string[]>();
    for (const dep of parsed.deps) {
        const list = bySection.get(dep.section) ?? [];
        list.push(dep.packageName);
        bySection.set(dep.section, list);
    }

    assert.deepEqual(bySection.get('dependency-groups.dev')?.sort(), ['faker', 'pytest']);
    assert.deepEqual(
        bySection.get('project.dependencies')?.sort(),
        ['cryptography', 'email-validator', 'fastapi', 'httpx', 'pymongo']
    );
});

test('parseDocument: locates each dep on the right line and column', () => {
    const parsed = parseDocument(SAMPLE_INLINE);
    const lines = SAMPLE_INLINE.split('\n');

    for (const dep of parsed.deps) {
        const line = lines[dep.line];
        const slice = line.slice(dep.contentStart, dep.contentEnd);
        assert.equal(slice, dep.raw, `expected '${dep.raw}' at line ${dep.line}, got '${slice}'`);
        // Quote chars surround the content
        assert.match(line[dep.contentStart - 1], /['"]/);
        assert.match(line[dep.contentEnd], /['"]/);
    }
});

test('parseDocument: handles multi-line arrays with double quotes', () => {
    const text = `[project]
name = "demo"
version = "1.2.3"
dependencies = [
    "requests==2.31.0",
    "httpx>=0.28.1",
]

[project.optional-dependencies]
test = ["pytest==8.0.0"]
`;
    const parsed = parseDocument(text);
    assert.equal(parsed.error, undefined);
    assert.equal(parsed.projectVersion, '1.2.3');

    const requests = parsed.deps.find(d => d.packageName === 'requests');
    assert.ok(requests, 'requests missing');
    assert.equal(requests!.line, 4);
    assert.equal(requests!.section, 'project.dependencies');
    assert.equal(requests!.currentVersion, '2.31.0');

    const pytest = parsed.deps.find(d => d.packageName === 'pytest');
    assert.ok(pytest, 'pytest missing');
    assert.equal(pytest!.section, 'project.optional-dependencies.test');
});

test('parseDocument: handles mixed quote styles in same file', () => {
    const text = `[project]
dependencies = ['a==1.0', "b==2.0"]
`;
    const parsed = parseDocument(text);
    assert.equal(parsed.deps.length, 2);
    const lines = text.split('\n');
    const a = parsed.deps.find(d => d.packageName === 'a')!;
    const b = parsed.deps.find(d => d.packageName === 'b')!;
    assert.equal(lines[a.line][a.contentStart - 1], "'");
    assert.equal(lines[b.line][b.contentStart - 1], '"');
    assert.equal(lines[a.line].slice(a.contentStart, a.contentEnd), 'a==1.0');
    assert.equal(lines[b.line].slice(b.contentStart, b.contentEnd), 'b==2.0');
});

test('parseDocument: distinguishes duplicate strings across lines', () => {
    const text = `[dependency-groups]
dev = ["pytest==9.0.2"]
ci = ["pytest==9.0.2"]
`;
    const parsed = parseDocument(text);
    const pytestDeps = parsed.deps.filter(d => d.packageName === 'pytest');
    assert.equal(pytestDeps.length, 2);
    assert.notEqual(pytestDeps[0].line, pytestDeps[1].line);
    const sections = pytestDeps.map(d => d.section).sort();
    assert.deepEqual(sections, ['dependency-groups.ci', 'dependency-groups.dev']);
});

test('parseDocument: returns error on invalid TOML', () => {
    const parsed = parseDocument('not = valid = toml = at = all');
    assert.ok(parsed.error);
    assert.equal(parsed.deps.length, 0);
});

test('parseDocument: ignores non-string array entries', () => {
    const text = `[project]
dependencies = ["good==1.0"]
[other]
mixed = [1, 2, 3]
`;
    const parsed = parseDocument(text);
    assert.equal(parsed.deps.length, 1);
    assert.equal(parsed.deps[0].packageName, 'good');
});

test('findDepAtPosition: returns dep when cursor is inside content', () => {
    const parsed = parseDocument(SAMPLE_INLINE);
    const lines = SAMPLE_INLINE.split('\n');
    // The faker dep on line 1
    const fakerLine = lines.findIndex(l => l.includes('faker'));
    const fakerCol = lines[fakerLine].indexOf('faker') + 2;
    const dep = findDepAtPosition(parsed, fakerLine, fakerCol);
    assert.ok(dep);
    assert.equal(dep!.packageName, 'faker');
});

test('findDepAtPosition: returns null when cursor is outside any dep', () => {
    const parsed = parseDocument(SAMPLE_INLINE);
    const dep = findDepAtPosition(parsed, 0, 0);
    assert.equal(dep, null);
});

test('depsOnLine: returns all deps on a single inline line', () => {
    const parsed = parseDocument(SAMPLE_INLINE);
    const projectDepsLine = SAMPLE_INLINE.split('\n').findIndex(l => l.startsWith('dependencies = ['));
    const onLine = depsOnLine(parsed, projectDepsLine);
    assert.equal(onLine.length, 5);
});

test('buildSnapshot: maps section:package to spec+version', () => {
    const parsed = parseDocument(SAMPLE_INLINE);
    const snap = buildSnapshot(parsed);
    assert.equal(snap.projectVersion, '0.2.6');
    assert.equal(snap.dependencyVersions.get('project.dependencies:fastapi'), '==0.136.1');
    assert.equal(snap.dependencyVersions.get('project.dependencies:email-validator'), '>=2.3.0');
    assert.equal(snap.dependencyVersions.get('dependency-groups.dev:pytest'), '==9.0.2');
});

test('buildSnapshot: skips deps without a pinned version', () => {
    const parsed = parseDocument(`[project]
dependencies = ["unpinned"]
`);
    const snap = buildSnapshot(parsed);
    assert.equal(snap.dependencyVersions.size, 0);
});

test('hasVersionUpdates: detects dep version change', () => {
    const before = buildSnapshot(parseDocument(`[project]
version = "1.0.0"
dependencies = ["x==1.0.0"]
`));
    const after = buildSnapshot(parseDocument(`[project]
version = "1.0.0"
dependencies = ["x==1.1.0"]
`));
    const r = hasVersionUpdates(before, after);
    assert.equal(r.dependencyChanged, true);
    assert.equal(r.projectVersionChanged, false);
});

test('hasVersionUpdates: detects project version change', () => {
    const before = buildSnapshot(parseDocument(`[project]
version = "1.0.0"
dependencies = ["x==1.0.0"]
`));
    const after = buildSnapshot(parseDocument(`[project]
version = "1.0.1"
dependencies = ["x==1.0.0"]
`));
    const r = hasVersionUpdates(before, after);
    assert.equal(r.dependencyChanged, false);
    assert.equal(r.projectVersionChanged, true);
});

test('hasVersionUpdates: no previous snapshot means no changes', () => {
    const after = buildSnapshot(parseDocument(SAMPLE_INLINE));
    const r = hasVersionUpdates(undefined, after);
    assert.equal(r.dependencyChanged, false);
    assert.equal(r.projectVersionChanged, false);
});

test('hasVersionUpdates: newly added dep alone is not a change', () => {
    const before = buildSnapshot(parseDocument(`[project]
dependencies = ["x==1.0.0"]
`));
    const after = buildSnapshot(parseDocument(`[project]
dependencies = ["x==1.0.0", "y==2.0.0"]
`));
    const r = hasVersionUpdates(before, after);
    assert.equal(r.dependencyChanged, false);
});
