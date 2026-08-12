import * as https from 'https';
import * as TOML from '@iarna/toml';
import { normalizePackageName } from './parser';

// ---------------------------------------------------------------------------
// PEP 440 versions
// ---------------------------------------------------------------------------

const VERSION_REGEX = /^\s*v?(?:(\d+)!)?(\d+(?:\.\d+)*)([-_.]?(?:a|b|c|rc|alpha|beta|pre|preview)[-_.]?\d*)?((?:-\d+)|(?:[-_.]?(?:post|rev|r)[-_.]?\d*))?([-_.]?dev[-_.]?\d*)?(?:\+[a-z0-9]+(?:[-_.][a-z0-9]+)*)?\s*$/i;

const PRE_RANK: Record<string, number> = { a: 0, b: 1, rc: 2 };

export interface PyVersion {
    epoch: number;
    release: number[];
    pre: [number, number] | null;
    post: number | null;
    dev: number | null;
    raw: string;
}

function normalizePreLetter(letter: string): string {
    const l = letter.toLowerCase();
    if (l === 'alpha') { return 'a'; }
    if (l === 'beta') { return 'b'; }
    if (l === 'c' || l === 'pre' || l === 'preview') { return 'rc'; }
    return l;
}

export function parseVersion(text: string): PyVersion | null {
    const m = text.match(VERSION_REGEX);
    if (!m) {
        return null;
    }

    let pre: [number, number] | null = null;
    if (m[3]) {
        const parts = m[3].replace(/^[-_.]/, '').match(/^([a-z]+)[-_.]?(\d*)$/i);
        if (parts) {
            const rank = PRE_RANK[normalizePreLetter(parts[1])];
            if (rank === undefined) {
                return null;
            }
            pre = [rank, parts[2] ? parseInt(parts[2], 10) : 0];
        }
    }

    let post: number | null = null;
    if (m[4]) {
        const implicit = m[4].match(/^-(\d+)$/);
        if (implicit) {
            post = parseInt(implicit[1], 10);
        } else {
            const parts = m[4].match(/(\d*)$/);
            post = parts && parts[1] ? parseInt(parts[1], 10) : 0;
        }
    }

    let dev: number | null = null;
    if (m[5]) {
        const parts = m[5].match(/(\d*)$/);
        dev = parts && parts[1] ? parseInt(parts[1], 10) : 0;
    }

    return {
        epoch: m[1] ? parseInt(m[1], 10) : 0,
        release: m[2].split('.').map(n => parseInt(n, 10)),
        pre,
        post,
        dev,
        raw: text.trim(),
    };
}

// Sort keys follow PEP 440's ordering rules: a bare release outranks any of its
// pre-releases, a .devN outranks nothing, and .postN sits above the plain release.
function preKey(v: PyVersion): [number, number] {
    if (v.pre) {
        return v.pre;
    }
    if (v.post === null && v.dev !== null) {
        return [-Infinity, 0];
    }
    return [Infinity, 0];
}

export function compareVersions(a: PyVersion, b: PyVersion): number {
    if (a.epoch !== b.epoch) {
        return a.epoch < b.epoch ? -1 : 1;
    }

    const len = Math.max(a.release.length, b.release.length);
    for (let i = 0; i < len; i++) {
        const x = a.release[i] ?? 0;
        const y = b.release[i] ?? 0;
        if (x !== y) {
            return x < y ? -1 : 1;
        }
    }

    const [aRank, aNum] = preKey(a);
    const [bRank, bNum] = preKey(b);
    if (aRank !== bRank) {
        return aRank < bRank ? -1 : 1;
    }
    if (aNum !== bNum) {
        return aNum < bNum ? -1 : 1;
    }

    const aPost = a.post === null ? -Infinity : a.post;
    const bPost = b.post === null ? -Infinity : b.post;
    if (aPost !== bPost) {
        return aPost < bPost ? -1 : 1;
    }

    const aDev = a.dev === null ? Infinity : a.dev;
    const bDev = b.dev === null ? Infinity : b.dev;
    if (aDev !== bDev) {
        return aDev < bDev ? -1 : 1;
    }

    return 0;
}

// ---------------------------------------------------------------------------
// Version intervals
// ---------------------------------------------------------------------------

// A null version means unbounded on that side.
export interface Bound {
    version: PyVersion | null;
    inclusive: boolean;
}

export interface Interval {
    lower: Bound;
    upper: Bound;
}

