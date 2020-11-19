/*
 * Copyright (c) 2020 Trond Snekvik
 *
 * SPDX-License-Identifier: MIT
 */
'use strict';
import * as vscode from 'vscode';
import * as dts from './dts';
import * as types from './types';
import * as zephyr from './zephyr';
import {lint, LintCtx} from './lint';
import * as path from 'path';
import { DiagnosticsSet } from './diags';
import { existsSync, readFile, writeFile, writeFileSync } from 'fs';
import { DTSTreeView } from './treeView';

const config = vscode.workspace.getConfiguration('devicetree');

function getConfig(variable: string) {
    const result = config.inspect(variable);
    if (result) {
        return result.workspaceFolderValue || result.workspaceValue || result.globalValue || result.defaultValue;
    }
    return undefined;
}

function getBindingDirs(): string[] {
    const dirs = getConfig('bindings') as string[];
    return dirs.map(d => {
        return d.replace(/\${(.*?)}/g, (original, name: string) => {
            if (name === 'workspaceFolder') {
                return vscode.workspace.workspaceFolders?.[0].uri.fsPath ?? vscode.env.appRoot;
            }

            if (name.startsWith('workspaceFolder:')) {
                const folder = name.split(':')[1];
                return vscode.workspace.workspaceFolders.find(w => w.name === folder)?.uri.fsPath ?? original;
            }

            if (['zephyr_base', 'zephyrbase'].includes(name.toLowerCase())) {
                return zephyr.zephyrRoot ?? original;
            }

            return original;
        });
    }).map(path.normalize);
}

function appendPropSnippet(p: types.PropertyType, snippet: vscode.SnippetString, node?: dts.Node) {
    switch (p.type) {
        case 'boolean':
            snippet.appendText(p.name);
            break;
        case 'array': {
            snippet.appendText(p.name + ' = < ');
            const cells = dts.getCells(p.name, node?.parent);
            if (cells) {
                cells.forEach((c, i) => {
                    if (node && i === 0 && p.name === 'reg' && !isNaN(node.address)) {
                        snippet.appendPlaceholder(`0x${node.address.toString(16)}`);
                    } else {
                        snippet.appendPlaceholder(c);
                    }
                    if (i !== cells.length - 1) {
                        snippet.appendText(' ');
                    }
                });
            } else {
                snippet.appendTabstop();
            }
            snippet.appendText(' >');
            break;
        }
        case 'int':
            snippet.appendText(p.name + ' = < ');
            if (p.default) {
                snippet.appendPlaceholder(p.default.toString());
            } else if (p.const) {
                snippet.appendText(p.const.toString());
            } else if (p.enum) {
                snippet.appendPlaceholder(p.enum[0]);
            } else {
                snippet.appendTabstop();
            }
            snippet.appendText(' >');
            break;
        case 'string':
        case 'string-array':
            snippet.appendText(p.name + ' = "');
            if (p.default) {
                snippet.appendPlaceholder(p.default.toString());
            } else if (p.const) {
                snippet.appendText(p.const.toString());
            } else if (p.enum) {
                snippet.appendPlaceholder(p.enum[0]);
            } else {
                snippet.appendTabstop();
            }
            snippet.appendText('"');
            break;
        case 'phandle':
        case 'phandle-array':
            snippet.appendText(p.name + ' = < &');
            snippet.appendPlaceholder('label');
            snippet.appendText(' >');
            break;
        case 'uint8-array':
            snippet.appendText(p.name + ' = [ ');
            snippet.appendTabstop();
            snippet.appendText(' ]');
            break;
        case 'compound':
            snippet.appendText(p.name + ' = ');
            snippet.appendTabstop();
            break;
    }

    snippet.appendText(';');
}

class DTSDocumentProvider implements vscode.TextDocumentContentProvider {
    private parser: dts.Parser;
    private changeEmitter: vscode.EventEmitter<vscode.Uri>;
    private currUri?: vscode.Uri;
    onDidChange: vscode.Event<vscode.Uri>;

    constructor(parser: dts.Parser) {
        this.changeEmitter = new vscode.EventEmitter();
        this.onDidChange = this.changeEmitter.event;
        this.parser = parser;
        this.parser.onChange(ctx => {
            if (this.currUri && ctx.has(vscode.Uri.file(this.currUri.path))) {
                this.changeEmitter.fire(this.currUri);
            }
        });
    }

    provideTextDocumentContent(uri: vscode.Uri, token: vscode.CancellationToken): vscode.ProviderResult<string> {
        this.currUri = uri;
        const ctx = this.parser.ctx(vscode.Uri.file(uri.path));
        if (!ctx) {
            return `/* Unable to resolve path ${uri.toString()} */`;
        }

        return ctx.toString();
    }

}

type StoredCtx = { name: string, boardFile: string, overlays: string[], board: zephyr.Board };

