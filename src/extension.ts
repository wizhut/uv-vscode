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
            provideCodeActions(document, range) {
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
                    const major = parseInt(pyMatch[2], 10);
                    const minor = parseInt(pyMatch[3], 10);
                    const hasPatch = pyMatch[4] !== undefined;
                    const patch = hasPatch ? parseInt(pyMatch[4], 10) : 0;
                    const suffix = pyMatch[5];

                    if (hasPatch) {
                        // 3-part: >=3.14.1 → bump patch, minor, major
                        const bumps: [string, string][] = [
                            [`${major}.${minor}.${patch + 1}`, 'patch'],
                            [`${major}.${minor + 1}.0`, 'minor'],
                            [`${major + 1}.0.0`, 'major'],
                        ];
                        for (const [newVersion, label] of bumps) {
                            const action = new vscode.CodeAction(
                                `Bump Python ${label} → ${newVersion}`,
                                vscode.CodeActionKind.QuickFix
                            );
                            const edit = new vscode.WorkspaceEdit();
                            edit.replace(document.uri, fullLineRange, `${prefix}${newVersion}${suffix}`);
                            action.edit = edit;
                            actions.push(action);
                        }
                    } else {
                        // 2-part: >=3.14 → bump minor, major
                        const bumps: [string, string][] = [
                            [`${major}.${minor + 1}`, 'minor'],
                            [`${major + 1}.0`, 'major'],
                        ];
                        for (const [newVersion, label] of bumps) {
                            const action = new vscode.CodeAction(
                                `Bump Python ${label} → ${newVersion}`,
                                vscode.CodeActionKind.QuickFix
                            );
                            const edit = new vscode.WorkspaceEdit();
                            edit.replace(document.uri, fullLineRange, `${prefix}${newVersion}${suffix}`);
                            action.edit = edit;
                            actions.push(action);
                        }
                    }
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

    context.subscriptions.push(uvSyncCmd, uvAddCmd, uvRunCmd, pypiHoverProvider, pypiCodeActionProvider, versionBumpProvider, upgradeVersionCmd, selectVersionCmd);
}

export function deactivate() { }
