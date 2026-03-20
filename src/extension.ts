import * as vscode from 'vscode';
import * as https from 'https';

const pypiCache = new Map<string, any>();

// Regex for PEP 621 dependency array items: "package>=1.0.0" or "package[extra]>=1.0.0"
const DEP_LINE_REGEX = /^\s*"([a-zA-Z0-9_][a-zA-Z0-9._\-]*)(?:\[.*?\])?\s*(?:(>=|<=|~=|==|!=|>|<|===)\s*([0-9][0-9a-zA-Z\.\*]*))?"/;

// Sections that contain dependency arrays
const DEP_SECTIONS = [
    '[project]',
    '[dependency-groups',
];

// Fallback Python 3.x versions (newest first) used when the API is unreachable
const FALLBACK_PYTHON_VERSIONS = [
    '3.14', '3.13', '3.12', '3.11', '3.10',
    '3.9', '3.8', '3.7', '3.6', '3.5',
    '3.4', '3.3', '3.2', '3.1', '3.0',
];

let pythonVersionCache: { quickFix: string[]; all: string[] } | null = null;

async function fetchPythonVersions(): Promise<{ quickFix: string[]; all: string[] }> {
    if (pythonVersionCache) {
        return pythonVersionCache;
    }
    return new Promise((resolve) => {
        https.get('https://endoflife.date/api/python.json', (res: any) => {
            if (res.statusCode !== 200) {
                resolve({ quickFix: FALLBACK_PYTHON_VERSIONS.slice(0, 5), all: FALLBACK_PYTHON_VERSIONS });
                return;
            }
            let data = '';
            res.on('data', (chunk: any) => data += chunk);
            res.on('end', () => {
                try {
                    const cycles: Array<{ cycle: string; latest: string }> = JSON.parse(data);
                    const python3 = cycles.filter(c => {
                        const parts = c.cycle.split('.');
                        return parseInt(parts[0], 10) === 3;
                    });
                    // Quick fix: latest patch release of each major version >= 3.10
                    const quickFix = python3
                        .filter(c => parseInt(c.cycle.split('.')[1], 10) >= 10)
                        .map(c => c.latest);
                    // All versions: latest patch release of each major version >= 3.1
                    const all = python3
                        .filter(c => parseInt(c.cycle.split('.')[1], 10) >= 1)
                        .map(c => c.latest);
                    pythonVersionCache = { quickFix, all };
                    resolve(pythonVersionCache);
                } catch {
                    resolve({ quickFix: FALLBACK_PYTHON_VERSIONS.slice(0, 5), all: FALLBACK_PYTHON_VERSIONS });
                }
            });
        }).on('error', () => {
            resolve({ quickFix: FALLBACK_PYTHON_VERSIONS.slice(0, 5), all: FALLBACK_PYTHON_VERSIONS });
        });
    });
}

/**
 * Determine if the given lineIndex is inside a dependency array
 * by scanning backwards to find the relevant TOML section and key.
 */