class DTSEngine implements
    vscode.DocumentSymbolProvider,
    vscode.WorkspaceSymbolProvider,
    vscode.DefinitionProvider,
    vscode.HoverProvider,
    vscode.CompletionItemProvider,
    vscode.SignatureHelpProvider,
    vscode.DocumentRangeFormattingEditProvider,
    vscode.DocumentLinkProvider,
    vscode.ReferenceProvider,
    vscode.TypeDefinitionProvider {
    parser: dts.Parser;
    diags: vscode.DiagnosticCollection;
    diagSet?: DiagnosticsSet;
    types: types.TypeLoader;
    prevDiagUris: vscode.Uri[] = [];
    treeView: DTSTreeView;

    constructor() {
        this.diags = vscode.languages.createDiagnosticCollection('DeviceTree');
        this.types = new types.TypeLoader();

        const defines = (getConfig('deviceTree.defines') ?? {}) as {[name: string]: string};

        this.parser = new dts.Parser(defines, [], this.types);
        this.parser.onChange(ctx => {
            const lintCtx: LintCtx =  {
                diags: new DiagnosticsSet(),
                types: this.types,
                ctx,
                gpioControllers: [],
                labels: {},
            };

            lint(lintCtx);
            const diags = ctx.getDiags();
            diags.merge(lintCtx.diags);
            this.setDiags(diags);
        });

        this.parser.onOpen(() => {
            this.saveCtxs();
        });

        this.parser.onDelete(() => {
            this.saveCtxs();
        });

        this.treeView = new DTSTreeView(this.parser);
    }

    /** Returns all pHandle references to the node under cursor.  */
    provideReferences(document: vscode.TextDocument, position: vscode.Position, context: vscode.ReferenceContext, token: vscode.CancellationToken): vscode.ProviderResult<vscode.Location[]> {
        const ctx = this.parser.ctx(document.uri);
        if (!ctx) {
            return;
        }

        // Check for value references:
        const value = ctx.getPropertyAt(position, document.uri)?.valueAt(position, document.uri);
        if (value instanceof dts.ArrayValue) {
            const cell = value.cellAt(position, document.uri);
            if (cell instanceof dts.PHandle) {
                const node = ctx.node(cell.val);
                if (node) {
                    return ctx.getReferences(node).map(r => r.loc);
                }
            }
        }

        const entry = ctx.getEntryAt(position, document.uri);
        if (entry && entry.nameLoc.uri.toString() === document.uri.toString() && entry.nameLoc.range.contains(position)) {
            return ctx.getReferences(entry.node).map(r => r.loc);
        }
    }

    provideCodeActions(document: vscode.TextDocument, range: vscode.Range | vscode.Selection, context: vscode.CodeActionContext, token: vscode.CancellationToken): vscode.ProviderResult<vscode.CodeAction[]> {
        if (!this.diagSet) {
            return [];
        }

        return this.diagSet.getActions(document.uri, range).filter(action => !context.only || context.only === action.kind);
    }

    async loadCtxs() {
        const file = config.get('ctxFile') as string;
        if (!file) {
            return;
        }

        const text = await new Promise<string>(resolve => readFile(file, 'utf-8', (_, data) => resolve(data))) ?? '';
        const json: StoredCtx[] = JSON.parse(text) || [];
        const ctxNames = [...this.parser.contexts.map(ctx => ctx.name)];

        await Promise.all(json.map(ctx => {
            if (!ctxNames.includes(ctx.name)) {
                ctxNames.push(ctx.name); // don't load duplicates
                return this.parser.addContext(ctx.board ?? vscode.Uri.file(ctx.boardFile), ctx.overlays.map(o => vscode.Uri.file(o)), ctx.name);
            }
        }));
    }

    async saveCtxs(createFile=false) {
        await this.parser.stable();
        const file = getConfig('ctxFile') as string;

        vscode.commands.executeCommand('setContext', 'devicetree:dirtyConfig', true);

        let uri: vscode.Uri;
        if (file && existsSync(file)) {
            uri = vscode.Uri.file(file);
        } else if (createFile) {
            uri = (await vscode.window.showSaveDialog({ filters: { 'json': ['json'] }, defaultUri: vscode.workspace.workspaceFolders?.[0]?.uri }));
            if (!uri) {
                return;
            }

            config.update('ctxFile', uri.fsPath, vscode.ConfigurationTarget.Workspace);
        } else {
            return;
        }

        const json = this.parser.contexts.map(ctx => ({name: ctx.name, boardFile: ctx.boardFile.uri.fsPath, overlays: ctx.overlays.map(o => o.uri.fsPath), board: ctx.board}));
        writeFile(uri.fsPath, JSON.stringify(json, null, '\t'), err => {
            if (err) {
                vscode.window.showErrorMessage('Failed storing config: ' + err);
            } else {
                vscode.commands.executeCommand('setContext', 'devicetree:dirtyConfig', false);
            }

        });
    }

    async activate(ctx: vscode.ExtensionContext) {
        const timeStart = process.hrtime();
        const bindingDirs = getBindingDirs();
        await Promise.all(bindingDirs.map(d => this.types.addFolder(d)));
        const procTime = process.hrtime(timeStart);
        console.log(`Found ${Object.keys(this.types.types).length} bindings in ${bindingDirs.join(', ')}. ${(procTime[0] * 1e9 + procTime[1]) / 1000000} ms`);
        await this.loadCtxs();
        this.parser.activate(ctx);

        const selector = <vscode.DocumentFilter>{ language: 'dts', scheme: 'file' };
        let disposable = vscode.languages.registerDocumentSymbolProvider(selector, this);
        ctx.subscriptions.push(disposable);
        disposable = vscode.languages.registerWorkspaceSymbolProvider(this);
        ctx.subscriptions.push(disposable);
        disposable = vscode.languages.registerDefinitionProvider([selector, <vscode.DocumentFilter>{ language: 'yaml', scheme: 'file' }], this);
        ctx.subscriptions.push(disposable);
        disposable = vscode.languages.registerHoverProvider(selector, this);
        ctx.subscriptions.push(disposable);
        disposable = vscode.languages.registerCompletionItemProvider(selector, this, '&', '#', '<', '"', '\t');
        ctx.subscriptions.push(disposable);
        disposable = vscode.languages.registerSignatureHelpProvider(selector, this, '<', ' ');
        ctx.subscriptions.push(disposable);
        disposable = vscode.languages.registerDocumentRangeFormattingEditProvider(selector, this);
        ctx.subscriptions.push(disposable);
        disposable = vscode.languages.registerDocumentLinkProvider(selector, this);
        ctx.subscriptions.push(disposable);
        disposable = vscode.workspace.registerTextDocumentContentProvider('devicetree', new DTSDocumentProvider(this.parser));
        ctx.subscriptions.push(disposable);
        disposable = vscode.languages.registerCodeActionsProvider(selector, this);
        ctx.subscriptions.push(disposable);
        disposable = vscode.languages.registerReferenceProvider(selector, this);
        ctx.subscriptions.push(disposable);
        disposable = vscode.languages.registerTypeDefinitionProvider(selector, this);
        ctx.subscriptions.push(disposable);

        vscode.commands.registerCommand('devicetree.showOutput', (uri: dts.DTSCtx | vscode.Uri) => {
            if (uri instanceof dts.DTSCtx) {
                uri = uri.files.pop()?.uri;
            } else if (!uri && vscode.window.activeTextEditor?.document.languageId === 'dts') {
                uri = vscode.window.activeTextEditor?.document.uri;
            }

            if (uri) {
                vscode.window.showTextDocument(vscode.Uri.parse('devicetree://' + uri.path), { viewColumn: vscode.ViewColumn.Beside });
            }
        });

        vscode.commands.registerCommand('devicetree.newApp', async () => {
            const folder = await vscode.window.showOpenDialog({
                canSelectFiles: false,
                canSelectFolders: true,
                canSelectMany: false,
                openLabel: 'Select folder',
                defaultUri: vscode.window.activeTextEditor?.document?.uri ?? vscode.workspace.workspaceFolders?.[0].uri,
            }).then(uris => uris?.[0].fsPath, () => undefined);

            if (!folder) {
                return;
            }

            const board = await zephyr.selectBoard();
            if (!board) {
                return;
            }
            const file = path.join(folder, board.name + '.overlay');
            if (!existsSync(file)) {
                writeFileSync(file, '');
            }

            vscode.window.showTextDocument(vscode.Uri.file(file));
        });

        vscode.commands.registerCommand('devicetree.save', () => this.saveCtxs(true));

        vscode.commands.registerCommand('devicetree.ctx.addShield', () => {
            if (this.parser.currCtx && vscode.window.activeTextEditor?.document.languageId === 'dts') {
                const options = <vscode.OpenDialogOptions>{
                    canSelectFiles: true,
                    openLabel: 'Add shield file',
                    canSelectMany: true,
                    defaultUri: vscode.Uri.file(path.resolve(zephyr.zephyrRoot, 'boards', 'shields')),
                    filters: { 'DeviceTree': ['dts', 'dtsi', 'overlay'] },
                };
                vscode.window.showOpenDialog(options).then(uris => {
                    if (uris) {
                        this.parser.insertOverlays(...uris).then(() => {
                            this.saveCtxs();
                            if (uris.length === 1) {
                                vscode.window.showInformationMessage(`Added shield overlay ${path.basename(uris[0].fsPath)}.`);
                            } else {
                                vscode.window.showInformationMessage(`Added ${uris.length} shield overlays.`);
                            }
                        });
                    }
                });
            }
        });

        vscode.commands.registerCommand('devicetree.ctx.rename', (ctx?: dts.DTSCtx) => {
            ctx = ctx ?? this.parser.currCtx;
            if (!ctx) {
                return;
            }

            vscode.window.showInputBox({ prompt: 'New DeviceTree context name', value: ctx.name }).then(value => {
                if (value) {
                    ctx._name = value;
                    this.treeView.update();
                    this.saveCtxs();
                }
            });
        });

        vscode.commands.registerCommand('devicetree.ctx.delete', (ctx?: dts.DTSCtx) => {
            ctx = ctx ?? this.parser.currCtx;
            if (!ctx || !(ctx instanceof dts.DTSCtx)) {
                return;
            }

            const deleteCtx = () => {
                this.parser.removeCtx(ctx);
            };

            // Only prompt if this context actually took some effort
            if (ctx.overlays.length > 1 || ctx._name) {
                vscode.window.showWarningMessage(`Delete devicetree context "${ctx.name}"?`, {modal: true}, 'Delete').then(button => {
                    if (button === 'Delete') {
                        deleteCtx();
                    }
                });
            } else {
                deleteCtx();
            }
        });

        vscode.commands.registerCommand('devicetree.ctx.setBoard', (file?: dts.DTSFile) => {
            const ctx = file?.ctx ?? this.parser.currCtx;
            if (!ctx) {
                return;
            }

            zephyr.selectBoard().then(board => {
                if (board) {
                    this.parser.setBoard(board, ctx).then(() => {
                        this.saveCtxs();
                    });
                }
            });
        });

        vscode.commands.registerCommand('devicetree.getMacro', () => {
            const ctx = this.parser.currCtx;
            const selection = vscode.window.activeTextEditor?.selection;
            const uri = vscode.window.activeTextEditor?.document.uri;
            if (!ctx || !selection || !uri) {
                return;
            }

            const toMacro = (text: string) => text.replace(/[-@]/g, '_').replace(/\/|^#/g, '').toLowerCase();

            const nodeMacro = (node: dts.Node) => {
                const labels = node.labels();
                if (labels.length) {
                    return `DT_NODELABEL(${toMacro(labels[0])})`;
                }

                if (node.parent) {
                    const parent = nodeMacro(node.parent);

                    // better to do DT_PATH(a, b, c) than DT_CHILD(DT_CHILD(a, b), c)
                    if (!parent.startsWith('DT_NODELABEL(')) {
                        return `DT_PATH(${toMacro(node.path.slice(1, node.path.length - 1).replace(/\//g, ', '))})`;
                    }

                    return `DT_CHILD(${parent}, ${toMacro(node.fullName)})`;
                }

                return `DT_N`;
            };

            const propMacro = (prop: dts.Property) => {
                // Selecting the property name
                if (prop.loc.range.contains(selection)) {
                    if (prop.name === 'label') {
                        return `DT_LABEL(${nodeMacro(prop.entry.node)})`;
                    }

                    // Not generated for properties like #gpio-cells
                    if (prop.name.startsWith('#')) {
                        return;
                    }

                    return `DT_PROP(${nodeMacro(prop.entry.node)}, ${toMacro(prop.name)})`;
                }

                // Selecting a phandle:
                const val = prop.valueAt(selection.start, uri);
                if (val instanceof dts.ArrayValue) {
                    const cell = val.cellAt(selection.start, uri);
                    if (cell instanceof dts.PHandle) {
                        const node = ctx.node(cell.val);
                        if (node) {
                            return nodeMacro(node);
                        }
                    } else if (prop.name === 'reg') {
                        const valIdx = prop.value.indexOf(val);
                        const cellIdx = val.val.indexOf(cell);
                        const names = prop.cellNames(ctx);
                        if (names?.length) {
                            const name = names?.[valIdx % names.length]?.[cellIdx];
                            if (name) {
                                if (prop.regs?.length === 1) {
                                    // Name is either size or addr
                                    return `DT_REG_${name.toUpperCase()}(${nodeMacro(prop.entry.node)})`;
                                } else {
                                    // Name is either size or addr
                                    return `DT_REG_${name.toUpperCase()}_BY_IDX(${nodeMacro(prop.entry.node)}, ${valIdx})`;
                                }
                            }
                        }
                    } else if (val.isNumberArray()) {
                        const cellIdx = val.val.indexOf(cell);
                        return `DT_PROP_BY_IDX(${nodeMacro(prop.entry.node)}, ${prop.name}, ${cellIdx})`;
                    } else {
                        const names = prop.cellNames(ctx);
                        if (names?.length) {
                            const idx = val.val.indexOf(cell);
                            if (idx >= 0) {
                                return `DT_PROP(${nodeMacro(prop.entry.node)}, ${toMacro(prop.name)})`;
                            }
                        }
                    }
                }
            };

            let macro: string;
            const prop = ctx.getPropertyAt(selection.start, uri);
            if (prop) {
                macro = propMacro(prop);
            } else {
                const entry = ctx.getEntryAt(selection.start, uri);
                if (entry?.nameLoc.range.contains(selection.start)) {
                    macro = nodeMacro(entry.node);
                }
            }

            if (macro) {
                vscode.env.clipboard.writeText(macro).then(() => vscode.window.setStatusBarMessage(`Copied "${macro}" to clipboard`, 3000));
            }
        });

        vscode.commands.registerCommand('devicetree.edit', async () => {
            const ctx = this.parser.currCtx;
            const selection = vscode.window.activeTextEditor?.selection;
            const uri = vscode.window.activeTextEditor?.document.uri;
            if (!ctx || !selection || !uri) {
                return;
            }

            if (!ctx.overlays.length) {
                vscode.window.showErrorMessage('No overlayfile');
                return;
            }

            const overlay = [...ctx.overlays].pop();
            const doc = await vscode.workspace.openTextDocument(overlay.uri);

            if (uri.toString() === doc.uri.toString()) {
                return; // already in this file
            }

            const editNode = (node: dts.Node, insertText='') => {
                const edit = new vscode.WorkspaceEdit();

                let text = insertText;
                let it = node;
                let lineOffset = 0;
                let charOffset = insertText.length;
                while (it) {
                    const shortName = (it.labels().length && it.refName) || (!it.parent && '/');
                    text = (shortName || it.fullName) + ' {\n\t' + text.split('\n').join('\n\t') + '\n};';
                    lineOffset += 1;
                    charOffset += 1;

                    if (shortName) {
                        break;
                    }

                    it = it.parent;
                }
                const insert = new vscode.Position(doc.lineCount, 0);

                edit.insert(doc.uri, insert, '\n' + text + '\n');

                vscode.workspace.applyEdit(edit);
                vscode.window.showTextDocument(doc).then(e => {
                    e.revealRange(new vscode.Range(insert, insert), vscode.TextEditorRevealType.Default);
                    const cursor = new vscode.Position(insert.line + lineOffset, charOffset);
                    e.selection = new vscode.Selection(cursor, cursor);
                });
            };

            const prop = ctx.getPropertyAt(selection.start, uri);
            if (prop) {
                editNode(prop.entry.node, prop.name + ' = ');
            } else {
                const entry = ctx.getEntryAt(selection.start, uri);
                if (entry?.nameLoc.range.contains(selection.start)) {
                    editNode(entry.node);
                }
            }
        });

        vscode.commands.registerCommand('devicetree.goto', async (p: string, uri?: vscode.Uri) => {
            const ctx = uri ? this.parser.ctx(uri) : this.parser.currCtx;

            let loc: vscode.Location;
            if (p.endsWith('/')) {
                loc = ctx?.node(p)?.entries[0]?.nameLoc;
            } else {
                loc = ctx?.node(path.dirname(p))?.property(path.basename(p))?.loc;
            }

            if (loc) {
                const doc = await vscode.workspace.openTextDocument(loc.uri);
                const editor = await vscode.window.showTextDocument(doc);
                editor.revealRange(loc.range);
                editor.selection = new vscode.Selection(loc.range.start, loc.range.start);
            }
        });
    }

    private setDiags(diags: DiagnosticsSet) {
        this.prevDiagUris.filter(uri => !diags.all.find(set => uri.toString() === set.uri.toString())).forEach(uri => this.diags.set(uri, []));
        diags.all.forEach(d => this.diags.set(d.uri, d.diags));
        this.prevDiagUris = diags.all.map(set => set.uri);
        this.diagSet = diags;
    }

    addMissing(entry: dts.NodeEntry, propType: types.PropertyType) {
        if (!vscode.window.activeTextEditor || vscode.window.activeTextEditor.document.uri.fsPath !== entry.loc.uri.fsPath) {
            return;
        }
        const indent = vscode.window.activeTextEditor.options.insertSpaces ? ' '.repeat(vscode.window.activeTextEditor.options.tabSize as number) : '\t';
        const line = entry.loc.range.end.line;
        const snippet = new vscode.SnippetString(`\n${indent}${propType.name} = `);
        appendPropSnippet(propType, snippet, entry.node);
        vscode.window.activeTextEditor.insertSnippet(snippet, new vscode.Position(line - 1, 99999999));
    }

    provideDocumentSymbols(document: vscode.TextDocument, token: vscode.CancellationToken): vscode.ProviderResult<vscode.SymbolInformation[]> {
        const propSymbolKind = (p: dts.Property) => {
            if (p.name.startsWith('#')) {
                return vscode.SymbolKind.Number;
            }

            if (p.name === 'compatible') {
                return vscode.SymbolKind.TypeParameter;
            }
            if (p.name === 'status') {
                return vscode.SymbolKind.Event;
            }
            if (p.stringArray) {
                return vscode.SymbolKind.String;
            }
            if (p.bytestring) {
                return vscode.SymbolKind.Array;
            }
            if (p.pHandles) {
                return vscode.SymbolKind.Variable;
            }

            return vscode.SymbolKind.Property;
        };

        const symbols: vscode.SymbolInformation[] = [];

        const addSymbol = (e: dts.NodeEntry) => {
            if (e.loc.uri.toString() !== document.uri.toString()) {
                return;
            }

            const node = new vscode.SymbolInformation(e.node.fullName || '/', vscode.SymbolKind.Class, e.parent?.node?.fullName, e.loc);
            symbols.push(node);
            symbols.push(...e.properties.map(p => new vscode.SymbolInformation(p.name, propSymbolKind(p), e.node.fullName, p.loc)));
            e.children.forEach(addSymbol);
        };

        this.parser.ctx(document.uri)?.roots.forEach(addSymbol);
        return symbols;
    }

    provideWorkspaceSymbols(query: string, token: vscode.CancellationToken): vscode.ProviderResult<vscode.SymbolInformation[]> {
        const ctx = this.parser.currCtx;
        if (!ctx) {
            return [];
        }

        return ctx.nodeArray()
            .filter(n => n.entries.length > 0 )
            .map(n => new vscode.SymbolInformation(n.fullName || '/', vscode.SymbolKind.Class, n.parent?.path ?? '', n.entries[0].nameLoc));
    }

    getNodeDefinition(ctx: dts.DTSCtx, document: vscode.TextDocument, position: vscode.Position): [vscode.Range, dts.Node] {
        let word = document.getWordRangeAtPosition(position, /&[\w-]+/);
        if (word) {
            const symbol = document.getText(word);
            if (symbol.startsWith('&')) { // label
                const node = ctx.node(symbol);
                if (node) {
                    return [word, node];
                }
            }
        }

        word = document.getWordRangeAtPosition(position, /"[\w,/@-]+"/);
        if (word) {
            let symbol = document.getText(word);

            if (symbol) {
                symbol = symbol.slice(1, symbol.length - 1);
                const prop = ctx.getPropertyAt(position, document.uri);
                if (!prop) {
                    return;
                }

                if (prop.entry.node.name === 'aliases' || prop.entry.node.name === 'chosen') { // the string should be a path
                    const node = ctx.node(symbol);
                    if (!node) {
                        return;
                    }

                    return [word, node];
                }
            }
        }
    }

    provideTypeDefinition(document: vscode.TextDocument, position: vscode.Position, token: vscode.CancellationToken): vscode.ProviderResult<vscode.Location | vscode.Location[] | vscode.LocationLink[]> {
        const file = this.parser.file(document.uri);
        if (!file) {
            return;
        }

        let [, node] = this.getNodeDefinition(file.ctx, document, position) ?? [undefined, undefined];
        if (!node) {
            const entry = file.getEntryAt(position, document.uri);
            if (entry?.nameLoc.range.contains(position)) {
                node = entry.node;
            }
        }

        if (node?.type?.filename) {
            return new vscode.Location(vscode.Uri.file(node.type.filename), new vscode.Range(0, 0, 0, 0));
        }
    }

    provideHover(document: vscode.TextDocument, position: vscode.Position, token: vscode.CancellationToken): vscode.ProviderResult<vscode.Hover> {
        const file = this.parser.file(document.uri);
        if (!file) {
            return;
        }

        const line = file.lines.find(l => l.uri.fsPath === document.uri.fsPath && l.number === position.line);
        if (line) {
            const m = line.macros.find(m => position.character >= m.start && position.character < m.start + m.raw.length);
            if (m) {
                const singleLineVal = `#define ${m.raw} ${m.insert}`;
                if (singleLineVal.length > 80) { // Spread across two lines:
                    let value = `#define ${m.raw}`;
                    value += ' '.repeat(80 - value.length);
                    value += `\\\n\t${m.insert}`;
                    return new vscode.Hover({ language: 'dts', value });

                }

                return new vscode.Hover({language: 'dts', value: `#define ${m.raw} ${m.insert}`});
            }
        }

        // hover reference
        const bundle = this.getNodeDefinition(file.ctx, document, position);
        if (bundle) {
            const node = bundle[1];

            const entries = [new vscode.MarkdownString('`' + node.path + '`')];

            if (node.type.valid) {
                entries.push(new vscode.MarkdownString().appendText(node.type.description));
            }

            entries.push(new vscode.MarkdownString().appendCodeblock(node.toString(), 'dts'));

            return new vscode.Hover(entries, bundle[0]);
        }

        // hover property name
        const word = document.getWordRangeAtPosition(position);
        if (!word) {
            return;
        }

        const symbol = document.getText(word);
        const entry = file.getEntryAt(position, document.uri);
        if (!entry) {
            return;
        }

        const node = entry.node;
        const type = node.type ?? this.types.baseType;
        const prop = entry.properties.find(p => p.fullLoc.uri.toString() === document.uri.toString() && p.fullLoc.range.contains(position));
        const value = prop?.valueAt(position, document.uri);
        if (value) {
            if (value instanceof dts.ArrayValue) {
                const cell = value.cellAt(position, document.uri);
                if (cell && file.ctx) {
                    const names = prop.cellNames(file.ctx);
                    const entry = names?.[prop.value.indexOf(value) % (names?.length || 1)];
                    const name = entry?.[value.val.indexOf(cell) % (entry?.length || 1)] as string;
                    if (name) {
                        return new vscode.Hover(name, cell.loc.range);
                    }
                }
            }
        }

        const propType = type.property(symbol);
        if (propType) {
            const results: vscode.MarkdownString[] = [];
            if (propType.description) {
                results.push(new vscode.MarkdownString(propType.description));
            }
            results.push(new vscode.MarkdownString('type: `' + (Array.isArray(propType.type) ? propType.type.join('`, `') : propType.type) + '`'));

            if (propType.name.endsWith('-map') && propType.name !== 'interrupt-map') {
                const p = file.getPropertyAt(position, document.uri);
                const nexusMap = p?.nexusMap;
                if (nexusMap) {
                    const identifier = propType.name.slice(0, propType.name.length - 4);
                    const nexusText = new vscode.MarkdownString(`Nexus map for \`${identifier}s\` properties.\n\n`);
                    nexusText.appendMarkdown(`Nexus nodes' \`-map\` properties are translation tables from one domain to another.\n\n`);
                    nexusText.appendMarkdown(`Each entry in the nexus map defines one translation from \`${identifier}\` references to this node to the mapped node.`);
                    if (nexusMap.length) {
                        nexusText.appendMarkdown(`\n\nFor instance, because of the first entry in this map,`);
                        nexusText.appendCodeblock(`${identifier}s = < ${p.entry.node.refName} ${nexusMap[0].in.map(i => i.toString(true)).join(' ')} >;`, 'dts');
                        nexusText.appendMarkdown(`is equivalent to`);
                        nexusText.appendCodeblock(`${identifier}s = < ${nexusMap[0].target.toString(true)} ${nexusMap[0].out.map(i => i.toString(true)).join(' ')} >;`, 'dts');
                    }
                    results.push(nexusText);
                }
            }
            return new vscode.Hover(results, word);
        }

        if (entry.nameLoc.range.contains(position)) {
            const results: vscode.MarkdownString[] = [];
            if (type.compatible) {
                results.push(new vscode.MarkdownString(type.compatible));
            }
            if (type.description) {
                results.push(new vscode.MarkdownString(type.description));
            }

            results.push(new vscode.MarkdownString('`' + node.path + '`'));

            // Show pin assignments:
            if (node.pins?.length && node.type.cells('gpio')?.length > 0) {
                const pins = new vscode.MarkdownString('Pin assigments:\n\n');
                pins.appendMarkdown('| Pin | Node | Property |\n');
                pins.appendMarkdown('|-----|------|----------|\n');
                pins.appendMarkdown(node.pins.map((pin, i) => {
                    if (!pin) {
                        return `| ${i} | NC | - |\n`;
                    }

                    return `| ${i} | \`${pin.prop.entry.node.uniqueName}\` | ${pin.prop.name} |\n`;
                }).join(''));
                results.push(pins);
            }
            results.push(new vscode.MarkdownString().appendCodeblock(node.toString(), 'dts'));

            return new vscode.Hover(results, word);
        }
    }

    provideDefinition(document: vscode.TextDocument, position: vscode.Position, token: vscode.CancellationToken): vscode.ProviderResult<vscode.Definition> {
        const file = this.parser.file(document.uri);
        if (!file) {
            return;
        }

        if (document.languageId === 'yaml') {
            const range = document.getWordRangeAtPosition(position, /[\w.,-]+\.ya?ml/);
            const text = document.getText(range);
            if (text) {
                return Object.values(this.types.types).find(t => t.find(tt => tt.filename.match(new RegExp('.*/' + text)))).map(t => new vscode.Location(vscode.Uri.file(t.filename), new vscode.Position(0, 0)));
            }
            return [];
        }

        const line = file.lines.find(l => l.uri.fsPath === document.uri.fsPath && l.number === position.line);
        if (line) {
            const m = line.macros.find(m => position.character >= m.start && position.character < m.start + m.raw.length);
            if (m) {
                return m.macro.definition?.location ?? [];
            }
        }

        const bundle = this.getNodeDefinition(file.ctx, document, position);
        if (bundle) {
            return bundle[1].entries
                .filter(e => !e.loc.range.contains(position))
                .map(e => new vscode.Location(e.loc.uri, e.loc.range));
        }

        const entry = file.getEntryAt(position, document.uri);
        if (!entry) {
            return;
        }

        if (entry.nameLoc.uri.toString() === document.uri.toString() && entry.nameLoc.range.contains(position)) {
            return entry.node.entries.map(e => e.nameLoc);
        }

        const prop = entry.getPropertyAt(position, document.uri);
        if (prop) {
            if (prop.loc.range.contains(position) && prop.loc.uri.toString() === document.uri.toString()) {
                return prop.entry.node.uniqueProperties().find(p => p.name === prop.name)?.loc;
            }

            const type = prop.valueAt(position, document.uri);
            if (prop.name === 'compatible' && type instanceof dts.StringValue) {
                const filename = this.types.get(type.val)?.[0]?.filename;
                if (filename) {
                    return new vscode.Location(vscode.Uri.file(filename), new vscode.Position(0, 0));
                }
            }

            if (type instanceof dts.ArrayValue) {
                const cell = type.cellAt(position, document.uri);
                if (cell instanceof dts.PHandle) {
                    return file.ctx.node(cell.val)?.entries[0]?.nameLoc;
                }
            }
        }
    }

    resolveCompletionItem?(item: vscode.CompletionItem, token: vscode.CancellationToken): vscode.ProviderResult<vscode.CompletionItem> {
        const n = item['dts-node-type'] as types.NodeType;
        if (n) {
            const isAbsolutePath = n.name?.startsWith('/');
            const parent = item['dts-parent'] as dts.Node;
            const snippet = new vscode.SnippetString();
            if (isAbsolutePath) {
                snippet.appendText(item.label);
            } else {
                snippet.appendPlaceholder(item.label);
            }

            const addrCells = parent?.addrCells() ?? 2;
            const sizeCells = parent?.sizeCells() ?? 1;
            const insertAddr = (addrCells === 1 && !isAbsolutePath);
            if (insertAddr) {
                snippet.appendText('@');
                snippet.appendPlaceholder('0');
            }

            snippet.appendText(` {\n`);

            if (!isAbsolutePath && n.name) { // nodes with no name are child nodes, and don't need compatible properties
                snippet.appendText(`\tcompatible = "${n.name}";\n`);
            }

            const insertValueSnippet = (p: types.PropertyType, insert?: any) => {
                let surroundingBraces = [];
                let defaultVal: string;
                if (p.type === 'string') {
                    surroundingBraces = ['"', '"'];
                } else if (p.type === 'bytearray') {
                    surroundingBraces = ['[ ', ' ]'];
                } else if (!Array.isArray(p.type)) {
                    surroundingBraces = ['< ', ' >'];
                    if (p.type === 'int') {
                        defaultVal = '0';
                    } else if (p.type === 'phandle') {
                        defaultVal = '&ref';
                    }
                } else {
                    snippet.appendTabstop();
                    return;
                }

                snippet.appendText(surroundingBraces[0]);
                if (insert !== undefined) {
                    snippet.appendPlaceholder(insert.toString());
                } else if (defaultVal) {
                    snippet.appendPlaceholder(defaultVal);
                } else if (p.const !== undefined) {
                    snippet.appendText(insert.toString());
                } else {
                    snippet.appendTabstop();
                }
                snippet.appendText(surroundingBraces[1]);
            };

            const requiredProps = n.properties.filter(p => p.required && p.name !== 'compatible') ?? [];
            if (requiredProps.length > 0) {

                const defaultGpioController = this.parser.currCtx?.nodeArray().find(node => node.property('gpio-controller'));

                requiredProps.forEach(p => {
                    snippet.appendText(`\t${p.name}`);
                    if (p.type === 'boolean') {
                        /* No value */
                    } else {
                        snippet.appendText(' = ');
                        if (p.name === 'reg') {
                            snippet.appendText('< ');
                            if (insertAddr) {
                                snippet.appendText('0x');
                                snippet.appendTabstop(2);
                                snippet.appendText(' ');
                            } else {
                                let addrs = addrCells;
                                while (addrs-- > 0) {
                                    snippet.appendPlaceholder('addr');
                                    snippet.appendText(' ');
                                }
                            }

                            let size = sizeCells;
                            while (size-- > 0) {
                                snippet.appendPlaceholder('size');
                                snippet.appendText(' ');
                            }

                            snippet.appendText('>');
                        } else if (p.name === 'label') {
                            insertValueSnippet(p, item.label.toUpperCase());
                        } else if (p.type === 'phandle-array' && p.name.endsWith('-gpios') && defaultGpioController) {
                            snippet.appendText('< ');
                            snippet.appendPlaceholder(`&${defaultGpioController.labels()[0] ?? '"' + defaultGpioController.path + '"'}`);
                            const cells = defaultGpioController.type?.cells(dts.cellName(p.name)) as string[];
                            if (cells) {
                                cells.forEach(c => {
                                    snippet.appendText(' ');
                                    snippet.appendPlaceholder(c);
                                });
                            } else {
                                snippet.appendText(' ');
                                snippet.appendPlaceholder('cells');
                            }

                            snippet.appendText(' >');
                        } else {
                            insertValueSnippet(p, p.const ?? p.default ?? p.enum);
                        }
                    }

                    snippet.appendText(';\n');
                });
            } else {
                snippet.appendText('\t');
                snippet.appendTabstop();
                snippet.appendText('\n');
            }
            snippet.appendText('};');

            item.detail = n.name;
            item.insertText = snippet;
            item.documentation = n.description ?? '';
        }
        return item;
    }

    async provideCompletionItems(document: vscode.TextDocument, position: vscode.Position, token: vscode.CancellationToken, context: vscode.CompletionContext): Promise<vscode.CompletionItem[] | vscode.CompletionList> {
        await this.parser.stable();
        const file = this.parser.file(document.uri);
        if (!file) {
            return;
        }
        const entry = file.ctx.getEntryAt(position, document.uri);
        const node = entry?.node;

        const lineRange = new vscode.Range(position.line, 0, position.line, 999999);
        const line = document.getText(lineRange);
        const before = line.slice(0, position.character);

        const labelItems = (asNode: boolean) => {
            const labels: {label: string, node: dts.Node, type?: types.NodeType}[] = [];
            file.ctx.nodeArray().forEach(node => {
                const type = this.types.nodeType(node);
                labels.push(...node.labels().map(label => { return { label, node, type }; }));
            });

            const withAmp = !before || before.match(/^&[\w-]+$/);

            return labels.map(l => {
                const completion = new vscode.CompletionItem(`&${l.label}`, vscode.CompletionItemKind.Class);
                if (asNode) {
                    completion.insertText = new vscode.SnippetString((withAmp ? completion.label : l.label) + ' {\n\t');
                    completion.insertText.appendTabstop();
                    completion.insertText.appendText('\n};\n');
                } else if (!withAmp) {
                    completion.insertText = l.label;
                }

                completion.detail = l.node.path;
                if (l.type) {
                    completion.documentation = new vscode.MarkdownString();
                    if (l.type.compatible) {
                        completion.documentation.appendMarkdown(`**${l.type.compatible}**\n\n`);
                    }
                    if (l.type.valid) {
                        completion.documentation.appendText(`\n\n${l.type.description}`);
                        completion.documentation.appendMarkdown(`\n\n\`${l.type.name}\``);
                    }
                }
                return completion;
            });
        };

        const deleteLine = line.slice(0, position.character).match(/\/delete-(node|property)\/\s+[^\s;]*$/);
        if (deleteLine) {
            if (deleteLine[1] === 'node') {
                if (node) {
                    return [...node.children().map(n => new vscode.CompletionItem(n.fullName, vscode.CompletionItemKind.Class)), ...labelItems(false)];
                } else {
                    return labelItems(false);
                }
            } else if (node) {
                return node.uniqueProperties().map(p => new vscode.CompletionItem(p.name, vscode.CompletionItemKind.Property));
            }
        }

        const macros = this.parser.ctx(document.uri)?.macros.map(m => {
            const item = new vscode.CompletionItem(m.name);
            if (m.args) {
                item.kind = vscode.CompletionItemKind.Function;
                item.insertText = new vscode.SnippetString(m.name + '(');
                m.args.forEach((a, i) => {
                    (<vscode.SnippetString>item.insertText).appendPlaceholder(a);
                    if (i < m.args.length - 1) {
                        (<vscode.SnippetString>item.insertText).appendText(', ');
                    }
                });
                item.insertText.appendText(')');
                item.detail = 'Macro';
            } else {
                item.kind = vscode.CompletionItemKind.Constant;
                item.detail = 'Define';
            }

            if (item.label.startsWith('_')) { // Reserved macros go last
                item.sortText = `~~~~${item.label}`;
            } else {
                item.sortText = `~~~${item.label}`;
            }

            return item;
        }) ?? [];

        if (!node) {
            if (before.match(/&[\w-]*$/)) {
                return labelItems(true);
            }

            const root = new vscode.CompletionItem('/', vscode.CompletionItemKind.Class);
            root.insertText = new vscode.SnippetString('/ {\n\t');
            root.insertText.appendTabstop();
            root.insertText.appendText('\n};\n');
            root.detail = 'root node';
            root.documentation = 'The devicetree has a single root node of which all other device nodes are descendants. The full path to the root node is /.';
            root.preselect = true;

            return [root, ...labelItems(true), ...macros];
        }

        const propValueTemplate = (value: string, propType: string | string[]) => {
            if (Array.isArray(propType)) {
                propType = propType[0];
            }
            switch (propType) {
                case "string":
                case "string-array":
                    return ` "${value}"`;
                case "uint8-array":
                    return ` [${value}]`;
                default:
                    return ` <${value}>`;
            }
        };

        const prop = file.getPropertyAt(position, document.uri);
        if (prop) {
            if (before.includes('=')) {
                const after = line.slice(position.character);
                const surroundingBraces = [['<', '>'], ['"', '"'], ['[', ']']];
                const braces = surroundingBraces.find(b => before.includes(b[0], before.indexOf('=')) && after.includes(b[1]));
                let start: number, end: number;
                if (braces) {
                    start = line.slice(0, position.character).lastIndexOf(braces[0]) + 1;
                    end = line.indexOf(braces[1], position.character);
                } else {
                    start = line.indexOf('=') + 1;
                    end = position.character + (after.indexOf(';') >= 0 ? after.indexOf(';') : after.length);
                }

                const range = new vscode.Range(position.line, start, position.line, end);
                const propType = (node.type?.property(prop.name));
                if (propType) {
                    if (propType.enum) {
                        const filterText = document.getText(document.getWordRangeAtPosition(position));
                        return propType.enum.map(e => {
                            const completion = new vscode.CompletionItem(e, vscode.CompletionItemKind.EnumMember);
                            completion.range = range;
                            completion.filterText = filterText;
                            if (!braces) {
                                completion.insertText = propValueTemplate(e, propType.type);
                            }
                            return completion;
                        });
                    }

                    if (propType.const) {
                        const completion = new vscode.CompletionItem(propType.const.toString(), vscode.CompletionItemKind.Constant);
                        completion.range = range;
                        if (!braces) {
                            completion.insertText = propValueTemplate(propType.const.toString(), propType.type);
                        }
                    }
                }

                const ref = before.match(/&([\w-]*)$/);
                if (ref) {
                    return labelItems(false);
                }

                if (prop.name === 'compatible') {
                    return Object.keys(this.types.types).filter(t => !t.startsWith('/')).map(typename => this.types.types[typename].map(type => {
                            const completion = new vscode.CompletionItem(typename, vscode.CompletionItemKind.EnumMember);
                            completion.range = range;
                            if (!braces) {
                                completion.insertText = propValueTemplate(typename, 'string');
                            }

                            completion.detail = type.compatible;
                            completion.documentation = type.description ?? '';
                            return completion;
                        })
                    ).reduce((all, types) => {
                        all.push(...types);
                        return all;
                    }, []);
                }
            }
        }

        if (before.match(/&[\w-]*$/)) {
            return labelItems(true);
        }

        const nodeProps = node.properties();

        let typeProps = node.type?.properties ?? [];
        if (!document.getWordRangeAtPosition(position)) {
            typeProps = typeProps.filter(p => (p.name !== '#size-cells') && (p.name !== '#address-cells') && p.isLoaded);
        }

        const propCompletions = typeProps
            .map(p => {
                const completion = new vscode.CompletionItem(p.name, vscode.CompletionItemKind.Property);
                completion.detail = Array.isArray(p.type) ? p.type[0] : p.type;
                if (p.name === 'compatible') {
                    completion.kind = vscode.CompletionItemKind.TypeParameter;
                }

                const nodeProp = nodeProps.find(prop => prop.name === p.name);
                if (nodeProp) {
                    const md = new vscode.MarkdownString();
                    md.appendText(p.description ?? '');
                    md.appendMarkdown(`\n\n*Already defined as:*`);
                    md.appendCodeblock(nodeProp.toString(), 'dts');
                    completion.documentation = md;
                    // Not quite at the top:
                    completion.sortText = '!!!' + completion.label;
                } else {
                    // Put the unused properties at the top:
                    completion.sortText = '!!!!' + completion.label;
                    completion.documentation = p.description ?? '';
                }

                completion.insertText = new vscode.SnippetString();
                appendPropSnippet(p, completion.insertText, node);
                return completion;
            });

        let nodes: types.NodeType[] = Object.values(this.types.types)
            .filter(n => n[0].name !== '/')
            .reduce((all, n) => [...all, ...n], [])
            .filter(n => n.valid && n.name && (!n.name.startsWith('/') || n.name.startsWith(node.name)));

        // Do some pretty conservative filtering, not the end of the world if the user's node doesn't show up
        if (node.type?.bus) {
            nodes = nodes.filter(n => n.onBus === node.type.bus);
        } else if (node.type?.child) {
            nodes = [node.type.child];
        } else if (node.name === 'cpus') {
            nodes = nodes.filter(n => n.includes('cpu'));
        } else if (node.name === 'soc') {
            // Stuff on the soc node are peripherals, should be made by the chip vendor
            const vendor = node.parent.property('compatible')?.string?.match(/(.*?),/)?.[1];
            nodes = nodes.filter(n => !n.onBus && !n.includes('cpu') && (!vendor || n.name.startsWith(vendor + ',')));
        } else if (node.path === '/') {
            nodes = nodes.filter(n => n.name.startsWith('/'));
        } else {
            nodes = [];
        }

        const nodeCompletions = nodes.map(n => {
            let name: string;
            // Find a reasonable name
            const parts = n.name?.split(',');
            if (!n.name) {
                name = 'node';
            } else if (n.name.match(/^\/[\w-,]+\/$/)) {
                // absolute paths, e.g. /chosen/ should be stripped of their slashes
                name = n.name.replace(/\//g, '');
            } else if (parts.length > 1) {
                // If the node is named something like "bosch,bme280", use "bme280":
                name = parts.pop();
            } else if (n.filename) {
                name = path.basename(n.filename, '.yaml');
            } else {
                return null;
            }

            const completion = new vscode.CompletionItem(name, vscode.CompletionItemKind.Class);
            completion.detail = n.name;
            completion.documentation = n.description;
            completion['dts-node-type'] = n;
            completion['dts-parent'] = node;
            return completion;
        }).filter(n => n);

        const childCompletions = node.children().filter(n => !entry.children.find(child => child.node === n)).map(n => {
            const item = new vscode.CompletionItem(n.fullName, vscode.CompletionItemKind.Module);
            item.insertText = new vscode.SnippetString(n.fullName + ' {\n\t');
            item.insertText.appendTabstop();
            item.insertText.appendText('\n};');
            item.detail = n.type?.name;
            item.documentation = n.type?.description;
            return item;
        });


        // commands (/command/):
        const commandStart = line.search(/\/(?:$|\w)/);
        let commandRange: vscode.Range = undefined;
        if (commandStart >= 0) {
            commandRange = new vscode.Range(new vscode.Position(position.line, commandStart), new vscode.Position(position.line, position.character-1));
        }

        const deleteNode = new vscode.CompletionItem('/delete-node/', vscode.CompletionItemKind.Function);
        deleteNode.range = commandRange;
        deleteNode.sortText = `~~${deleteNode.label}`;

        const deleteProp = new vscode.CompletionItem('/delete-property/', vscode.CompletionItemKind.Function);
        deleteProp.range = commandRange;
        deleteProp.sortText = `~~${deleteProp.label}`;

        return [
            ...propCompletions,
            deleteNode,
            deleteProp,
            ...childCompletions,
            ...nodeCompletions,
            ...macros,
        ];
    }

    provideSignatureHelp(document: vscode.TextDocument, position: vscode.Position, token: vscode.CancellationToken, context: vscode.SignatureHelpContext): vscode.ProviderResult<vscode.SignatureHelp> {
        const ctx = this.parser.ctx(document.uri);
        if (!ctx) {
            return;
        }

        const prop = ctx.getPropertyAt(position, document.uri);
        if (!prop) {
            return;
        }

        const node = prop.entry.node;
        if (!node.type) {
            return;
        }

        const propType = node.type.property(prop.name);
        if (propType?.type === 'int' && propType.description) {
            const info = new vscode.SignatureInformation(`${node.path}${prop.name}`, propType.description);
            info.parameters = [new vscode.ParameterInformation(`number`)];
            const help = new vscode.SignatureHelp();
            help.activeParameter = 0;
            help.activeSignature = 0;
            help.signatures = [info];
            return help;
        }

        const actualType = prop.type();
        if (!['phandle-array', 'array', 'phandle', 'phandles'].includes(actualType)) {
            return;
        }

        const value = prop.value;
        if (!value?.length) {
            return;
        }

        const entryIdx = value.findIndex(v => v.loc.range.contains(position));
        if (entryIdx === -1 || !(value[entryIdx] instanceof dts.ArrayValue) || !value[entryIdx]?.val?.length) {
            return;
        }


        const names = prop.cellNames(ctx);
        if ((names?.length ?? 0) < entryIdx) {
            return;
        }

        const cells = names[entryIdx];
        const paramIndex = (value[entryIdx].val.findIndex(v => v.loc.range.contains(position)) ?? (value[entryIdx].val.length - 1)) % cells.length;

        let signature = prop.name + ` = < `;
        const params = cells.map(name => {
            const start = signature.length;
            signature += name + ' ';
            return new vscode.ParameterInformation([start, start + name.length]);
        });

        signature += '>;';

        const info = new vscode.SignatureInformation(signature, propType?.description);
        info.parameters = params;

        return <vscode.SignatureHelp>{activeParameter: paramIndex, activeSignature: 0, signatures: [info]};
    }

    provideDocumentRangeFormattingEdits(document: vscode.TextDocument, r: vscode.Range, options: vscode.FormattingOptions, token: vscode.CancellationToken): vscode.ProviderResult<vscode.TextEdit[]> {
        let text = document.getText();
        let start = document.offsetAt(r.start);
        let end = document.offsetAt(r.end);
        start = text.slice(0, start).lastIndexOf(';') + 1;
        end += text.slice(end-1).indexOf(';') + 1;
        if (end < start) {
            end = text.length - 1;
        }

        const eol = document.eol == vscode.EndOfLine.CRLF ? '\r\n' : '\n';

        const range = new vscode.Range(document.positionAt(start), document.positionAt(end));
        text = document.getText(range);
        const firstLine = document.getText(new vscode.Range(range.start.line, 0, range.start.line, 99999));
        let indent = firstLine.match(/^\s*/)[0];

        text = text.replace(/([\w,-]+)\s*:[\t ]*/g, '$1: ');
        text = text.replace(/(&[\w,-]+)\s*{[\t ]*/g, '$1 {');
        text = text.replace(/([\w,-]+)@0*([\da-fA-F]+)\s*{[\t ]*/g, '$1@$2 {');
        text = text.replace(/(\w+)\s*=\s*(".*?"|<.*?>|\[.*?\])\s*;/g, '$1 = $2;');
        text = text.replace(/<\s*(.*?)\s*>/g, '< $1 >');
        text = text.replace(/([;{])[ \t]+\r?\n/g, '$1' + eol);
        text = text.replace(/\[\s*((?:[\da-fA-F]{2}\s*)+)\s*\]/g, (_, contents: string) => `[ ${contents.replace(/([\da-fA-F]{2})\s*/g, '$1 ')} ]`);
        text = text.replace(/[ \t]+\r?\n/g, eol);

        // convert tabs to spaces to get the right line width:
        text = text.replace(/\t/g, ' '.repeat(options.tabSize));

        const indentStep = options.insertSpaces ? ' '.repeat(options.tabSize) : '\t';
        if (options.insertSpaces) {
            text = text.replace(/^\t+/g, tabs => indentStep.repeat(tabs.length));
        } else {
            text = text.replace(new RegExp(`^( {${options.tabSize}})+`, 'gm'), spaces => '\t'.repeat(spaces.length / options.tabSize));
        }

        // indentation
        let commaIndent = '';
        text = text.split(/\r?\n/).map(line => {
            if (line.length === 0) {
                return line;
            }

            const delta = (line.match(/{/g) || []).length - (line.match(/}/g) || []).length;
            if (delta < 0) {
                indent = indent.slice(indentStep.repeat(-delta).length);
            }
            const retval = line.replace(/^[ \t]*/g, indent + commaIndent);
            if (delta > 0) {
                indent += indentStep.repeat(delta);
            }

            // property values with commas should all have the same indentation
            if (commaIndent.length === 0 && line.endsWith(',')) {
                commaIndent = ' '.repeat(line.replace(/\t/g, ' '.repeat(options.tabSize)).indexOf('=') + 2 - indent.replace(/\t/g, ' '.repeat(options.tabSize)).length);

                if (!options.insertSpaces) {
                    commaIndent = commaIndent.replace(new RegExp(' '.repeat(options.tabSize), 'g'), '\t');
                }
            } else if (line.endsWith(';')) {
                commaIndent = '';
            }

            return retval;
        }).join(eol);


        // move comma separated property values on new lines:
        text = text.replace(/([ \t]*)([#\w-]+)\s*=((?:\s*(?:".*?"|<.*?>|\[.*?\])[ \t]*,?\s*(\/\*.*?\*\/)?\s*)+);/gm, (line: string, indentation: string, p: string, val: string) => {
            if (line.length < 80) {
                return line;
            }

            const regex =  new RegExp(/((?:".*?"|<.*?>|\[.*?\])[ \t]*,?)[ \t]*(\/\*.*?\*\/)?/gm);
            const parts = [];
            let entry: RegExpMatchArray;
            while ((entry = regex.exec(val))) {
                if (entry[2]) {
                    parts.push(entry[1] + ' ' + entry[2]);
                } else {
                    parts.push(entry[1]);
                }
            }

            if (!parts.length) {
                return line;
            }

            const start = `${indentation}${p} = `;
            return start + parts.map(p => p.trim()).join(`${eol}${indentation}${' '.repeat(p.length + 3)}`) + ';';
        });

        // The indentation stuff broke multiline comments. The * on the follow up lines must align with the * in /*:
        text = text.replace(/\/\*[\s\S]*?\*\//g, content => {
            return content.replace(/^([ \t]*)\*/gm, '$1 *');
        });

        return [new vscode.TextEdit(range, text)];
    }

    provideDocumentLinks(document: vscode.TextDocument, token: vscode.CancellationToken): vscode.ProviderResult<vscode.DocumentLink[]> {
        return this.parser.file(document.uri)?.includes.filter(i => i.loc.uri.fsPath === document.uri.fsPath).map(i => {
            const link = new vscode.DocumentLink(i.loc.range, i.dst);
            link.tooltip = i.dst.fsPath;
            return link;
        }) ?? [];
    }
}

export async function activate(context: vscode.ExtensionContext) {
    await zephyr.activate(context);

    const engine = new DTSEngine();
    engine.activate(context);
}

// eslint-disable-next-line @typescript-eslint/no-empty-function
export function deactivate() {
}