export const UNBOUNDED: Interval = {
    lower: { version: null, inclusive: false },
    upper: { version: null, inclusive: false },
};

function maxLower(a: Bound, b: Bound): Bound {
    if (!a.version) { return b; }
    if (!b.version) { return a; }
    const c = compareVersions(a.version, b.version);
    if (c > 0) { return a; }
    if (c < 0) { return b; }
    return { version: a.version, inclusive: a.inclusive && b.inclusive };
}

function minUpper(a: Bound, b: Bound): Bound {
    if (!a.version) { return b; }
    if (!b.version) { return a; }
    const c = compareVersions(a.version, b.version);
    if (c < 0) { return a; }
    if (c > 0) { return b; }
    return { version: a.version, inclusive: a.inclusive && b.inclusive };
}

export function intersect(a: Interval, b: Interval): Interval {
    return { lower: maxLower(a.lower, b.lower), upper: minUpper(a.upper, b.upper) };
}

export function isEmptyInterval(i: Interval): boolean {
    if (!i.lower.version || !i.upper.version) {
        return false;
    }
    const c = compareVersions(i.lower.version, i.upper.version);
    if (c < 0) { return false; }
    if (c > 0) { return true; }
    return !(i.lower.inclusive && i.upper.inclusive);
}

export function intervalsIntersect(a: Interval, b: Interval): boolean {
    return !isEmptyInterval(intersect(a, b));
}

export function intervalContains(i: Interval, v: PyVersion): boolean {
    if (i.lower.version) {
        const c = compareVersions(v, i.lower.version);
        if (c < 0 || (c === 0 && !i.lower.inclusive)) {
            return false;
        }
    }
    if (i.upper.version) {
        const c = compareVersions(v, i.upper.version);
        if (c > 0 || (c === 0 && !i.upper.inclusive)) {
            return false;
        }
    }
    return true;
}

// Bump the last release segment: 1.4.5 -> 1.5, used for ~= upper bounds.
function compatibleUpperBound(v: PyVersion): PyVersion | null {
    if (v.release.length < 2) {
        return null;
    }
    const release = v.release.slice(0, -1);
    release[release.length - 1] += 1;
    return { epoch: v.epoch, release, pre: null, post: null, dev: null, raw: release.join('.') };
}

// == with a trailing .* is a prefix match: 1.4.* -> [1.4, 1.5)
function prefixInterval(text: string): Interval | null {
    const base = parseVersion(text.replace(/\.\*$/, ''));
    if (!base) {
        return null;
    }
    const release = base.release.slice();
    release[release.length - 1] += 1;
    return {
        lower: { version: base, inclusive: true },
        upper: { version: { ...base, release, pre: null, post: null, dev: null }, inclusive: false },
    };
}

// A single PEP 440 constraint as an interval. `!=` carves a hole rather than
// bounding a side, so it is reported as unbounded — conservative for auditing,
// since the worst case is flagging a range the user has already excluded.
export function constraintToInterval(operator: string, versionText: string): Interval {
    if (versionText.endsWith('.*')) {
        if (operator === '==' || operator === '===') {
            return prefixInterval(versionText) ?? UNBOUNDED;
        }
        versionText = versionText.replace(/\.\*$/, '');
    }

    const v = parseVersion(versionText);
    if (!v) {
        return UNBOUNDED;
    }

    switch (operator) {
        case '==':
        case '===':
            return { lower: { version: v, inclusive: true }, upper: { version: v, inclusive: true } };
        case '>=':
            return { lower: { version: v, inclusive: true }, upper: { version: null, inclusive: false } };
        case '>':
            return { lower: { version: v, inclusive: false }, upper: { version: null, inclusive: false } };
        case '<=':
            return { lower: { version: null, inclusive: false }, upper: { version: v, inclusive: true } };
        case '<':
            return { lower: { version: null, inclusive: false }, upper: { version: v, inclusive: false } };
        case '~=': {
            const upper = compatibleUpperBound(v);
            return {
                lower: { version: v, inclusive: true },
                upper: upper ? { version: upper, inclusive: false } : { version: null, inclusive: false },
            };
        }
        default:
            return UNBOUNDED;
    }
}

const CONSTRAINT_REGEX = /^\s*(===|==|!=|>=|<=|~=|>|<)\s*(.+?)\s*$/;

