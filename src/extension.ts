import * as vscode from 'vscode';
import * as https from 'https';
import * as path from 'path';
import {
    DepLocation,
    ParsedDocument,
    SnapshotState,
    buildSnapshot,
    depsOnLine,
    findDepAtPosition,
    hasVersionUpdates,
    parseDocument,
    parseRequirements,
} from './parser';

const pypiCache = new Map<string, any>();

const FALLBACK_PYTHON_VERSIONS = [
    '3.14', '3.13', '3.12', '3.11', '3.10',
    '3.9', '3.8', '3.7', '3.6', '3.5',
    '3.4', '3.3', '3.2', '3.1', '3.0',
];

let pythonVersionCache: { quickFix: string[]; all: string[] } | null = null;

function isPyprojectTomlDocument(document: vscode.TextDocument): boolean {
    const scheme = document.uri.scheme;
    if (scheme === 'output' || scheme === 'debug') {
        return false;
    }
    return path.basename(document.fileName).toLowerCase() === 'pyproject.toml';
}

function isRequirementsTxtDocument(document: vscode.TextDocument): boolean {
    const scheme = document.uri.scheme;
    if (scheme === 'output' || scheme === 'debug') {
        return false;
    }
    const base = path.basename(document.fileName).toLowerCase();
    if (base === 'requirements.txt') {
        return true;
    }
    if (/^requirements[-_].+\.txt$/.test(base)) {
        return true;
    }
    if (base.endsWith('.txt') && path.basename(path.dirname(document.fileName)).toLowerCase() === 'requirements') {
        return true;
    }
    return false;
}

