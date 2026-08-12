import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { normalizePackageName } from '../parser';
import {
    parseVersion,
    compareVersions,
    specToInterval,
    constraintToInterval,
    intervalContains,
    intervalsIntersect,
    isEmptyInterval,
    parseUvLock,
    rangeToIntervals,
    isVersionAffected,
    specPermitsVulnerable,
    fixedVersionsFor,
    severityOf,
    cvssVectorOf,
    resolveVersion,
    auditDependencies,
    dedupeFindings,
    OsvClient,
    HttpClient,
    OsvVulnerability,
    PyVersion,
} from '../audit';

function v(text: string): PyVersion {
    const parsed = parseVersion(text);
    assert.ok(parsed, `expected ${text} to parse`);
    return parsed;
}

function cmp(a: string, b: string): number {
    return compareVersions(v(a), v(b));
}

// ---------------------------------------------------------------------------
// Name normalization
// ---------------------------------------------------------------------------

test('normalizePackageName: PEP 503 forms collapse to one name', () => {
    const expected = 'typing-extensions';
    assert.equal(normalizePackageName('typing_extensions'), expected);
    assert.equal(normalizePackageName('Typing.Extensions'), expected);
    assert.equal(normalizePackageName('TYPING--EXTENSIONS'), expected);
    assert.equal(normalizePackageName('  typing-extensions  '), expected);
});

test('normalizePackageName: case-only difference', () => {
    assert.equal(normalizePackageName('Flask'), 'flask');
});

// ---------------------------------------------------------------------------
// PEP 440 parsing and ordering
// ---------------------------------------------------------------------------

test('parseVersion: plain release', () => {
    assert.deepEqual(v('2.31.0').release, [2, 31, 0]);
    assert.equal(v('2.31.0').epoch, 0);
    assert.equal(v('2.31.0').pre, null);
});

test('parseVersion: epoch, pre, post and dev segments', () => {
    assert.equal(v('1!2.0').epoch, 1);
    assert.deepEqual(v('2.0rc1').pre, [2, 1]);
    assert.deepEqual(v('2.0b2').pre, [1, 2]);
    assert.deepEqual(v('2.0alpha3').pre, [0, 3]);
    assert.equal(v('2.0.post1').post, 1);
    assert.equal(v('2.0-1').post, 1);
    assert.equal(v('2.0.dev5').dev, 5);
});

test('parseVersion: rejects junk', () => {
    assert.equal(parseVersion('not-a-version'), null);
    assert.equal(parseVersion(''), null);
    assert.equal(parseVersion('1.2.*'), null);
});

test('parseVersion: ignores local version segment', () => {
    assert.deepEqual(v('1.2.3+ubuntu1').release, [1, 2, 3]);
});

test('compareVersions: numeric segments compare as numbers, not strings', () => {
    assert.equal(cmp('1.10.0', '1.9.0'), 1);
    assert.equal(cmp('2.0', '10.0'), -1);
});

test('compareVersions: trailing zeros are insignificant', () => {
    assert.equal(cmp('1.0', '1.0.0'), 0);
    assert.equal(cmp('1.0.0.0', '1'), 0);
});

test('compareVersions: PEP 440 ordering of pre/post/dev', () => {
    const ordered = ['1.0.dev1', '1.0a1', '1.0b1', '1.0rc1', '1.0', '1.0.post1', '1.1'];
    for (let i = 0; i < ordered.length - 1; i++) {
        assert.equal(cmp(ordered[i], ordered[i + 1]), -1, `${ordered[i]} < ${ordered[i + 1]}`);
        assert.equal(cmp(ordered[i + 1], ordered[i]), 1, `${ordered[i + 1]} > ${ordered[i]}`);
    }
});

test('compareVersions: epoch dominates release', () => {
    assert.equal(cmp('1!1.0', '99.0'), 1);
});

test('compareVersions: equal versions written differently', () => {
    assert.equal(cmp('1.0rc1', '1.0c1'), 0);
    assert.equal(cmp('1.0alpha1', '1.0a1'), 0);
});

// ---------------------------------------------------------------------------
// Constraint intervals
// ---------------------------------------------------------------------------