// The declared spec, e.g. ">=2.0,<3". Constraints are ANDed, so the result is
// their intersection.
export function specToInterval(spec: string): Interval {
    if (!spec.trim()) {
        return UNBOUNDED;
    }
    let result = UNBOUNDED;
    for (const part of spec.split(',')) {
        const m = part.match(CONSTRAINT_REGEX);
        if (!m) {
            continue;
        }
        result = intersect(result, constraintToInterval(m[1], m[2]));
    }
    return result;
}

// ---------------------------------------------------------------------------
// uv.lock
// ---------------------------------------------------------------------------

// Maps normalized package name -> exact locked version. Only registry packages
// are included: the project's own root entry (source = virtual/editable) has no
// advisories to look up.
export function parseUvLock(text: string): Map<string, string> {
    const locked = new Map<string, string>();

    let data: TOML.JsonMap;
    try {
        data = TOML.parse(text);
    } catch {
        return locked;
    }

    const packages = data.package;
    if (!Array.isArray(packages)) {
        return locked;
    }

    for (const entry of packages) {
        if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
            continue;
        }
        const pkg = entry as Record<string, unknown>;
        if (typeof pkg.name !== 'string' || typeof pkg.version !== 'string') {
            continue;
        }
        const source = pkg.source;
        if (source && typeof source === 'object' && !Array.isArray(source)) {
            const keys = Object.keys(source as Record<string, unknown>);
            if (keys.includes('virtual') || keys.includes('editable')) {
                continue;
            }
        }
        locked.set(normalizePackageName(pkg.name), pkg.version);
    }

    return locked;
}

// ---------------------------------------------------------------------------
// OSV
// ---------------------------------------------------------------------------

const OSV_BASE = 'https://api.osv.dev/v1';
const OSV_BATCH_LIMIT = 1000;

export interface OsvEvent {
    introduced?: string;
    fixed?: string;
    last_affected?: string;
    limit?: string;
}

export interface OsvRange {
    type?: string;
    events?: OsvEvent[];
}

export interface OsvAffected {
    package?: { name?: string; ecosystem?: string };
    ranges?: OsvRange[];
    versions?: string[];
    database_specific?: Record<string, unknown>;
}

export interface OsvVulnerability {
    id: string;
    aliases?: string[];
    summary?: string;
    details?: string;
    withdrawn?: string;
    affected?: OsvAffected[];
    severity?: { type?: string; score?: string }[];
    database_specific?: Record<string, unknown>;
}

export interface HttpClient {
    getJson(url: string): Promise<any>;
    postJson(url: string, body: unknown): Promise<any>;
}

function request(method: 'GET' | 'POST', url: string, body?: unknown): Promise<any> {
    return new Promise((resolve, reject) => {
        const target = new URL(url);
        const payload = body === undefined ? undefined : Buffer.from(JSON.stringify(body));
        const headers: Record<string, string> = { 'Accept': 'application/json' };
        if (payload) {
            headers['Content-Type'] = 'application/json';
            headers['Content-Length'] = String(payload.length);
        }

        const req = https.request({
            method,
            hostname: target.hostname,
            path: target.pathname + target.search,
            headers,
        }, (res: any) => {
            if (res.statusCode !== 200) {
                res.resume();
                reject(new Error(`Status: ${res.statusCode}`));
                return;
            }
            let data = '';
            res.on('data', (chunk: any) => data += chunk);
            res.on('end', () => {
                try {
                    resolve(JSON.parse(data));
                } catch (e) {
                    reject(e);
                }
            });
        });

        req.on('error', reject);
        if (payload) {
            req.write(payload);
        }
        req.end();
    });
}

export const nodeHttpClient: HttpClient = {
    getJson: (url) => request('GET', url),
    postJson: (url, body) => request('POST', url, body),
};

export interface OsvQuery {
    name: string;
    version?: string;
}

// querybatch returns ids only, so full records are fetched separately and kept
// in `vulnCache` — advisory bodies are stable and shared across projects.
export class OsvClient {
    constructor(
        private readonly http: HttpClient = nodeHttpClient,
        private readonly vulnCache: Map<string, OsvVulnerability> = new Map(),
    ) {}