function isSupportedDocument(document: vscode.TextDocument): boolean {
    return isPyprojectTomlDocument(document) || isRequirementsTxtDocument(document);
}

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
                    const quickFix = python3
                        .filter(c => parseInt(c.cycle.split('.')[1], 10) >= 10)
                        .map(c => c.latest);
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
    outputChannel.show(true);
    vscode.window.setStatusBarMessage('Practical UV extension active', 5000);
    console.log('uv-vscode extension is now active!');
    const pyprojectSelector: vscode.DocumentSelector = [
        { language: 'toml', pattern: '**/pyproject.toml' },
        { pattern: '**/pyproject.toml' }
    ];

    const supportedSelector: vscode.DocumentSelector = [
        ...(pyprojectSelector as vscode.DocumentFilter[]),
        { pattern: '**/requirements.txt' },
        { pattern: '**/requirements-*.txt' },
        { pattern: '**/requirements_*.txt' },
        { pattern: '**/requirements/*.txt' },
    ];

    const runInTerminal = (commandName: string, commandText: string) => {
        let terminal = vscode.window.terminals.find(t => t.name === 'uv');
        if (!terminal) {
            terminal = vscode.window.createTerminal('uv');
        }
        terminal.show();
        terminal.sendText(commandText);
    };

    const uvSyncCmd = vscode.commands.registerCommand('uv.sync', () => {
        runInTerminal('uv sync', 'uv sync');
        vscode.window.showInformationMessage('Running uv sync...');
    });

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

    const diagnosticCollection = vscode.languages.createDiagnosticCollection('uv-pypi');
    context.subscriptions.push(diagnosticCollection);

    let timeout: NodeJS.Timeout | undefined = undefined;
    const lastSavedSnapshot = new Map<string, SnapshotState>();
    const parsedDocCache = new Map<string, { version: number; parsed: ParsedDocument }>();

    function getParsedDocument(document: vscode.TextDocument): ParsedDocument {
        const key = document.uri.toString();
        const cached = parsedDocCache.get(key);
        if (cached && cached.version === document.version) {
            return cached.parsed;
        }
        const text = document.getText();
        const parsed = isPyprojectTomlDocument(document)
            ? parseDocument(text)
            : parseRequirements(text);
        parsedDocCache.set(key, { version: document.version, parsed });
        if (parsed.error) {
            outputChannel.appendLine(`[parser] parse error: ${parsed.error.message}`);
        }
        return parsed;
    }

    async function updateDiagnostics(document: vscode.TextDocument) {
        outputChannel.appendLine(`[updateDiagnostics] Checking file: ${document.fileName}`);
        if (!isSupportedDocument(document)) {
            return;
        }

        const parsed = getParsedDocument(document);
        const diagnostics: vscode.Diagnostic[] = [];

        for (const dep of parsed.deps) {
            outputChannel.appendLine(`[updateDiagnostics] Found dependency: ${dep.packageName} ${dep.versionSpec} ${dep.currentVersion}`);
            if (!dep.currentVersion || dep.currentVersion === '*') {
                continue;
            }

            try {
                const pypiData = await fetchPypiData(dep.packageName);
                const latestVersion = pypiData.info.version;
                outputChannel.appendLine(`[updateDiagnostics] ${dep.packageName}: current=${dep.currentVersion}, latest=${latestVersion}`);

                if (latestVersion !== dep.currentVersion) {
                    const lineText = document.lineAt(dep.line).text;
                    const versionInItem = dep.versionSpec + dep.currentVersion;
                    const relativeStart = lineText.slice(dep.contentStart, dep.contentEnd).indexOf(versionInItem);
                    if (relativeStart !== -1) {
                        const startPos = dep.contentStart + relativeStart;
                        const range = new vscode.Range(
                            new vscode.Position(dep.line, startPos),
                            new vscode.Position(dep.line, startPos + versionInItem.length)
                        );

                        const diagnostic = new vscode.Diagnostic(
                            range,
                            `${dep.packageName} is outdated. Latest version is ${latestVersion}`,
                            vscode.DiagnosticSeverity.Error
                        );
                        diagnostic.source = 'uv-pypi';
                        diagnostics.push(diagnostic);
                    }
                }
            } catch (e: any) {
                outputChannel.appendLine(`[updateDiagnostics] Error fetching ${dep.packageName}: ${e.message}`);
            }
        }

        diagnosticCollection.set(document.uri, diagnostics);
    }

    function triggerUpdateDiagnostics(document: vscode.TextDocument) {
        if (!isSupportedDocument(document)) {
            return;
        }
        if (timeout) {
            clearTimeout(timeout);
        }
        timeout = setTimeout(() => updateDiagnostics(document), 500);
    }

    const convertStatusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
    convertStatusBar.text = '$(arrow-up) Convert to uv';
    convertStatusBar.tooltip = 'Run uv init / uv add -r on this requirements.txt';
    convertStatusBar.command = 'uv.convertToUv';
    context.subscriptions.push(convertStatusBar);

    const refreshActiveDocContext = (document: vscode.TextDocument | undefined) => {
        const isReq = !!document && isRequirementsTxtDocument(document);
        vscode.commands.executeCommand('setContext', 'uv.requirementsActive', isReq);
        if (isReq) {
            convertStatusBar.show();
        } else {
            convertStatusBar.hide();
        }
    };

    if (vscode.window.activeTextEditor) {
        const activeDoc = vscode.window.activeTextEditor.document;
        if (isPyprojectTomlDocument(activeDoc)) {
            lastSavedSnapshot.set(activeDoc.uri.toString(), buildSnapshot(getParsedDocument(activeDoc)));
        }
        triggerUpdateDiagnostics(activeDoc);
        refreshActiveDocContext(activeDoc);
    }

    context.subscriptions.push(
        vscode.window.onDidChangeActiveTextEditor(editor => {
            refreshActiveDocContext(editor?.document);
            if (editor) triggerUpdateDiagnostics(editor.document);
        }),
        vscode.workspace.onDidChangeTextDocument(event => {
            triggerUpdateDiagnostics(event.document);
        }),
        vscode.workspace.onDidOpenTextDocument(document => {
            if (!isPyprojectTomlDocument(document)) {
                return;
            }
            lastSavedSnapshot.set(document.uri.toString(), buildSnapshot(getParsedDocument(document)));
        }),
        vscode.workspace.onDidSaveTextDocument(async document => {
            if (!isPyprojectTomlDocument(document)) {
                return;
            }

            const key = document.uri.toString();
            const previous = lastSavedSnapshot.get(key);
            const current = buildSnapshot(getParsedDocument(document));
            const { dependencyChanged, projectVersionChanged } = hasVersionUpdates(previous, current);

            if (dependencyChanged || projectVersionChanged) {
                const parts: string[] = [];
                if (dependencyChanged) {
                    parts.push('package versions');
                }
                if (projectVersionChanged) {
                    parts.push('project version');
                }

                const selection = await vscode.window.showInformationMessage(
                    `Detected updates to ${parts.join(' and ')}. Run uv sync now?`,
                    'Run uv sync',
                    'Later'
                );

                if (selection === 'Run uv sync') {
                    runInTerminal('uv sync', 'uv sync');
                    vscode.window.showInformationMessage('Running uv sync...');
                }
            }

            lastSavedSnapshot.set(key, current);
        }),
        vscode.workspace.onDidCloseTextDocument(document => {
            diagnosticCollection.delete(document.uri);
            const key = document.uri.toString();
            parsedDocCache.delete(key);
            lastSavedSnapshot.delete(key);
        })
    );

    const pypiHoverProvider = vscode.languages.registerHoverProvider(supportedSelector, {
        async provideHover(document, position, token) {
            outputChannel.appendLine(`[hover] provideHover called at line ${position.line}`);
            if (!isSupportedDocument(document)) {
                return null;
            }

            const parsed = getParsedDocument(document);
            const dep = findDepAtPosition(parsed, position.line, position.character);
            if (!dep) return null;

            const wordRange = document.getWordRangeAtPosition(position, /[a-zA-Z0-9_][a-zA-Z0-9._\-]*/);
            if (!wordRange) return null;
            const hoveredWord = document.getText(wordRange);
            if (hoveredWord !== dep.packageName) return null;

            try {
                const pypiData = await fetchPypiData(dep.packageName);
                const latestVersion = pypiData.info.version;
                const markdown = new vscode.MarkdownString();
                markdown.isTrusted = true;
                markdown.appendMarkdown(`**PyPI: ${dep.packageName}**\n\nLatest version: \`${latestVersion}\`\n\n[View on PyPI](https://pypi.org/project/${dep.packageName}/)`);
                return new vscode.Hover(markdown, wordRange);
            } catch (err: any) {
                outputChannel.appendLine(`[hover] Error: ${err.message}`);
                return null;
            }
        }
    });

    const pypiCodeActionProvider = vscode.languages.registerCodeActionsProvider(
        supportedSelector,
        {
            async provideCodeActions(document, range, context, token) {
                if (!isSupportedDocument(document)) {
                    return [];
                }

                const parsed = getParsedDocument(document);
                const lineIndex = range.start.line;
                const lineDeps = depsOnLine(parsed, lineIndex);
                if (lineDeps.length === 0) {
                    return [];
                }
                const dep = findDepAtPosition(parsed, lineIndex, range.start.character) || lineDeps[0];

                if (!dep.currentVersion || dep.currentVersion === '*') {
                    return [];
                }

                const lineText = document.lineAt(lineIndex).text;

                try {
                    const pypiData = await fetchPypiData(dep.packageName);
                    const latestVersion = pypiData.info.version;
                    const allVersions = Object.keys(pypiData.releases).sort((a, b) => b.localeCompare(a, undefined, { numeric: true, sensitivity: 'base' }));

                    const actions: vscode.CodeAction[] = [];

                    const createReplacementLine = (newVer: string) => {
                        const newItem = `${dep.packageWithExtras}${dep.versionSpec}${newVer}`;
                        return lineText.slice(0, dep.contentStart) + newItem + lineText.slice(dep.contentEnd);
                    };

                    if (latestVersion !== dep.currentVersion) {
                        const upgradeAction = new vscode.CodeAction(`Upgrade ${dep.packageName} to latest (${latestVersion})`, vscode.CodeActionKind.QuickFix);
                        const edit = new vscode.WorkspaceEdit();
                        const fullLineRange = document.lineAt(lineIndex).range;
                        edit.replace(document.uri, fullLineRange, createReplacementLine(latestVersion));
                        upgradeAction.edit = edit;

                        const lineDiagnostics = context.diagnostics.filter(d => d.range.start.line === lineIndex);
                        if (lineDiagnostics.length > 0) {
                            upgradeAction.diagnostics = lineDiagnostics;
                        }

                        upgradeAction.isPreferred = true;
                        actions.push(upgradeAction);
                    }

                    const selectAction = new vscode.CodeAction(`Select version for ${dep.packageName}...`, vscode.CodeActionKind.QuickFix);
                    selectAction.command = {
                        command: 'uv.selectVersion',
                        title: 'Select Version',
                        arguments: [document.uri, lineIndex, allVersions, lineText, dep.contentStart, dep.contentEnd, `${dep.packageWithExtras}${dep.versionSpec}`]
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
    const VERSION_LINE_REGEX = /^(\s*version\s*=\s*["'])([\d]+)\.([\d]+)\.([\d]+)(["'])/;
    const PYTHON_VERSION_REGEX = /^(\s*requires-python\s*=\s*["'](?:>=|<=|~=|==|!=|>|<|===)?)([\d]+)\.([\d]+)(?:\.([\d]+))?(["'])/;

    const versionBumpProvider = vscode.languages.registerCodeActionsProvider(
        pyprojectSelector,
        {
            async provideCodeActions(document, range) {
                if (!isPyprojectTomlDocument(document)) {
                    return [];
                }

                const lineIndex = range.start.line;
                const lineText = document.lineAt(lineIndex).text;

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

                const pyMatch = lineText.match(PYTHON_VERSION_REGEX);
                if (pyMatch) {
                    const prefix = pyMatch[1];
                    const suffix = pyMatch[5];
                    const currentPyVersion = pyMatch[4] !== undefined
                        ? `${pyMatch[2]}.${pyMatch[3]}.${pyMatch[4]}`
                        : `${pyMatch[2]}.${pyMatch[3]}`;

                    const pyVersions = await fetchPythonVersions();

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

    const upgradeVersionCmd = vscode.commands.registerCommand('uv.upgradeVersion', async (uri: vscode.Uri, lineIndex: number, newText: string) => {
        const edit = new vscode.WorkspaceEdit();
        const document = await vscode.workspace.openTextDocument(uri);
        const line = document.lineAt(lineIndex);
        edit.replace(uri, line.range, newText);
        await vscode.workspace.applyEdit(edit);
    });

    const selectVersionCmd = vscode.commands.registerCommand('uv.selectVersion', async (uri: vscode.Uri, lineIndex: number, versions: string[], originalLine: string, itemStart: number, itemEnd: number, itemPrefix: string) => {
        const selected = await vscode.window.showQuickPick(versions, {
            title: 'Select Package Version'
        });

        if (selected) {
            const newText = originalLine.slice(0, itemStart) + `${itemPrefix}${selected}` + originalLine.slice(itemEnd);

            const edit = new vscode.WorkspaceEdit();
            const document = await vscode.workspace.openTextDocument(uri);
            const line = document.lineAt(lineIndex);
            edit.replace(uri, line.range, newText);
            await vscode.workspace.applyEdit(edit);
        }
    });

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

    const showDependenciesCmd = vscode.commands.registerCommand('uv.showDependencies', async () => {
        const editor = vscode.window.activeTextEditor;
        if (!editor || !isSupportedDocument(editor.document)) {
            vscode.window.showWarningMessage('Open a pyproject.toml or requirements.txt file first.');
            return;
        }

        const document = editor.document;
        const uri = document.uri;
        const parsed = getParsedDocument(document);

        if (parsed.deps.length === 0) {
            vscode.window.showInformationMessage('No dependencies found in this file.');
            return;
        }

        const panel = vscode.window.createWebviewPanel(
            'uvDependencies',
            'UV: Dependencies',
            vscode.ViewColumn.One,
            { enableScripts: true }
        );

        panel.webview.html = getDependencyHtml([], true);

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
            parsed.deps.map(async (dep: DepLocation) => {
                const lineText = document.lineAt(dep.line).text;
                const base = {
                    name: dep.packageName,
                    currentVersion: dep.currentVersion,
                    versionSpec: dep.versionSpec,
                    lineIndex: dep.line,
                    lineText,
                };
                if (!dep.currentVersion || dep.currentVersion === '*') {
                    return { ...base, latestVersion: 'N/A', upToDate: true, error: false };
                }
                try {
                    const pypiData = await fetchPypiData(dep.packageName);
                    const latestVersion = pypiData.info.version;
                    return { ...base, latestVersion, upToDate: latestVersion === dep.currentVersion, error: false };
                } catch {
                    return { ...base, latestVersion: 'error', upToDate: false, error: true };
                }
            })
        );

        for (const result of results) {
            if (result.status === 'fulfilled') {
                rows.push(result.value);
            }
        }

        panel.webview.html = getDependencyHtml(rows, false);

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

                panel.webview.postMessage({ command: 'upgraded', name: message.name, latestVersion: message.latestVersion });
            } else if (message.command === 'upgradeAll') {
                const doc = await vscode.workspace.openTextDocument(uri);
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

    const convertToUvCmd = vscode.commands.registerCommand('uv.convertToUv', async () => {
        const editor = vscode.window.activeTextEditor;
        if (!editor || !isRequirementsTxtDocument(editor.document)) {
            vscode.window.showWarningMessage('Open a requirements.txt file first.');
            return;
        }

        const reqUri = editor.document.uri;
        const folder = vscode.workspace.getWorkspaceFolder(reqUri);
        if (!folder) {
            vscode.window.showWarningMessage('requirements.txt must be inside an open workspace folder.');
            return;
        }

        const pyprojectUri = vscode.Uri.joinPath(folder.uri, 'pyproject.toml');
        let hasPyproject = false;
        try {
            await vscode.workspace.fs.stat(pyprojectUri);
            hasPyproject = true;
        } catch {
            hasPyproject = false;
        }

        const reqRel = path.relative(folder.uri.fsPath, reqUri.fsPath) || path.basename(reqUri.fsPath);
        const reqArg = /\s/.test(reqRel) ? `"${reqRel}"` : reqRel;

        const message = hasPyproject
            ? `pyproject.toml already exists in ${folder.name}. Run "uv add -r ${reqRel}" to import dependencies?`
            : `Initialize a uv project in ${folder.name} ("uv init") and import dependencies from ${reqRel}?`;

        const choice = await vscode.window.showInformationMessage(message, { modal: true }, 'Convert');
        if (choice !== 'Convert') {
            return;
        }

        let terminal = vscode.window.terminals.find(t => t.name === 'uv');
        if (!terminal || terminal.exitStatus !== undefined) {
            terminal = vscode.window.createTerminal({ name: 'uv', cwd: folder.uri.fsPath });
        }
        terminal.show();
        if (!hasPyproject) {
            terminal.sendText('uv init');
        }
        terminal.sendText(`uv add -r ${reqArg}`);
    });

    context.subscriptions.push(uvSyncCmd, uvAddCmd, uvRunCmd, pypiHoverProvider, pypiCodeActionProvider, versionBumpProvider, upgradeVersionCmd, selectVersionCmd, selectPythonVersionCmd, showDependenciesCmd, convertToUvCmd);
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