test('constraintToInterval: >= is a closed lower bound', () => {
    const i = constraintToInterval('>=', '2.0');
    assert.ok(intervalContains(i, v('2.0')));
    assert.ok(intervalContains(i, v('99.0')));
    assert.ok(!intervalContains(i, v('1.9')));
});

test('constraintToInterval: > excludes the boundary', () => {
    const i = constraintToInterval('>', '2.0');
    assert.ok(!intervalContains(i, v('2.0')));
    assert.ok(intervalContains(i, v('2.0.1')));
});

test('constraintToInterval: ~= bumps the last segment', () => {
    const i = constraintToInterval('~=', '1.4.5');
    assert.ok(intervalContains(i, v('1.4.5')));
    assert.ok(intervalContains(i, v('1.4.99')));
    assert.ok(!intervalContains(i, v('1.5.0')));
    assert.ok(!intervalContains(i, v('1.4.4')));
});

test('constraintToInterval: == with wildcard is a prefix match', () => {
    const i = constraintToInterval('==', '1.4.*');
    assert.ok(intervalContains(i, v('1.4')));
    assert.ok(intervalContains(i, v('1.4.7')));
    assert.ok(!intervalContains(i, v('1.5')));
});

test('constraintToInterval: != is treated as unbounded', () => {
    const i = constraintToInterval('!=', '1.0');
    assert.ok(intervalContains(i, v('1.0')));
    assert.ok(intervalContains(i, v('9.9')));
});

test('specToInterval: comma-separated constraints are ANDed', () => {
    const i = specToInterval('>=2.0,<3.0');
    assert.ok(intervalContains(i, v('2.5')));
    assert.ok(!intervalContains(i, v('1.9')));
    assert.ok(!intervalContains(i, v('3.0')));
});

test('specToInterval: empty spec permits everything', () => {
    const i = specToInterval('');
    assert.ok(intervalContains(i, v('0.0.1')));
    assert.ok(intervalContains(i, v('1000.0')));
});

test('isEmptyInterval: contradictory constraints', () => {
    assert.ok(isEmptyInterval(specToInterval('>=3.0,<2.0')));
    assert.ok(!isEmptyInterval(specToInterval('>=2.0,<3.0')));
});

test('intervalsIntersect: touching bounds', () => {
    // [2.0, 3.0) vs [3.0, inf) — adjacent, not overlapping
    assert.ok(!intervalsIntersect(specToInterval('>=2.0,<3.0'), specToInterval('>=3.0')));
    // [2.0, 3.0] vs [3.0, inf) — share exactly one point
    assert.ok(intervalsIntersect(specToInterval('>=2.0,<=3.0'), specToInterval('>=3.0')));
});

// ---------------------------------------------------------------------------
// uv.lock
// ---------------------------------------------------------------------------

const SAMPLE_LOCK = `version = 1
requires-python = ">=3.11"

[[package]]
name = "my-project"
version = "0.1.0"
source = { virtual = "." }
dependencies = [
    { name = "flask" },
]

[[package]]
name = "Flask"
version = "3.0.0"
source = { registry = "https://pypi.org/simple" }
dependencies = [
    { name = "werkzeug" },
]

[[package]]
name = "typing_extensions"
version = "4.12.2"
source = { registry = "https://pypi.org/simple" }

[[package]]
name = "werkzeug"
version = "3.0.1"
source = { registry = "https://pypi.org/simple" }

[[package]]
name = "local-lib"
version = "0.0.1"
source = { editable = "libs/local-lib" }
`;

test('parseUvLock: normalizes names and keeps exact versions', () => {
    const lock = parseUvLock(SAMPLE_LOCK);
    assert.equal(lock.get('flask'), '3.0.0');
    assert.equal(lock.get('typing-extensions'), '4.12.2');
});

test('parseUvLock: skips the virtual root and editable entries', () => {
    const lock = parseUvLock(SAMPLE_LOCK);
    assert.equal(lock.has('my-project'), false);
    assert.equal(lock.has('local-lib'), false);
});

test('parseUvLock: transitive packages are present but never queried on their own', () => {
    // werkzeug is in the lock; auditDependencies only looks up declared deps.
    const lock = parseUvLock(SAMPLE_LOCK);
    assert.equal(lock.get('werkzeug'), '3.0.1');
});

test('parseUvLock: malformed TOML yields an empty map', () => {
    assert.equal(parseUvLock('!!! not toml').size, 0);
    assert.equal(parseUvLock('').size, 0);
});