    async queryBatch(queries: OsvQuery[]): Promise<string[][]> {
        const ids: string[][] = [];

        for (let i = 0; i < queries.length; i += OSV_BATCH_LIMIT) {
            const chunk = queries.slice(i, i + OSV_BATCH_LIMIT);
            const response = await this.http.postJson(`${OSV_BASE}/querybatch`, {
                queries: chunk.map(q => ({
                    package: { name: q.name, ecosystem: 'PyPI' },
                    ...(q.version ? { version: q.version } : {}),
                })),
            });
            const results = Array.isArray(response?.results) ? response.results : [];
            for (let j = 0; j < chunk.length; j++) {
                const vulns = results[j]?.vulns;
                ids.push(Array.isArray(vulns) ? vulns.map((v: any) => v.id).filter(Boolean) : []);
            }
        }

        return ids;
    }

    async fetchVuln(id: string): Promise<OsvVulnerability | null> {
        const cached = this.vulnCache.get(id);
        if (cached) {
            return cached;
        }
        try {
            const vuln = await this.http.getJson(`${OSV_BASE}/vulns/${encodeURIComponent(id)}`);
            if (!vuln?.id) {
                return null;
            }
            this.vulnCache.set(id, vuln);
            return vuln;
        } catch {
            return null;
        }
    }

    async resolve(queries: OsvQuery[]): Promise<OsvVulnerability[][]> {
        const idsPerQuery = await this.queryBatch(queries);

        const unique = new Set<string>();
        for (const ids of idsPerQuery) {
            for (const id of ids) {
                unique.add(id);
            }
        }

        const fetched = new Map<string, OsvVulnerability>();
        for (const id of unique) {
            const vuln = await this.fetchVuln(id);
            if (vuln) {
                fetched.set(id, vuln);
            }
        }

        return idsPerQuery.map(ids => ids
            .map(id => fetched.get(id))
            .filter((v): v is OsvVulnerability => v !== undefined));
    }
}

// ---------------------------------------------------------------------------
// Matching advisories to dependencies
// ---------------------------------------------------------------------------

export function rangeToIntervals(range: OsvRange): Interval[] {
    const intervals: Interval[] = [];
    let lower: Bound | null = null;

    const events = (range.events ?? []).slice().sort((a, b) => {
        const av = a.introduced === '0' ? null : parseVersion(a.introduced ?? a.fixed ?? a.last_affected ?? a.limit ?? '');
        const bv = b.introduced === '0' ? null : parseVersion(b.introduced ?? b.fixed ?? b.last_affected ?? b.limit ?? '');
        if (!av) { return -1; }
        if (!bv) { return 1; }
        return compareVersions(av, bv);
    });

    for (const event of events) {
        if (event.introduced !== undefined) {
            if (!lower) {
                const v = event.introduced === '0' ? null : parseVersion(event.introduced);
                lower = { version: v, inclusive: true };
            }
            continue;
        }
        if (!lower) {
            continue;
        }
        if (event.fixed !== undefined || event.limit !== undefined) {
            const v = parseVersion((event.fixed ?? event.limit)!);
            intervals.push({ lower, upper: { version: v, inclusive: false } });
            lower = null;
        } else if (event.last_affected !== undefined) {
            const v = parseVersion(event.last_affected);
            intervals.push({ lower, upper: { version: v, inclusive: true } });
            lower = null;
        }
    }

    if (lower) {
        intervals.push({ lower, upper: { version: null, inclusive: false } });
    }

    return intervals;
}

function affectedEntriesFor(vuln: OsvVulnerability, normalizedName: string): OsvAffected[] {
    return (vuln.affected ?? []).filter(a => {
        const ecosystem = a.package?.ecosystem;
        if (ecosystem && ecosystem !== 'PyPI') {
            return false;
        }
        const name = a.package?.name;
        return !name || normalizePackageName(name) === normalizedName;
    });
}

function intervalsFor(affected: OsvAffected): Interval[] {
    return (affected.ranges ?? [])
        .filter(r => !r.type || r.type === 'ECOSYSTEM' || r.type === 'SEMVER')
        .flatMap(rangeToIntervals);
}

export function isVersionAffected(vuln: OsvVulnerability, normalizedName: string, version: PyVersion): boolean {
    for (const affected of affectedEntriesFor(vuln, normalizedName)) {
        if (affected.versions?.some(v => {
            const parsed = parseVersion(v);
            return parsed !== null && compareVersions(parsed, version) === 0;
        })) {
            return true;
        }
        if (intervalsFor(affected).some(i => intervalContains(i, version))) {
            return true;
        }
    }
    return false;
}

