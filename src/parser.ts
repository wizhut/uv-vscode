import * as TOML from '@iarna/toml';

const PEP508_REGEX = /^([a-zA-Z0-9_][a-zA-Z0-9._\-]*(?:\[.*?\])?)\s*(?:(>=|<=|~=|==|!=|>|<|===)\s*([0-9][0-9a-zA-Z\.\*]*))?$/;

export interface DepSpec {
    packageName: string;
    packageWithExtras: string;
    versionSpec: string;
    currentVersion: string;
}

export interface DepLocation extends DepSpec {
    raw: string;
    line: number;
    contentStart: number;
    contentEnd: number;
    section: string;
}

export interface ParsedDocument {
    projectVersion?: string;
    deps: DepLocation[];
    error?: Error;
}

export interface SnapshotState {
    projectVersion?: string;
    dependencyVersions: Map<string, string>;
}

export function parsePep508(spec: string): DepSpec | null {
    const m = spec.trim().match(PEP508_REGEX);
    if (!m) {
        return null;
    }
    return {
        packageName: m[1].replace(/\[.*?\]$/, ''),
        packageWithExtras: m[1],
        versionSpec: m[2] || '',
        currentVersion: m[3] || '',
    };
}

function locateString(lines: string[], target: string, used: Set<string>): { line: number; contentStart: number; contentEnd: number } | null {
    for (let li = 0; li < lines.length; li++) {
        const line = lines[li];
        for (const quote of ['"', "'"]) {
            const needle = quote + target + quote;
            let from = 0;
            while (true) {
                const idx = line.indexOf(needle, from);
                if (idx === -1) {
                    break;
                }
                const key = `${li}:${idx}`;
                if (!used.has(key)) {
                    used.add(key);
                    return { line: li, contentStart: idx + 1, contentEnd: idx + 1 + target.length };
                }
                from = idx + 1;
            }
        }
    }
    return null;
}

function collectListSection(value: unknown, section: string, out: { items: string[]; section: string }[]): void {
    if (Array.isArray(value)) {
        const strings = value.filter((v): v is string => typeof v === 'string');
        if (strings.length > 0) {
            out.push({ items: strings, section });
        }
    }
}

function collectGroupedSection(value: unknown, prefix: string, out: { items: string[]; section: string }[]): void {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        return;
    }
    for (const [group, list] of Object.entries(value as Record<string, unknown>)) {
        collectListSection(list, `${prefix}.${group}`, out);
    }
}

export function parseDocument(text: string): ParsedDocument {
    let data: TOML.JsonMap;
    try {
        data = TOML.parse(text);
    } catch (err) {
        return { deps: [], error: err as Error };
    }

    const project = (data.project && typeof data.project === 'object' && !Array.isArray(data.project))
        ? data.project as Record<string, unknown>
        : undefined;
    const projectVersion = typeof project?.version === 'string' ? project.version : undefined;

    const sections: { items: string[]; section: string }[] = [];
    if (project) {
        collectListSection(project.dependencies, 'project.dependencies', sections);
        collectGroupedSection(project['optional-dependencies'], 'project.optional-dependencies', sections);
    }
    collectGroupedSection(data['dependency-groups'], 'dependency-groups', sections);

    const lines = text.split(/\r?\n/);
    const used = new Set<string>();
    const deps: DepLocation[] = [];

    for (const { items, section } of sections) {
        for (const raw of items) {
            const parsed = parsePep508(raw);
            if (!parsed) {
                continue;
            }
            const loc = locateString(lines, raw, used);
            if (!loc) {
                continue;
            }
            deps.push({
                ...parsed,
                raw,
                section,
                line: loc.line,
                contentStart: loc.contentStart,
                contentEnd: loc.contentEnd,
            });
        }
    }

    return { projectVersion, deps };
}

export function buildSnapshot(parsed: ParsedDocument): SnapshotState {
    const dependencyVersions = new Map<string, string>();
    for (const dep of parsed.deps) {
        if (!dep.currentVersion) {
            continue;
        }
        dependencyVersions.set(`${dep.section}:${dep.packageName}`, `${dep.versionSpec}${dep.currentVersion}`);
    }
    return { projectVersion: parsed.projectVersion, dependencyVersions };
}

export function hasVersionUpdates(previous: SnapshotState | undefined, current: SnapshotState): { dependencyChanged: boolean; projectVersionChanged: boolean } {
    if (!previous) {
        return { dependencyChanged: false, projectVersionChanged: false };
    }

    let dependencyChanged = false;
    for (const [key, value] of current.dependencyVersions.entries()) {
        const previousValue = previous.dependencyVersions.get(key);
        if (previousValue !== undefined && previousValue !== value) {
            dependencyChanged = true;
            break;
        }
    }

    const projectVersionChanged = previous.projectVersion !== undefined
        && current.projectVersion !== undefined
        && previous.projectVersion !== current.projectVersion;

    return { dependencyChanged, projectVersionChanged };
}

export function findDepAtPosition(parsed: ParsedDocument, line: number, character: number): DepLocation | null {
    return parsed.deps.find(d => d.line === line && character >= d.contentStart && character <= d.contentEnd) || null;
}

export function depsOnLine(parsed: ParsedDocument, line: number): DepLocation[] {
    return parsed.deps.filter(d => d.line === line);
}
