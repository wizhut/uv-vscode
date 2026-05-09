'use strict';

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const PKG_PATH = path.join(ROOT, 'package.json');
const TARGETS_PATH = path.join(ROOT, 'build', 'targets.json');
const DIST_DIR = path.join(ROOT, 'dist');

function loadTargets() {
    const raw = JSON.parse(fs.readFileSync(TARGETS_PATH, 'utf8'));
    const cleaned = {};
    for (const [name, cfg] of Object.entries(raw)) {
        const { _comment, ...rest } = cfg;
        cleaned[name] = rest;
    }
    return cleaned;
}

function packageOne(targetName, overrides, originalText) {
    const pkg = JSON.parse(originalText);
    Object.assign(pkg, overrides);
    fs.writeFileSync(PKG_PATH, JSON.stringify(pkg, null, 4) + '\n');

    if (!fs.existsSync(DIST_DIR)) {
        fs.mkdirSync(DIST_DIR, { recursive: true });
    }
    const out = path.join(DIST_DIR, `${pkg.name}-${pkg.version}.vsix`);
    console.log(`\n→ ${targetName}: ${pkg.publisher}/${pkg.name}@${pkg.version}`);
    execSync(`npx --no-install vsce package --out "${out}"`, { stdio: 'inherit', cwd: ROOT });
    return out;
}

function main() {
    const targets = loadTargets();
    const requested = process.argv[2];

    if (requested && !targets[requested]) {
        console.error(`Unknown target "${requested}". Available: ${Object.keys(targets).join(', ')}`);
        process.exit(1);
    }

    const list = requested ? [requested] : Object.keys(targets);
    const originalText = fs.readFileSync(PKG_PATH, 'utf8');

    const built = [];
    try {
        for (const t of list) {
            built.push(packageOne(t, targets[t], originalText));
        }
    } finally {
        // Always restore the canonical package.json
        fs.writeFileSync(PKG_PATH, originalText);
    }

    console.log('\nBuilt:');
    for (const p of built) {
        console.log(`  ${path.relative(ROOT, p)}`);
    }
}

main();