export function specPermitsVulnerable(vuln: OsvVulnerability, normalizedName: string, spec: Interval): boolean {
    for (const affected of affectedEntriesFor(vuln, normalizedName)) {
        if (affected.versions?.some(v => {
            const parsed = parseVersion(v);
            return parsed !== null && intervalContains(spec, parsed);
        })) {
            return true;
        }
        if (intervalsFor(affected).some(i => intervalsIntersect(i, spec))) {
            return true;
        }
    }
    return false;
}

export function fixedVersionsFor(vuln: OsvVulnerability, normalizedName: string): string[] {
    const fixed: PyVersion[] = [];
    for (const affected of affectedEntriesFor(vuln, normalizedName)) {
        for (const range of affected.ranges ?? []) {
            for (const event of range.events ?? []) {
                if (event.fixed === undefined) {
                    continue;
                }
                const v = parseVersion(event.fixed);
                if (v && !fixed.some(f => compareVersions(f, v) === 0)) {
                    fixed.push(v);
                }
            }
        }
    }
    return fixed.sort(compareVersions).map(v => v.raw);
}

// ---------------------------------------------------------------------------
// Audit
// ---------------------------------------------------------------------------

export type Severity = 'CRITICAL' | 'HIGH' | 'MODERATE' | 'LOW' | 'UNKNOWN';

const SEVERITY_ALIASES: Record<string, Severity> = {
    CRITICAL: 'CRITICAL',
    HIGH: 'HIGH',
    MODERATE: 'MODERATE',
    MEDIUM: 'MODERATE',
    LOW: 'LOW',
};

// Taken from GHSA's database_specific field. PYSEC records often carry only a
// raw CVSS vector, which is surfaced as `cvssVector` rather than scored here.
export function severityOf(vuln: OsvVulnerability): Severity {
    const raw = vuln.database_specific?.severity;
    if (typeof raw === 'string') {
        const mapped = SEVERITY_ALIASES[raw.toUpperCase()];
        if (mapped) {
            return mapped;
        }
    }
    for (const affected of vuln.affected ?? []) {
        const value = affected.database_specific?.severity;
        if (typeof value === 'string') {
            const mapped = SEVERITY_ALIASES[value.toUpperCase()];
            if (mapped) {
                return mapped;
            }
        }
    }
    return 'UNKNOWN';
}

export function cvssVectorOf(vuln: OsvVulnerability): string | undefined {
    const entry = (vuln.severity ?? []).find(s => typeof s.score === 'string' && s.score.startsWith('CVSS:'));
    return entry?.score;
}

// What the parser already produces; DepLocation satisfies this structurally.
export interface AuditTarget {
    packageName: string;
    versionSpec: string;
    currentVersion: string;
}

export interface Finding {
    packageName: string;
    id: string;
    aliases: string[];
    summary: string;
    severity: Severity;
    cvssVector?: string;
    fixedVersions: string[];
    recommendedFix?: string;
    // 'exact' — a concrete version was resolved and is known vulnerable.
    // 'range' — no resolved version; the declared constraint permits one.
    confidence: 'exact' | 'range';
    resolvedVersion?: string;
}

// The exact version a dependency resolves to, from uv.lock or from an == pin.
export function resolveVersion(dep: AuditTarget, lock?: Map<string, string>): string | undefined {
    const locked = lock?.get(normalizePackageName(dep.packageName));
    if (locked) {
        return locked;
    }
    if ((dep.versionSpec === '==' || dep.versionSpec === '===') && dep.currentVersion && !dep.currentVersion.includes('*')) {
        return dep.currentVersion;
    }
    return undefined;
}

// The lowest fix that actually moves the dependency forward.
function pickRecommendedFix(fixedVersions: string[], resolvedVersion?: string): string | undefined {
    const resolved = resolvedVersion ? parseVersion(resolvedVersion) : null;
    if (!resolved) {
        return fixedVersions[0];
    }
    return fixedVersions.find(f => {
        const v = parseVersion(f);
        return v !== null && compareVersions(v, resolved) > 0;
    });
}

function buildFinding(
    vuln: OsvVulnerability,
    dep: AuditTarget,
    normalizedName: string,
    confidence: 'exact' | 'range',
    resolvedVersion: string | undefined,
): Finding {
    const fixedVersions = fixedVersionsFor(vuln, normalizedName);
    const recommendedFix = pickRecommendedFix(fixedVersions, resolvedVersion);

    return {
        packageName: dep.packageName,
        id: vuln.id,
        aliases: vuln.aliases ?? [],
        summary: vuln.summary ?? vuln.details?.split('\n')[0] ?? vuln.id,
        severity: severityOf(vuln),
        cvssVector: cvssVectorOf(vuln),
        fixedVersions,
        recommendedFix,
        confidence,
        resolvedVersion,
    };
}