// ---------------------------------------------------------------------------
// OSV range handling
// ---------------------------------------------------------------------------

test('rangeToIntervals: introduced/fixed pair', () => {
    const intervals = rangeToIntervals({ events: [{ introduced: '2.0' }, { fixed: '2.3.1' }] });
    assert.equal(intervals.length, 1);
    assert.ok(intervalContains(intervals[0], v('2.0')));
    assert.ok(intervalContains(intervals[0], v('2.3.0')));
    assert.ok(!intervalContains(intervals[0], v('2.3.1')));
    assert.ok(!intervalContains(intervals[0], v('1.9')));
});

test('rangeToIntervals: introduced 0 is unbounded below', () => {
    const intervals = rangeToIntervals({ events: [{ introduced: '0' }, { fixed: '1.0' }] });
    assert.ok(intervalContains(intervals[0], v('0.0.1')));
    assert.ok(!intervalContains(intervals[0], v('1.0')));
});

test('rangeToIntervals: last_affected includes the boundary', () => {
    const intervals = rangeToIntervals({ events: [{ introduced: '1.0' }, { last_affected: '1.5' }] });
    assert.ok(intervalContains(intervals[0], v('1.5')));
    assert.ok(!intervalContains(intervals[0], v('1.5.1')));
});

test('rangeToIntervals: unfixed range stays open', () => {
    const intervals = rangeToIntervals({ events: [{ introduced: '1.0' }] });
    assert.ok(intervalContains(intervals[0], v('999.0')));
});

test('rangeToIntervals: multiple disjoint windows', () => {
    const intervals = rangeToIntervals({
        events: [{ introduced: '1.0' }, { fixed: '1.2' }, { introduced: '2.0' }, { fixed: '2.1' }],
    });
    assert.equal(intervals.length, 2);
    assert.ok(intervalContains(intervals[0], v('1.1')));
    assert.ok(intervalContains(intervals[1], v('2.0')));
    assert.ok(!intervals.some(i => intervalContains(i, v('1.5'))));
});

const FLASK_VULN: OsvVulnerability = {
    id: 'GHSA-m2qf-hxjv-5gpq',
    aliases: ['CVE-2023-30861'],
    summary: 'Flask vulnerable to possible disclosure of permanent session cookie',
    affected: [{
        package: { name: 'flask', ecosystem: 'PyPI' },
        ranges: [{ type: 'ECOSYSTEM', events: [{ introduced: '0' }, { fixed: '2.2.5' }] }],
    }, {
        package: { name: 'flask', ecosystem: 'PyPI' },
        ranges: [{ type: 'ECOSYSTEM', events: [{ introduced: '2.3.0' }, { fixed: '2.3.2' }] }],
    }],
    severity: [{ type: 'CVSS_V3', score: 'CVSS:3.1/AV:N/AC:H/PR:N/UI:N/S:C/C:H/I:N/A:N' }],
    database_specific: { severity: 'HIGH' },
};

test('isVersionAffected: inside and outside the affected windows', () => {
    assert.ok(isVersionAffected(FLASK_VULN, 'flask', v('2.2.4')));
    assert.ok(isVersionAffected(FLASK_VULN, 'flask', v('2.3.1')));
    assert.ok(!isVersionAffected(FLASK_VULN, 'flask', v('2.2.5')));
    assert.ok(!isVersionAffected(FLASK_VULN, 'flask', v('2.3.2')));
});

test('isVersionAffected: ignores advisories for a different package', () => {
    assert.ok(!isVersionAffected(FLASK_VULN, 'django', v('2.2.4')));
});

test('isVersionAffected: explicit versions list', () => {
    const vuln: OsvVulnerability = {
        id: 'PYSEC-0000',
        affected: [{ package: { name: 'pkg', ecosystem: 'PyPI' }, versions: ['1.0', '1.1'] }],
    };
    assert.ok(isVersionAffected(vuln, 'pkg', v('1.1')));
    assert.ok(!isVersionAffected(vuln, 'pkg', v('1.2')));
});

test('specPermitsVulnerable: an open floor permits a vulnerable version', () => {
    assert.ok(specPermitsVulnerable(FLASK_VULN, 'flask', specToInterval('>=2.0')));
});