function isInDependencySection(document: vscode.TextDocument, lineIndex: number): boolean {
    // Walk backwards to find context
    let insideBracketArray = false;
    for (let i = lineIndex; i >= 0; i--) {
        const text = document.lineAt(i).text.trim();

        // If we hit a line that starts a TOML table section, check if it's a dep section
        if (text.startsWith('[')) {
            // [dependency-groups] or [dependency-groups.dev] etc.
            if (text.startsWith('[dependency-groups')) {
                return true;
            }
            // [project] section — but only if we traced back through a dependencies key
            if (text === '[project]' && insideBracketArray) {
                return true;
            }
            // Any other section means we're not in deps
            return false;
        }

        // Check for dependency-related keys like `dependencies = [` or `optional-dependencies.X = [`
        if (/^(?:dependencies|optional-dependencies\b.*)\s*=\s*\[/.test(text)) {
            insideBracketArray = true;
        }

        // If we hit the close of the array before finding a dep key, we're outside
        if (text === ']' && i < lineIndex) {
            return false;
        }
    }
    return false;
}

async function fetchPypiData(packageName: string): Promise<any> {
    if (pypiCache.has(packageName)) {
        return pypiCache.get(packageName);
    }
    return new Promise((resolve, reject) => {
        https.get(`https://pypi.org/pypi/${packageName}/json`, (res: any) => {
            if (res.statusCode !== 200) {
                reject(new Error(`Status: ${res.statusCode}`));
                return;
            }
            let data = '';
            res.on('data', (chunk: any) => data += chunk);
            res.on('end', () => {
                try {
                    const parsed = JSON.parse(data);
                    pypiCache.set(packageName, parsed);
                    resolve(parsed);
                } catch (e) {
                    reject(e);
                }
            });
        }).on('error', reject);
    });
}

export function activate(context: vscode.ExtensionContext) {
    const outputChannel = vscode.window.createOutputChannel('UV PyPI');
    outputChannel.appendLine('uv-vscode extension is now active!');
    console.log('uv-vscode extension is now active!');

    // Helper to run commands in the terminal
    const runInTerminal = (commandName: string, commandText: string) => {
        let terminal = vscode.window.terminals.find(t => t.name === 'uv');
        if (!terminal) {
            terminal = vscode.window.createTerminal('uv');
        }
        terminal.show();
        terminal.sendText(commandText);
    };

    // uv sync
    const uvSyncCmd = vscode.commands.registerCommand('uv.sync', () => {
        runInTerminal('uv sync', 'uv sync');
        vscode.window.showInformationMessage('Running uv sync...');
    });

    // uv add
    const uvAddCmd = vscode.commands.registerCommand('uv.add', async () => {
        const packageName = await vscode.window.showInputBox({
            prompt: 'Enter the package name to add (e.g., requests, fastapi)',
            placeHolder: 'Package name...'
        });

        if (packageName) {
            runInTerminal('uv add', `uv add ${packageName}`);
            vscode.window.showInformationMessage(`Adding package: ${packageName}`);
        }
    });

    // uv run
    const uvRunCmd = vscode.commands.registerCommand('uv.run', async () => {
        const commandToRun = await vscode.window.showInputBox({
            prompt: 'Enter the command or script to run (e.g., python main.py, pytest)',
            placeHolder: 'Command to run...'
        });

        if (commandToRun) {
            runInTerminal('uv run', `uv run ${commandToRun}`);
            vscode.window.showInformationMessage(`Running: uv run ${commandToRun}`);
        }
    });

    // Diagnostic Collection for Outdated Packages
    const diagnosticCollection = vscode.languages.createDiagnosticCollection('uv-pypi');
    context.subscriptions.push(diagnosticCollection);

    let timeout: NodeJS.Timeout | undefined = undefined;

    async function updateDiagnostics(document: vscode.TextDocument) {
        outputChannel.appendLine(`[updateDiagnostics] Checking file: ${document.fileName}`);
        if (!document.fileName.endsWith('pyproject.toml')) {
            outputChannel.appendLine(`[updateDiagnostics] Skipping - not a pyproject.toml file`);
            return;
        }

        const diagnostics: vscode.Diagnostic[] = [];

        // Scan lines for dependencies
        for (let lineIndex = 0; lineIndex < document.lineCount; lineIndex++) {
            const line = document.lineAt(lineIndex);

            // Only process lines inside dependency sections
            if (!isInDependencySection(document, lineIndex)) {
                if (line.text.trim().startsWith('"')) {
                    outputChannel.appendLine(`[updateDiagnostics] Line ${lineIndex} looks like a dep but isInDependencySection=false: ${line.text.trim()}`);
                }
                continue;
            }

            const depMatch = line.text.match(DEP_LINE_REGEX);
            if (!depMatch) {
                outputChannel.appendLine(`[updateDiagnostics] Line ${lineIndex} in dep section but no regex match: ${line.text.trim()}`);
                continue;
            }
            outputChannel.appendLine(`[updateDiagnostics] Found dependency: ${depMatch[1]} ${depMatch[2] || ''} ${depMatch[3] || ''}`);

            const packageName = depMatch[1];
            const versionSpec = depMatch[2] || '';  // >=, ==, etc.
            const currentVersion = depMatch[3] || '';

            if (!currentVersion || currentVersion === '*') continue;

            try {
                const pypiData = await fetchPypiData(packageName);
                const latestVersion = pypiData.info.version;
                outputChannel.appendLine(`[updateDiagnostics] ${packageName}: current=${currentVersion}, latest=${latestVersion}`);

                if (latestVersion !== currentVersion) {
                    // Highlight the version portion of the line
                    const versionInLine = versionSpec + currentVersion;
                    const startPos = line.text.indexOf(versionInLine);
                    if (startPos !== -1) {
                        const range = new vscode.Range(
                            new vscode.Position(lineIndex, startPos),
                            new vscode.Position(lineIndex, startPos + versionInLine.length)
                        );

                        const diagnostic = new vscode.Diagnostic(
                            range,
                            `${packageName} is outdated. Latest version is ${latestVersion}`,
                            vscode.DiagnosticSeverity.Error
                        );
                        diagnostic.source = 'uv-pypi';
                        diagnostics.push(diagnostic);
                    }
                }
            } catch (e: any) {
                outputChannel.appendLine(`[updateDiagnostics] Error fetching ${packageName}: ${e.message}`);
            }
        }

        diagnosticCollection.set(document.uri, diagnostics);
    }

    function triggerUpdateDiagnostics(document: vscode.TextDocument) {
        if (timeout) {
            clearTimeout(timeout);
        }
        timeout = setTimeout(() => updateDiagnostics(document), 500);
    }

    if (vscode.window.activeTextEditor) {
        triggerUpdateDiagnostics(vscode.window.activeTextEditor.document);
    }

    context.subscriptions.push(
        vscode.window.onDidChangeActiveTextEditor(editor => {
            if (editor) triggerUpdateDiagnostics(editor.document);
        }),
        vscode.workspace.onDidChangeTextDocument(event => {
            triggerUpdateDiagnostics(event.document);
        }),
        vscode.workspace.onDidCloseTextDocument(document => {
            diagnosticCollection.delete(document.uri);
        })
    );

    // PyPI Version Hover Provider
    const pypiHoverProvider = vscode.languages.registerHoverProvider({ language: 'toml' }, {
        async provideHover(document, position, token) {
            outputChannel.appendLine(`[hover] provideHover called at line ${position.line}`);
            if (!document.fileName.endsWith('pyproject.toml')) {
                return null;
            }

            if (!isInDependencySection(document, position.line)) {
                return null;
            }

            const lineText = document.lineAt(position.line).text;
            const depMatch = lineText.match(DEP_LINE_REGEX);
            if (!depMatch) return null;

            const packageName = depMatch[1];
            const wordRange = document.getWordRangeAtPosition(position, /[a-zA-Z0-9_][a-zA-Z0-9._\-]*/);
            if (!wordRange) return null;
            const hoveredWord = document.getText(wordRange);
            if (hoveredWord !== packageName) return null;

            try {
                const pypiData = await fetchPypiData(packageName);
                const latestVersion = pypiData.info.version;
                const markdown = new vscode.MarkdownString();
                markdown.isTrusted = true;
                markdown.appendMarkdown(`**PyPI: ${packageName}**\n\nLatest version: \`${latestVersion}\`\n\n[View on PyPI](https://pypi.org/project/${packageName}/)`);
                return new vscode.Hover(markdown, wordRange);
            } catch (err: any) {
                outputChannel.appendLine(`[hover] Error: ${err.message}`);
                return null;
            }
        }
    });

    // PyPI Version Code Action Provider (Quick Fixes)
    const pypiCodeActionProvider = vscode.languages.registerCodeActionsProvider(
        { language: 'toml' },
        {
            async provideCodeActions(document, range, context, token) {
                if (!document.fileName.endsWith('pyproject.toml')) {
                    return [];
                }

                const lineIndex = range.start.line;
                if (!isInDependencySection(document, lineIndex)) {
                    return [];
                }

                const lineText = document.lineAt(lineIndex).text;
                const depMatch = lineText.match(DEP_LINE_REGEX);
                if (!depMatch) {
                    return [];
                }

                const packageName = depMatch[1];
                const versionSpec = depMatch[2] || '';  // >=, ==, etc.
                const currentVersion = depMatch[3] || '';

                if (!currentVersion || currentVersion === '*') {
                    return [];
                }

                try {
                    const pypiData = await fetchPypiData(packageName);
                    const latestVersion = pypiData.info.version;
                    const allVersions = Object.keys(pypiData.releases).sort((a, b) => b.localeCompare(a, undefined, { numeric: true, sensitivity: 'base' }));

                    const actions: vscode.CodeAction[] = [];

                    const createReplacementLine = (newVer: string) => {
                        // Replace the version number in the original line
                        return lineText.replace(
                            new RegExp(`(${versionSpec.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')})${currentVersion.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`),
                            `${versionSpec}${newVer}`
                        );
                    };

                    // Action 1: Upgrade to latest (if newer) — applied directly as a workspace edit
                    if (latestVersion !== currentVersion) {
                        const upgradeAction = new vscode.CodeAction(`Upgrade ${packageName} to latest (${latestVersion})`, vscode.CodeActionKind.QuickFix);
                        const edit = new vscode.WorkspaceEdit();
                        const fullLineRange = document.lineAt(lineIndex).range;
                        edit.replace(document.uri, fullLineRange, createReplacementLine(latestVersion));
                        upgradeAction.edit = edit;

                        // Associate action with the diagnostic on this line to ensure the lightbulb shows!
                        const lineDiagnostics = context.diagnostics.filter(d => d.range.start.line === lineIndex);
                        if (lineDiagnostics.length > 0) {
                            upgradeAction.diagnostics = lineDiagnostics;
                        }

                        upgradeAction.isPreferred = true;
                        actions.push(upgradeAction);
                    }

                    // Select specific version
                    const selectAction = new vscode.CodeAction(`Select version for ${packageName}...`, vscode.CodeActionKind.QuickFix);
                    selectAction.command = {
                        command: 'uv.selectVersion',
                        title: 'Select Version',
                        arguments: [document.uri, lineIndex, allVersions, lineText, versionSpec, currentVersion]
                    };
                    actions.push(selectAction);

                    return actions;
                } catch (err: any) {
                    outputChannel.appendLine(`[codeAction] Error: ${err.message}`);
                    return [];
                }
            }
        },
        { providedCodeActionKinds: [vscode.CodeActionKind.QuickFix] }
    );

    // Project Version & Python Version Bump Code Action Provider
    // Matches: version = "1.2.3" or requires-python = ">=3.14" / ">=3.14.1"
    const VERSION_LINE_REGEX = /^(\s*version\s*=\s*")([\d]+)\.([\d]+)\.([\d]+)(")/;
    const PYTHON_VERSION_REGEX = /^(\s*requires-python\s*=\s*"(?:>=|<=|~=|==|!=|>|<|===)?)([\d]+)\.([\d]+)(?:\.([\d]+))?(")/;

    const versionBumpProvider = vscode.languages.registerCodeActionsProvider(
        { language: 'toml' },
        {
            async provideCodeActions(document, range) {
                if (!document.fileName.endsWith('pyproject.toml')) {
                    return [];
                }

                const lineIndex = range.start.line;
                const lineText = document.lineAt(lineIndex).text;

                // Verify we're inside [project]
                let inProject = false;
                for (let i = lineIndex; i >= 0; i--) {
                    const t = document.lineAt(i).text.trim();
                    if (t.startsWith('[')) {
                        inProject = t === '[project]';
                        break;
                    }
                }
                if (!inProject) {
                    return [];
                }

                const actions: vscode.CodeAction[] = [];
                const fullLineRange = document.lineAt(lineIndex).range;

                // Check for project version line
                const versionMatch = lineText.match(VERSION_LINE_REGEX);
                if (versionMatch) {
                    const prefix = versionMatch[1];
                    const major = parseInt(versionMatch[2], 10);
                    const minor = parseInt(versionMatch[3], 10);
                    const build = parseInt(versionMatch[4], 10);
                    const suffix = versionMatch[5];

                    const bumps: [string, string][] = [
                        [`${major}.${minor}.${build + 1}`, 'build'],
                        [`${major}.${minor + 1}.0`, 'minor'],
                        [`${major + 1}.0.0`, 'major'],
                    ];

                    for (const [newVersion, label] of bumps) {
                        const action = new vscode.CodeAction(
                            `Bump version ${label} → ${newVersion}`,
                            vscode.CodeActionKind.QuickFix
                        );
                        const edit = new vscode.WorkspaceEdit();
                        edit.replace(document.uri, fullLineRange, `${prefix}${newVersion}${suffix}`);
                        action.edit = edit;
                        actions.push(action);
                    }
                }

                // Check for requires-python line
                const pyMatch = lineText.match(PYTHON_VERSION_REGEX);
                if (pyMatch) {
                    const prefix = pyMatch[1];
                    const suffix = pyMatch[5];
                    const currentPyVersion = pyMatch[4] !== undefined
                        ? `${pyMatch[2]}.${pyMatch[3]}.${pyMatch[4]}`
                        : `${pyMatch[2]}.${pyMatch[3]}`;

                    // Fetch real Python versions from endoflife.date API
                    const pyVersions = await fetchPythonVersions();

                    // Show latest release of each major version as direct quick-fix actions
                    const quickFixItems = pyVersions.quickFix.filter(v => v !== currentPyVersion);
                    for (const ver of quickFixItems) {
                        const action = new vscode.CodeAction(
                            `Python ${ver}`,
                            vscode.CodeActionKind.QuickFix
                        );
                        const edit = new vscode.WorkspaceEdit();
                        edit.replace(document.uri, fullLineRange, `${prefix}${ver}${suffix}`);
                        action.edit = edit;
                        actions.push(action);
                    }

                    // "More Python versions…" opens the full picker
                    const selectPyAction = new vscode.CodeAction(
                        'More Python versions…',
                        vscode.CodeActionKind.QuickFix
                    );
                    selectPyAction.command = {
                        command: 'uv.selectPythonVersion',
                        title: 'Select Python Version',
                        arguments: [document.uri, lineIndex, lineText, prefix, suffix, pyVersions.all]
                    };
                    actions.push(selectPyAction);
                }

                return actions;
            }
        },
        { providedCodeActionKinds: [vscode.CodeActionKind.QuickFix] }
    );

    // Command: Execute the version upgrade (replaces the line)
    const upgradeVersionCmd = vscode.commands.registerCommand('uv.upgradeVersion', async (uri: vscode.Uri, lineIndex: number, newText: string) => {
        const edit = new vscode.WorkspaceEdit();
        const document = await vscode.workspace.openTextDocument(uri);
        const line = document.lineAt(lineIndex);
        edit.replace(uri, line.range, newText);
        await vscode.workspace.applyEdit(edit);
    });

    // Command: Show QuickPick for versions and then upgrade
    const selectVersionCmd = vscode.commands.registerCommand('uv.selectVersion', async (uri: vscode.Uri, lineIndex: number, versions: string[], originalLine: string, versionSpec: string, currentVersion: string) => {
        const selected = await vscode.window.showQuickPick(versions, {
            title: 'Select Package Version'
        });

        if (selected) {
            const newText = originalLine.replace(
                new RegExp(`(${versionSpec.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')})${currentVersion.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`),
                `${versionSpec}${selected}`
            );

            const edit = new vscode.WorkspaceEdit();
            const document = await vscode.workspace.openTextDocument(uri);
            const line = document.lineAt(lineIndex);
            edit.replace(uri, line.range, newText);
            await vscode.workspace.applyEdit(edit);
        }
    });

    // Command: Show QuickPick for Python versions and replace requires-python
    const selectPythonVersionCmd = vscode.commands.registerCommand('uv.selectPythonVersion', async (uri: vscode.Uri, lineIndex: number, originalLine: string, prefix: string, suffix: string, versions?: string[]) => {
        const versionList = versions || (await fetchPythonVersions()).all;
        const selected = await vscode.window.showQuickPick(versionList, {
            title: 'Select Python Version'
        });

        if (selected) {
            const newText = `${prefix}${selected}${suffix}`;
            const edit = new vscode.WorkspaceEdit();
            const document = await vscode.workspace.openTextDocument(uri);
            const line = document.lineAt(lineIndex);
            edit.replace(uri, line.range, newText);
            await vscode.workspace.applyEdit(edit);
        }
    });

    // Command: Show Dependencies Dashboard
    const showDependenciesCmd = vscode.commands.registerCommand('uv.showDependencies', async () => {
        const editor = vscode.window.activeTextEditor;
        if (!editor || !editor.document.fileName.endsWith('pyproject.toml')) {
            vscode.window.showWarningMessage('Open a pyproject.toml file first.');
            return;
        }

        const document = editor.document;
        const uri = document.uri;

        // Collect all dependencies from the document
        interface DepInfo {
            name: string;
            versionSpec: string;
            currentVersion: string;
            lineIndex: number;
            lineText: string;
        }
        const deps: DepInfo[] = [];

        for (let lineIndex = 0; lineIndex < document.lineCount; lineIndex++) {
            if (!isInDependencySection(document, lineIndex)) {
                continue;
            }
            const lineText = document.lineAt(lineIndex).text;
            const depMatch = lineText.match(DEP_LINE_REGEX);
            if (!depMatch) { continue; }

            const packageName = depMatch[1];
            const versionSpec = depMatch[2] || '';
            const currentVersion = depMatch[3] || '';

            deps.push({ name: packageName, versionSpec, currentVersion, lineIndex, lineText });
        }

        if (deps.length === 0) {
            vscode.window.showInformationMessage('No dependencies found in this file.');
            return;
        }

        // Create webview panel
        const panel = vscode.window.createWebviewPanel(
            'uvDependencies',
            'UV: Dependencies',
            vscode.ViewColumn.One,
            { enableScripts: true }
        );

        // Show loading state
        panel.webview.html = getDependencyHtml([], true);

        // Fetch PyPI data for all dependencies
        interface DepRow {
            name: string;
            currentVersion: string;
            latestVersion: string;
            versionSpec: string;
            lineIndex: number;
            lineText: string;
            upToDate: boolean;
            error: boolean;
        }
        const rows: DepRow[] = [];

        const results = await Promise.allSettled(
            deps.map(async (dep) => {
                if (!dep.currentVersion || dep.currentVersion === '*') {
                    return { ...dep, latestVersion: 'N/A', upToDate: true, error: false };
                }
                try {
                    const pypiData = await fetchPypiData(dep.name);
                    const latestVersion = pypiData.info.version;
                    return { ...dep, latestVersion, upToDate: latestVersion === dep.currentVersion, error: false };
                } catch {
                    return { ...dep, latestVersion: 'error', upToDate: false, error: true };
                }
            })
        );

        for (const result of results) {
            if (result.status === 'fulfilled') {
                rows.push(result.value);
            }
        }

        panel.webview.html = getDependencyHtml(rows, false);

        // Handle messages from webview
        panel.webview.onDidReceiveMessage(async (message: { command: string; name: string; lineIndex: number; lineText: string; versionSpec: string; currentVersion: string; latestVersion: string }) => {
            if (message.command === 'upgrade') {
                const doc = await vscode.workspace.openTextDocument(uri);
                const line = doc.lineAt(message.lineIndex);
                const escapedSpec = message.versionSpec.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
                const escapedVer = message.currentVersion.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
                const newText = line.text.replace(
                    new RegExp(`(${escapedSpec})${escapedVer}`),
                    `${message.versionSpec}${message.latestVersion}`
                );
                const edit = new vscode.WorkspaceEdit();
                edit.replace(uri, line.range, newText);
                await vscode.workspace.applyEdit(edit);
                await doc.save();

                // Update the row in the webview
                panel.webview.postMessage({ command: 'upgraded', name: message.name, latestVersion: message.latestVersion });
            } else if (message.command === 'upgradeAll') {
                const doc = await vscode.workspace.openTextDocument(uri);
                // Apply edits bottom-up so line indices stay valid
                const outdated = rows
                    .filter(r => !r.upToDate && !r.error && r.currentVersion && r.currentVersion !== '*')
                    .sort((a, b) => b.lineIndex - a.lineIndex);

                const edit = new vscode.WorkspaceEdit();
                for (const row of outdated) {
                    const line = doc.lineAt(row.lineIndex);
                    const escapedSpec = row.versionSpec.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
                    const escapedVer = row.currentVersion.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
                    const newText = line.text.replace(
                        new RegExp(`(${escapedSpec})${escapedVer}`),
                        `${row.versionSpec}${row.latestVersion}`
                    );
                    edit.replace(uri, line.range, newText);
                }
                await vscode.workspace.applyEdit(edit);
                await doc.save();

                panel.webview.postMessage({ command: 'allUpgraded' });
            }
        }, undefined, context.subscriptions);
    });

    context.subscriptions.push(uvSyncCmd, uvAddCmd, uvRunCmd, pypiHoverProvider, pypiCodeActionProvider, versionBumpProvider, upgradeVersionCmd, selectVersionCmd, selectPythonVersionCmd, showDependenciesCmd);
}

function getDependencyHtml(rows: Array<{ name: string; currentVersion: string; latestVersion: string; versionSpec: string; lineIndex: number; lineText: string; upToDate: boolean; error: boolean }>, loading: boolean): string {
    const hasOutdated = rows.some(r => !r.upToDate && !r.error);

    const tableRows = rows.map(row => {
        const statusCell = row.error
            ? '<span class="error">&#x26A0; fetch error</span>'
            : row.upToDate
                ? '<span class="ok">&#x2714;</span>'
                : `<button class="upgrade-btn" data-name="${escapeHtml(row.name)}" data-line="${row.lineIndex}" data-linetext="${escapeHtml(row.lineText)}" data-spec="${escapeHtml(row.versionSpec)}" data-current="${escapeHtml(row.currentVersion)}" data-latest="${escapeHtml(row.latestVersion)}">Upgrade</button>`;

        return `<tr id="row-${escapeHtml(row.name)}" class="${row.upToDate ? '' : row.error ? 'row-error' : 'row-outdated'}">
            <td class="name"><a href="https://pypi.org/project/${escapeHtml(row.name)}/">${escapeHtml(row.name)}</a></td>
            <td class="version">${escapeHtml(row.currentVersion || 'any')}</td>
            <td class="version">${escapeHtml(row.latestVersion)}</td>
            <td class="status">${statusCell}</td>
        </tr>`;
    }).join('\n');

    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<style>
    body {
        font-family: var(--vscode-font-family);
        color: var(--vscode-foreground);
        background: var(--vscode-editor-background);
        padding: 16px;
    }
    h1 { font-size: 1.4em; margin-bottom: 4px; }
    .subtitle { color: var(--vscode-descriptionForeground); margin-bottom: 16px; }
    table { width: 100%; border-collapse: collapse; }
    th, td { text-align: left; padding: 6px 12px; border-bottom: 1px solid var(--vscode-widget-border); }
    th { color: var(--vscode-descriptionForeground); font-weight: 600; font-size: 0.85em; text-transform: uppercase; }
    .name a { color: var(--vscode-textLink-foreground); text-decoration: none; }
    .name a:hover { text-decoration: underline; }
    .version { font-family: var(--vscode-editor-font-family); }
    .ok { color: var(--vscode-testing-iconPassed); font-size: 1.2em; }
    .error { color: var(--vscode-testing-iconErrored); font-size: 0.85em; }
    .row-outdated .version:nth-child(2) { color: var(--vscode-errorForeground); }
    .upgrade-btn, .upgrade-all-btn {
        background: var(--vscode-button-background);
        color: var(--vscode-button-foreground);
        border: none;
        padding: 3px 10px;
        border-radius: 2px;
        cursor: pointer;
        font-size: 0.85em;
    }
    .upgrade-btn:hover, .upgrade-all-btn:hover {
        background: var(--vscode-button-hoverBackground);
    }
    .upgrade-all-btn { margin-bottom: 16px; padding: 5px 14px; font-size: 0.9em; }
    .loading { text-align: center; padding: 40px; color: var(--vscode-descriptionForeground); }
    .summary { margin-bottom: 12px; font-size: 0.9em; color: var(--vscode-descriptionForeground); }
</style>
</head>
<body>
    <h1>Dependencies</h1>
    ${loading ? '<div class="loading">Fetching dependency info from PyPI...</div>' : `
    <p class="summary">${rows.length} dependencies &mdash; ${rows.filter(r => r.upToDate).length} up to date, ${rows.filter(r => !r.upToDate && !r.error).length} outdated${rows.some(r => r.error) ? `, ${rows.filter(r => r.error).length} errors` : ''}</p>
    ${hasOutdated ? '<button class="upgrade-all-btn" id="upgradeAllBtn">Upgrade All</button>' : ''}
    <table>
        <thead><tr><th>Package</th><th>Current</th><th>Latest</th><th>Status</th></tr></thead>
        <tbody>${tableRows}</tbody>
    </table>
    <script>
        const vscode = acquireVsCodeApi();

        document.querySelectorAll('.upgrade-btn').forEach(btn => {
            btn.addEventListener('click', () => {
                btn.disabled = true;
                btn.textContent = 'Upgrading...';
                vscode.postMessage({
                    command: 'upgrade',
                    name: btn.dataset.name,
                    lineIndex: parseInt(btn.dataset.line),
                    lineText: btn.dataset.linetext,
                    versionSpec: btn.dataset.spec,
                    currentVersion: btn.dataset.current,
                    latestVersion: btn.dataset.latest
                });
            });
        });

        const upgradeAllBtn = document.getElementById('upgradeAllBtn');
        if (upgradeAllBtn) {
            upgradeAllBtn.addEventListener('click', () => {
                upgradeAllBtn.disabled = true;
                upgradeAllBtn.textContent = 'Upgrading all...';
                document.querySelectorAll('.upgrade-btn').forEach(btn => {
                    btn.disabled = true;
                    btn.textContent = 'Upgrading...';
                });
                vscode.postMessage({ command: 'upgradeAll' });
            });
        }

        window.addEventListener('message', event => {
            const msg = event.data;
            if (msg.command === 'upgraded') {
                const row = document.getElementById('row-' + msg.name);
                if (row) {
                    row.className = '';
                    row.querySelector('.version:nth-child(2)').textContent = msg.latestVersion;
                    row.querySelector('.status').innerHTML = '<span class="ok">&#x2714;</span>';
                }
            } else if (msg.command === 'allUpgraded') {
                document.querySelectorAll('.row-outdated').forEach(row => {
                    const latest = row.querySelector('.version:nth-child(3)').textContent;
                    row.className = '';
                    row.querySelector('.version:nth-child(2)').textContent = latest;
                    row.querySelector('.status').innerHTML = '<span class="ok">&#x2714;</span>';
                });
                if (upgradeAllBtn) { upgradeAllBtn.remove(); }
            }
        });
    </script>`}
</body>
</html>`;
}

function escapeHtml(text: string): string {
    return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

export function deactivate() { }
