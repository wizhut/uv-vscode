import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { parseRequirements, findDepAtPosition } from '../parser';

test('parseRequirements: basic pinned deps', () => {
    const text = `requests==2.31.0
httpx>=0.28.1
pymongo==4.17.0
`;
    const parsed = parseRequirements(text);
    assert.equal(parsed.deps.length, 3);

    const requests = parsed.deps[0];
    assert.equal(requests.packageName, 'requests');
    assert.equal(requests.versionSpec, '==');
    assert.equal(requests.currentVersion, '2.31.0');
    assert.equal(requests.section, 'requirements');
    assert.equal(requests.line, 0);
    assert.equal(requests.contentStart, 0);
    assert.equal(requests.contentEnd, 'requests==2.31.0'.length);
});

test('parseRequirements: extras and ranges', () => {
    const text = `fastapi[standard]==0.136.1
email-validator>=2.3.0
`;
    const parsed = parseRequirements(text);
    assert.equal(parsed.deps.length, 2);
    assert.equal(parsed.deps[0].packageName, 'fastapi');
    assert.equal(parsed.deps[0].packageWithExtras, 'fastapi[standard]');
    assert.equal(parsed.deps[0].currentVersion, '0.136.1');
    assert.equal(parsed.deps[1].packageName, 'email-validator');
    assert.equal(parsed.deps[1].versionSpec, '>=');
});

test('parseRequirements: skips comments and blank lines', () => {
    const text = `# Production deps
requests==2.31.0

# Below: HTTP client
httpx>=0.28.1
`;
    const parsed = parseRequirements(text);
    assert.equal(parsed.deps.length, 2);
    assert.equal(parsed.deps[0].line, 1);
    assert.equal(parsed.deps[1].line, 4);
});

test('parseRequirements: strips inline comments', () => {
    const text = `requests==2.31.0  # http library
`;
    const parsed = parseRequirements(text);
    assert.equal(parsed.deps.length, 1);
    const dep = parsed.deps[0];
    assert.equal(dep.contentEnd, 'requests==2.31.0'.length);
    assert.equal(text.slice(dep.contentStart, dep.contentEnd), 'requests==2.31.0');
});

test('parseRequirements: strips PEP 508 environment markers', () => {
    const text = `pywin32==306; sys_platform == "win32"
`;
    const parsed = parseRequirements(text);
    assert.equal(parsed.deps.length, 1);
    const dep = parsed.deps[0];
    assert.equal(dep.packageName, 'pywin32');
    assert.equal(dep.currentVersion, '306');
    assert.equal(text.slice(dep.contentStart, dep.contentEnd), 'pywin32==306');
});

test('parseRequirements: handles leading whitespace (indented lines)', () => {
    const text = `    requests==2.31.0
`;
    const parsed = parseRequirements(text);
    assert.equal(parsed.deps.length, 1);
    assert.equal(parsed.deps[0].contentStart, 4);
    assert.equal(parsed.deps[0].contentEnd, 4 + 'requests==2.31.0'.length);
});

test('parseRequirements: skips pip directives', () => {
    const text = `-r common.txt
-e .
-c constraints.txt
--index-url https://pypi.org/simple
--extra-index-url https://pypi.org/simple
requests==2.31.0
`;
    const parsed = parseRequirements(text);
    assert.equal(parsed.deps.length, 1);
    assert.equal(parsed.deps[0].packageName, 'requests');
});

test('parseRequirements: skips direct URL specs (pkg @ url)', () => {
    const text = `mylib @ https://example.com/mylib-1.0.tar.gz
requests==2.31.0
`;
    const parsed = parseRequirements(text);
    assert.equal(parsed.deps.length, 1);
    assert.equal(parsed.deps[0].packageName, 'requests');
});

test('parseRequirements: keeps unpinned deps (no version)', () => {
    const text = `requests
httpx
`;
    const parsed = parseRequirements(text);
    assert.equal(parsed.deps.length, 2);
    assert.equal(parsed.deps[0].currentVersion, '');
    assert.equal(parsed.deps[0].versionSpec, '');
});

test('parseRequirements: handles CRLF line endings', () => {
    const text = 'requests==2.31.0\r\nhttpx>=0.28.1\r\n';
    const parsed = parseRequirements(text);
    assert.equal(parsed.deps.length, 2);
    assert.equal(parsed.deps[0].line, 0);
    assert.equal(parsed.deps[1].line, 1);
});

test('parseRequirements: rejects invalid lines', () => {
    const text = `===junk
!!!nonsense
requests==2.31.0
`;
    const parsed = parseRequirements(text);
    assert.equal(parsed.deps.length, 1);
    assert.equal(parsed.deps[0].packageName, 'requests');
});

test('parseRequirements + findDepAtPosition: cursor inside dep', () => {
    const text = `requests==2.31.0
httpx>=0.28.1
`;
    const parsed = parseRequirements(text);
    // cursor on "requests"
    const r = findDepAtPosition(parsed, 0, 3);
    assert.ok(r);
    assert.equal(r!.packageName, 'requests');
    // cursor on "httpx"
    const h = findDepAtPosition(parsed, 1, 2);
    assert.ok(h);
    assert.equal(h!.packageName, 'httpx');
});

test('parseRequirements: no error field on success', () => {
    const parsed = parseRequirements('requests==2.31.0\n');
    assert.equal(parsed.error, undefined);
});

test('parseRequirements: positions allow upgrade replacement', () => {
    const text = `requests==2.31.0  # comment
`;
    const parsed = parseRequirements(text);
    const dep = parsed.deps[0];
    const lineText = text.split(/\r?\n/)[dep.line];
    const newItem = `${dep.packageWithExtras}${dep.versionSpec}3.0.0`;
    const replaced = lineText.slice(0, dep.contentStart) + newItem + lineText.slice(dep.contentEnd);
    assert.equal(replaced, 'requests==3.0.0  # comment');
});