test('specPermitsVulnerable: a raised floor excludes every window', () => {
    assert.ok(!specPermitsVulnerable(FLASK_VULN, 'flask', specToInterval('>=2.3.2')));
});

test('specPermitsVulnerable: a bare dependency permits everything', () => {
    assert.ok(specPermitsVulnerable(FLASK_VULN, 'flask', specToInterval('')));
});

test('fixedVersionsFor: collected and sorted', () => {
    assert.deepEqual(fixedVersionsFor(FLASK_VULN, 'flask'), ['2.2.5', '2.3.2']);
});

test('severityOf and cvssVectorOf', () => {
    assert.equal(severityOf(FLASK_VULN), 'HIGH');
    assert.equal(cvssVectorOf(FLASK_VULN), 'CVSS:3.1/AV:N/AC:H/PR:N/UI:N/S:C/C:H/I:N/A:N');
    assert.equal(severityOf({ id: 'X' }), 'UNKNOWN');
    assert.equal(severityOf({ id: 'X', database_specific: { severity: 'medium' } }), 'MODERATE');
    assert.equal(cvssVectorOf({ id: 'X' }), undefined);
});

// ---------------------------------------------------------------------------
// Version resolution
// ---------------------------------------------------------------------------

test('resolveVersion: lock wins over the declared spec', () => {
    const lock = new Map([['flask', '3.0.0']]);
    assert.equal(resolveVersion({ packageName: 'Flask', versionSpec: '>=', currentVersion: '2.0' }, lock), '3.0.0');
});

test('resolveVersion: == pin resolves without a lock', () => {
    assert.equal(resolveVersion({ packageName: 'flask', versionSpec: '==', currentVersion: '2.2.4' }), '2.2.4');
});

test('resolveVersion: range spec with no lock stays unresolved', () => {
    assert.equal(resolveVersion({ packageName: 'flask', versionSpec: '>=', currentVersion: '2.0' }), undefined);
    assert.equal(resolveVersion({ packageName: 'flask', versionSpec: '==', currentVersion: '2.2.*' }), undefined);
});

// ---------------------------------------------------------------------------
// OsvClient / auditDependencies
// ---------------------------------------------------------------------------

class FakeHttp implements HttpClient {
    readonly posts: { url: string; body: any }[] = [];
    readonly gets: string[] = [];

    constructor(
        private readonly idsPerQuery: string[][],
        private readonly vulns: Record<string, OsvVulnerability> = {},
    ) {}

    async postJson(url: string, body: unknown): Promise<any> {
        this.posts.push({ url, body });
        return { results: this.idsPerQuery.map(ids => ({ vulns: ids.map(id => ({ id })) })) };
    }

    async getJson(url: string): Promise<any> {
        this.gets.push(url);
        const id = decodeURIComponent(url.split('/').pop()!);
        return this.vulns[id] ?? null;
    }
}

test('OsvClient: batches queries and fetches each vuln once', async () => {
    const http = new FakeHttp(
        [['GHSA-1'], ['GHSA-1', 'GHSA-2']],
        { 'GHSA-1': { id: 'GHSA-1' }, 'GHSA-2': { id: 'GHSA-2' } },
    );
    const client = new OsvClient(http);
    const results = await client.resolve([{ name: 'a', version: '1.0' }, { name: 'b' }]);

    assert.equal(http.posts.length, 1);
    assert.equal(http.posts[0].body.queries[0].package.ecosystem, 'PyPI');
    assert.equal(http.posts[0].body.queries[0].version, '1.0');
    assert.equal('version' in http.posts[0].body.queries[1], false);
    // GHSA-1 appears in both results but is fetched once
    assert.equal(http.gets.length, 2);
    assert.deepEqual(results.map(r => r.map(x => x.id)), [['GHSA-1'], ['GHSA-1', 'GHSA-2']]);
});