// OSV returns one record per database, so a single CVE typically arrives twice:
// a GHSA entry (which carries a severity) and a PYSEC entry (which usually does
// not). They reference each other through `aliases`, so anything alias-linked is
// collapsed onto the most informative record.
function canonicalRank(f: Finding): number {
    return (f.severity !== 'UNKNOWN' ? 2 : 0) + (f.id.startsWith('GHSA-') ? 1 : 0);
}

export function dedupeFindings(findings: Finding[]): Finding[] {
    const groups: { pkg: string; ids: Set<string>; members: Finding[] }[] = [];

    for (const finding of findings) {
        const pkg = normalizePackageName(finding.packageName);
        const ids = [finding.id, ...finding.aliases];
        const matched = groups.filter(g => g.pkg === pkg && ids.some(id => g.ids.has(id)));

        if (matched.length === 0) {
            groups.push({ pkg, ids: new Set(ids), members: [finding] });
            continue;
        }

        // This advisory may be the first record linking two existing groups.
        const target = matched[0];
        target.members.push(finding);
        for (const id of ids) {
            target.ids.add(id);
        }
        for (const other of matched.slice(1)) {
            for (const id of other.ids) {
                target.ids.add(id);
            }
            target.members.push(...other.members);
            groups.splice(groups.indexOf(other), 1);
        }
    }

    return groups.map(group => {
        const best = group.members.reduce((a, b) => (canonicalRank(b) > canonicalRank(a) ? b : a));

        const aliases = new Set<string>();
        const fixed: PyVersion[] = [];
        for (const member of group.members) {
            aliases.add(member.id);
            for (const alias of member.aliases) {
                aliases.add(alias);
            }
            for (const f of member.fixedVersions) {
                const v = parseVersion(f);
                if (v && !fixed.some(x => compareVersions(x, v) === 0)) {
                    fixed.push(v);
                }
            }
        }
        aliases.delete(best.id);

        const fixedVersions = fixed.sort(compareVersions).map(v => v.raw);
        return {
            ...best,
            aliases: [...aliases].sort(),
            fixedVersions,
            recommendedFix: pickRecommendedFix(fixedVersions, best.resolvedVersion),
        };
    });
}

// Audits the top-level dependencies the parser found. uv.lock is used purely to
// pin each declared dep to a concrete version — the transitive tree it also
// describes is deliberately not walked, since those findings would not be
// fixable from the file the user has open.
export async function auditDependencies(
    deps: AuditTarget[],
    lock?: Map<string, string>,
    client: OsvClient = new OsvClient(),
): Promise<Finding[]> {
    if (deps.length === 0) {
        return [];
    }

    const resolutions = deps.map(dep => {
        const resolvedVersion = resolveVersion(dep, lock);
        // An unparseable pin falls back to the constraint path rather than
        // sending a version OSV cannot match.
        const resolved = resolvedVersion ? parseVersion(resolvedVersion) : null;
        return {
            dep,
            normalizedName: normalizePackageName(dep.packageName),
            resolvedVersion: resolved ? resolvedVersion : undefined,
            resolved,
        };
    });

    const results = await client.resolve(resolutions.map(r => ({
        name: r.normalizedName,
        version: r.resolvedVersion,
    })));

    const findings: Finding[] = [];

    for (let i = 0; i < resolutions.length; i++) {
        const { dep, normalizedName, resolvedVersion, resolved } = resolutions[i];
        const spec = resolved ? null : specToInterval(`${dep.versionSpec}${dep.currentVersion}`);

        for (const vuln of results[i] ?? []) {
            if (vuln.withdrawn) {
                continue;
            }
            if (resolved) {
                // A versioned query is already filtered server-side; re-checking
                // locally guards against advisories that list the package twice.
                if (!isVersionAffected(vuln, normalizedName, resolved)) {
                    continue;
                }
                findings.push(buildFinding(vuln, dep, normalizedName, 'exact', resolvedVersion));
            } else {
                if (!specPermitsVulnerable(vuln, normalizedName, spec!)) {
                    continue;
                }
                findings.push(buildFinding(vuln, dep, normalizedName, 'range', undefined));
            }
        }
    }

    return dedupeFindings(findings);
}
