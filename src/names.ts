// Package-name helpers with no dependencies, shared by the extension and the
// npx CLI (which ships without @iarna/toml).

// PEP 503: lowercase, and collapse runs of -_. into a single -
export function normalizePackageName(name: string): string {
    return name.trim().toLowerCase().replace(/[-_.]+/g, '-');
}