test('auditDependencies: locked version produces an exact finding with a fix', async () => {
    const http = new FakeHttp([['GHSA-m2qf-hxjv-5gpq']], { 'GHSA-m2qf-hxjv-5gpq': FLASK_VULN });
    const findings = await auditDependencies(
        [{ packageName: 'Flask', versionSpec: '>=', currentVersion: '2.0' }],
        new Map([['flask', '2.2.4']]),
        new OsvClient(http),
    );

    assert.equal(findings.length, 1);
    assert.equal(findings[0].confidence, 'exact');
    assert.equal(findings[0].resolvedVersion, '2.2.4');
    assert.equal(findings[0].packageName, 'Flask');
    assert.equal(findings[0].severity, 'HIGH');
    assert.deepEqual(findings[0].aliases, ['CVE-2023-30861']);
    assert.equal(findings[0].recommendedFix, '2.2.5');
    // the batch query carried the locked version, not the declared range
    assert.equal(http.posts[0].body.queries[0].version, '2.2.4');
});

test('auditDependencies: locked version outside every window yields nothing', async () => {
    // A server that wrongly returns the advisory is still filtered locally.
    const http = new FakeHttp([['GHSA-m2qf-hxjv-5gpq']], { 'GHSA-m2qf-hxjv-5gpq': FLASK_VULN });
    const findings = await auditDependencies(
        [{ packageName: 'flask', versionSpec: '>=', currentVersion: '2.0' }],
        new Map([['flask', '3.0.0']]),
        new OsvClient(http),
    );
    assert.deepEqual(findings, []);
});

test('auditDependencies: unlocked dep falls back to a range finding', async () => {
    const http = new FakeHttp([['GHSA-m2qf-hxjv-5gpq']], { 'GHSA-m2qf-hxjv-5gpq': FLASK_VULN });
    const findings = await auditDependencies(
        [{ packageName: 'flask', versionSpec: '>=', currentVersion: '2.0' }],
        undefined,
        new OsvClient(http),
    );

    assert.equal(findings.length, 1);
    assert.equal(findings[0].confidence, 'range');
    assert.equal(findings[0].resolvedVersion, undefined);
    assert.equal(findings[0].recommendedFix, '2.2.5');
    assert.equal('version' in http.posts[0].body.queries[0], false);
});

test('auditDependencies: a floor above every window reports nothing', async () => {
    const http = new FakeHttp([['GHSA-m2qf-hxjv-5gpq']], { 'GHSA-m2qf-hxjv-5gpq': FLASK_VULN });
    const findings = await auditDependencies(
        [{ packageName: 'flask', versionSpec: '>=', currentVersion: '2.3.2' }],
        undefined,
        new OsvClient(http),
    );
    assert.deepEqual(findings, []);
});

test('auditDependencies: withdrawn advisories are dropped', async () => {
    const withdrawn = { ...FLASK_VULN, withdrawn: '2024-01-01T00:00:00Z' };
    const http = new FakeHttp([['GHSA-m2qf-hxjv-5gpq']], { 'GHSA-m2qf-hxjv-5gpq': withdrawn });
    const findings = await auditDependencies(
        [{ packageName: 'flask', versionSpec: '==', currentVersion: '2.2.4' }],
        undefined,
        new OsvClient(http),
    );
    assert.deepEqual(findings, []);
});

test('auditDependencies: only declared deps are queried, never the lock tree', async () => {
    const http = new FakeHttp([[]], {});
    await auditDependencies(
        [{ packageName: 'flask', versionSpec: '>=', currentVersion: '2.0' }],
        parseUvLock(SAMPLE_LOCK),
        new OsvClient(http),
    );

    const queried = http.posts[0].body.queries.map((q: any) => q.package.name);
    assert.deepEqual(queried, ['flask']);
    assert.equal(queried.includes('werkzeug'), false);
});

// ---------------------------------------------------------------------------
// Alias deduplication
// ---------------------------------------------------------------------------

// The same CVE as OSV actually returns it: a GHSA record with a severity and a
// PYSEC record without one, cross-referencing each other.
const PYSEC_TWIN: OsvVulnerability = {
    id: 'PYSEC-2023-62',
    aliases: ['CVE-2023-30861', 'GHSA-m2qf-hxjv-5gpq'],
    summary: 'Flask session cookie disclosure',
    affected: [{
        package: { name: 'flask', ecosystem: 'PyPI' },
        ranges: [{ type: 'ECOSYSTEM', events: [{ introduced: '0' }, { fixed: '2.2.5' }] }],
    }],
};

test('auditDependencies: GHSA and PYSEC records for one CVE collapse to one finding', async () => {
    const http = new FakeHttp(
        [['GHSA-m2qf-hxjv-5gpq', 'PYSEC-2023-62']],
        { 'GHSA-m2qf-hxjv-5gpq': FLASK_VULN, 'PYSEC-2023-62': PYSEC_TWIN },
    );
    const findings = await auditDependencies(
        [{ packageName: 'flask', versionSpec: '==', currentVersion: '2.2.4' }],
        undefined,
        new OsvClient(http),
    );

    assert.equal(findings.length, 1);
    // the record carrying a severity wins
    assert.equal(findings[0].id, 'GHSA-m2qf-hxjv-5gpq');
    assert.equal(findings[0].severity, 'HIGH');
    assert.deepEqual(findings[0].aliases, ['CVE-2023-30861', 'PYSEC-2023-62']);
});

test('dedupeFindings: order does not decide the winner', async () => {
    const reversed = new FakeHttp(
        [['PYSEC-2023-62', 'GHSA-m2qf-hxjv-5gpq']],
        { 'GHSA-m2qf-hxjv-5gpq': FLASK_VULN, 'PYSEC-2023-62': PYSEC_TWIN },
    );
    const findings = await auditDependencies(
        [{ packageName: 'flask', versionSpec: '==', currentVersion: '2.2.4' }],
        undefined,
        new OsvClient(reversed),
    );
    assert.equal(findings.length, 1);
    assert.equal(findings[0].id, 'GHSA-m2qf-hxjv-5gpq');
});

test('dedupeFindings: merges fixed versions across linked records', () => {
    const merged = dedupeFindings([
        { packageName: 'flask', id: 'PYSEC-1', aliases: ['CVE-1'], summary: '', severity: 'UNKNOWN', fixedVersions: ['2.3.2'], confidence: 'exact', resolvedVersion: '2.2.4' },
        { packageName: 'flask', id: 'GHSA-1', aliases: ['CVE-1'], summary: '', severity: 'HIGH', fixedVersions: ['2.2.5'], confidence: 'exact', resolvedVersion: '2.2.4' },
    ]);
    assert.equal(merged.length, 1);
    assert.deepEqual(merged[0].fixedVersions, ['2.2.5', '2.3.2']);
    assert.equal(merged[0].recommendedFix, '2.2.5');
});

test('dedupeFindings: a shared CVE across two packages stays separate', () => {
    const merged = dedupeFindings([
        { packageName: 'flask', id: 'GHSA-1', aliases: ['CVE-1'], summary: '', severity: 'HIGH', fixedVersions: [], confidence: 'range' },
        { packageName: 'django', id: 'GHSA-1', aliases: ['CVE-1'], summary: '', severity: 'HIGH', fixedVersions: [], confidence: 'range' },
    ]);
    assert.equal(merged.length, 2);
});

test('dedupeFindings: unrelated advisories are left alone', () => {
    const merged = dedupeFindings([
        { packageName: 'flask', id: 'GHSA-1', aliases: ['CVE-1'], summary: '', severity: 'HIGH', fixedVersions: [], confidence: 'range' },
        { packageName: 'flask', id: 'GHSA-2', aliases: ['CVE-2'], summary: '', severity: 'LOW', fixedVersions: [], confidence: 'range' },
    ]);
    assert.equal(merged.length, 2);
});

test('dedupeFindings: a late record linking two existing groups merges them', () => {
    const merged = dedupeFindings([
        { packageName: 'flask', id: 'GHSA-1', aliases: [], summary: '', severity: 'HIGH', fixedVersions: [], confidence: 'range' },
        { packageName: 'flask', id: 'PYSEC-1', aliases: [], summary: '', severity: 'UNKNOWN', fixedVersions: [], confidence: 'range' },
        { packageName: 'flask', id: 'CVE-1', aliases: ['GHSA-1', 'PYSEC-1'], summary: '', severity: 'UNKNOWN', fixedVersions: [], confidence: 'range' },
    ]);
    assert.equal(merged.length, 1);
    assert.equal(merged[0].id, 'GHSA-1');
    assert.deepEqual(merged[0].aliases, ['CVE-1', 'PYSEC-1']);
});

test('auditDependencies: no deps means no network call', async () => {
    const http = new FakeHttp([], {});
    assert.deepEqual(await auditDependencies([], undefined, new OsvClient(http)), []);
    assert.equal(http.posts.length, 0);
});
