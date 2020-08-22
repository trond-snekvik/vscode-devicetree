'use strict';
import * as vscode from 'vscode';
import * as dts from './dts';
import * as types from './types';
import * as zephyr from './zephyr';
import {lint, LintCtx} from './lint';
import * as path from 'path';
import * as fs from 'fs';
import { execSync } from 'child_process';
import { DiagnosticsSet } from './diags';

function getConfig(variable: string) {
    const config = vscode.workspace.getConfiguration('devicetree');

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
            snippet.appendText(p.name + ' = < ');
            snippet.appendPlaceholder('&label');
            snippet.appendText(' >');
            break;
        case 'phandle-array': {
            snippet.appendText(p.name + ' = < &');
            snippet.appendPlaceholder('label');
            let cellNames: string[] = [];
            const cellsName = `${p.name.slice(0, p.name.length - 1)}-cells`;
            if (p.name.endsWith('s') && node?.parent?.type && cellsName in node.parent.type) {
                cellNames = node.parent.type[cellsName];
            }

            Array(dts.getPHandleCells(p.name, node?.parent)).forEach((_, i) => {
                (<vscode.SnippetString>snippet).appendText(' ');
                if (i < cellNames.length) {
                    (<vscode.SnippetString>snippet).appendPlaceholder(cellNames[i]);
                } else {
                    (<vscode.SnippetString>snippet).appendPlaceholder(`cell${i+1}`);
                }
            });
            snippet.appendText(' >');
            break;
        }
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

class DTSEngine implements vscode.DocumentSymbolProvider, vscode.DefinitionProvider, vscode.HoverProvider, vscode.CompletionItemProvider, vscode.SignatureHelpProvider, vscode.DocumentRangeFormattingEditProvider, vscode.DocumentLinkProvider {
    parser: dts.Parser;
    diags: vscode.DiagnosticCollection;
    types: types.TypeLoader;
    prevDiagUris: vscode.Uri[] = [];

    constructor() {
        this.diags = vscode.languages.createDiagnosticCollection('DeviceTree');
        this.types = new types.TypeLoader();

        const timeStart = process.hrtime();
        const bindingDirs = getBindingDirs();
        bindingDirs.forEach(d => this.types.addFolder(d));
        const procTime = process.hrtime(timeStart);
        console.log(`Found ${Object.keys(this.types.types).length} bindings in ${bindingDirs.join(', ')}. ${(procTime[0] * 1e9 + procTime[1]) / 1000000} ms`);

        const defines = (getConfig('deviceTree.defines') ?? {}) as {[name: string]: string};
        const includes = getConfig('deviceTree.includes') as string[] ??
            vscode.workspace.workspaceFolders.map(w => ['include', 'dts/common', 'dts/arm', 'dts'].map(i => w.uri.fsPath + '/' + i)).reduce((arr, elem) => [...arr, ...elem], []);

        this.parser = new dts.Parser(defines, includes, this.types);
        this.parser.onChange(ctx => {
            const lintCtx: LintCtx =  {
                diags: new DiagnosticsSet(),
                types: this.types,
                ctx,
            };

            lint(lintCtx);
            const diags = ctx.getDiags();
            diags.merge(lintCtx.diags);
            this.setDiags(diags);
        });
    }

    activate(ctx: vscode.ExtensionContext) {
        const selector = <vscode.DocumentFilter>{ language: 'dts', scheme: 'file' };
        let disposable = vscode.languages.registerDocumentSymbolProvider(selector, this);
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

        vscode.languages.setLanguageConfiguration('dts',
            <vscode.LanguageConfiguration>{
                wordPattern: /(0x[a-fA-F\d]+|-?\d+|&?[#\w,-]+)/,
                comments: {
                    blockComment: ['/*', '*/'],
                    lineComment: '//'
                },
                indentationRules: { increaseIndentPattern: /{/, decreaseIndentPattern: /}/ },
                brackets: [
                    ['<', '>'],
                    ['{', '}'],
                    ['[', ']'],
                ]
            });

        this.parser.activate(ctx);
    }

    private setDiags(diags: DiagnosticsSet) {
        this.prevDiagUris.filter(uri => !diags.all.find(set => uri.toString() === set.uri.toString())).forEach(uri => this.diags.set(uri, []));
        diags.all.forEach(d => this.diags.set(d.uri, d.diags));
        this.prevDiagUris = diags.all.map(set => set.uri);
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

    provideHover(document: vscode.TextDocument, position: vscode.Position, token: vscode.CancellationToken): vscode.ProviderResult<vscode.Hover> {
        const file = this.parser.file(document.uri);
        if (!file) {
            return;
        }

        const line = file.lines.find(l => l.uri.fsPath === document.uri.fsPath && l.number === position.line);
        if (line) {
            const m = line.macros.find(m => position.character >= m.start && position.character < m.start + m.raw.length);
            if (m) {
                return new vscode.Hover({language: 'dts', value: `#define ${m.raw} ${m.insert}`});
            }
        }

        // hover reference
        const bundle = this.getNodeDefinition(file.ctx, document, position);
        if (bundle) {
            const node = bundle[1];

            let expanded = `${node.fullName} {`;

            expanded += node.uniqueProperties().map(p => `\n\t${p.toString()};`).join('');
            expanded += node.children().reduce((array, curr) => {
                if (!array.find(c => c.fullName === curr.fullName)) {
                    array.push(curr);
                }
                return array;
            }, new Array<dts.Node>()).map(c => `\n\t${c.fullName} { /* ... */ };`).join('');
            expanded += '\n};';

            const name = new vscode.MarkdownString('`' + node.path + '`');
            if (!node.type.invalid) {
                name.appendText(' (' + node.type.description + ')');
            }

            return new vscode.Hover([name, {language: 'dts', value: expanded}], bundle[0]);
        }

        // hover property name
        const word = document.getWordRangeAtPosition(position);
        if (!word) {
            return;
        }

        const symbol = document.getText(word);
        const node = file.getNodeAt(position, document.uri);
        if (!node) {
            return;
        }

        const type = this.types.nodeType(node);
        const prop = type.properties.find(p => p.name === symbol);
        if (prop) {
            const results: vscode.MarkedString[] = [];
            if (prop.description) {
                results.push(new vscode.MarkdownString(prop.description));
            }
            results.push(new vscode.MarkdownString('type: `' + (Array.isArray(prop.type) ? prop.type.join('`, `') : prop.type) + '`'));
            return new vscode.Hover(results, word);
        }

        const entry = node.entries.find(e => e.nameLoc.uri.fsPath === document.uri.fsPath && e.nameLoc.range.contains(position));
        if (entry) {
            const results: vscode.MarkedString[] = [];
            if (type.title) {
                results.push(new vscode.MarkdownString(type.title));
            }
            if (type.description) {
                results.push(new vscode.MarkdownString(type.description));
            }

            results.push(new vscode.MarkdownString('`' + node.path + '`'));

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

        const word = document.getWordRangeAtPosition(position, /"[\w,-]+"/);
        if (!word) {
            return;
        }
        let symbol = document.getText(word);

        if (symbol) {
            symbol = symbol.slice(1, symbol.length - 1);
            const prop = file.ctx.getPropertyAt(position, document.uri);
            if (!prop) {
                return;
            }

            if (prop.name === 'compatible') {
                const type = prop.entry.node.type;
                if (type && type.filename.length > 0) {
                    return new vscode.Location(vscode.Uri.file(type.filename), new vscode.Position(0, 0));
                }
            }
        }
    }

    resolveCompletionItem?(item: vscode.CompletionItem, token: vscode.CancellationToken): vscode.ProviderResult<vscode.CompletionItem> {
        if (item.kind === vscode.CompletionItemKind.Class) {
            const node = this.parser.currCtx?.node(item.label);
            if (node) {
                const type = this.types.nodeType(node);
                if (type) {
                    item.documentation = new vscode.MarkdownString();
                    if (type.description) {
                        item.documentation.appendText(type.description);
                    }
                }
            }
        }
        return item;
    }

    provideCompletionItems(document: vscode.TextDocument, position: vscode.Position, token: vscode.CancellationToken, context: vscode.CompletionContext): vscode.ProviderResult<vscode.CompletionItem[] | vscode.CompletionList> {
        const file = this.parser.file(document.uri);
        if (!file) {
            return;
        }
        const node = file.ctx.getNodeAt(position, document.uri);

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
                    completion.documentation = new vscode.MarkdownString(`**${l.type.title}**\n\n${l.type.description}`);
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
            } else {
                item.kind = vscode.CompletionItemKind.Constant;
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
                const propType = (node.type?.properties.find(p => p.name === prop.name));
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

                            if (type.loaded) {
                                completion.detail = type.title;
                                completion.documentation = type.description;
                            }
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
            typeProps = typeProps.filter(p => (p.name !== '#size-cells') && (p.name !== '#address-cells') && p.isLoaded && !nodeProps.find(pp => pp.name === p.name));
        }

        const propCompletions = typeProps
            .map(p => {
                const completion = new vscode.CompletionItem(p.name, vscode.CompletionItemKind.Property);
                completion.detail = Array.isArray(p.type) ? p.type[0] : p.type;
                completion.documentation = p.description;
                if (p.name === 'compatible') {
                    completion.kind = vscode.CompletionItemKind.TypeParameter;
                }

                completion.insertText = new vscode.SnippetString();
                appendPropSnippet(p, completion.insertText, node);
                return completion;
            });

        let nodes: types.NodeType[] = [];
        if (node.type?.['bus']) {
            nodes = Object.values(this.types.types)
                .filter(n => n[0].name !== '/')
                .reduce((all, n) => [...all, ...n], [])
                .filter(n => n.loaded && n['on-bus'] === node.type['bus']);
        }

        nodes = nodes.filter(n => !n.name.startsWith('/') || n.name.startsWith(node.name));

        if (node.type?.['child-binding']) {
            nodes.push(node.type['child-binding']);
        }

        const anyNode = new vscode.CompletionItem('node', vscode.CompletionItemKind.Class);
        anyNode.insertText = new vscode.SnippetString();
        anyNode.insertText.appendPlaceholder('node-name');
        if (node.type?.["child-binding"]) {
            anyNode.insertText.appendText(' {\n');
            node.type['child-binding'].properties.filter(p => p.required || p.name === 'status').forEach(p => {
                (<vscode.SnippetString>anyNode.insertText).appendText(`\t`);
                appendPropSnippet(p, <vscode.SnippetString>anyNode.insertText); // todo: This new node's parent is `node`, how to address?
                (<vscode.SnippetString>anyNode.insertText).appendText(`\n`);
            });

        } else {
            anyNode.insertText.appendText(' {\n\tcompatible = "');
            anyNode.insertText.appendTabstop();
            anyNode.insertText.appendText('";');
            anyNode.insertText.appendText('\n\tstatus = "');
            anyNode.insertText.appendPlaceholder('okay');
            anyNode.insertText.appendText('";\n\t');
            anyNode.insertText.appendTabstop();
        }
        anyNode.insertText.appendText('\n};');

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
            anyNode,
            deleteNode,
            deleteProp,
            ...nodes.map(n => {
                const completion = new vscode.CompletionItem(n.name, vscode.CompletionItemKind.Class);
                completion.insertText = new vscode.SnippetString();
                completion.insertText.appendPlaceholder('node-name');
                completion.insertText.appendText(` {\n\tcompatible = "${n.name}";\n\t`);
                completion.insertText.appendTabstop();
                completion.insertText.appendText('\n};');
                completion.documentation = n.description;
                completion.detail = n.title;
                return completion;
            }),
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

        const propType = node.type.properties.find(p => p.name === prop.name);
        if (!propType) {
            return;
        }

        if (propType.type === 'int' && propType.description) {
            const info = new vscode.SignatureInformation(`${node.path}${prop.name}`, propType.description);
            info.parameters = [new vscode.ParameterInformation(`number`)];
            const help = new vscode.SignatureHelp();
            help.activeParameter = 0;
            help.activeSignature = 0;
            help.signatures = [info];
            return help;
        }

        if (propType.type !== 'phandle-array' && propType.type !== 'array') {
            return;
        }

        if (!prop.pHandleArray) {
            return;
        }

        const value = prop.pHandleArray;

        const entry = value.find(v => v.loc.range.contains(position));

        let paramIndex = (entry?.val.findIndex(v => v.loc.range.contains(position)) ?? 0) - 1;
        if (paramIndex < 0) {
            paramIndex = entry.val.length - 1;
        }

        let params: string[];

        const cells = dts.getCells(prop.name, node.parent);
        if (cells) {
            params = cells;
        } else if (propType.type === 'phandle-array') {
            let ref : dts.Node;
            if (entry.length > 0 && (entry.val[0] instanceof dts.PHandle) && (ref = ctx.node(entry.val[0].val))) {
                const cellNames = ref.type?.[dts.cellName(prop.name)];
                if (cellNames) {
                    params = [entry.val[0].val, ...cellNames];
                } else {
                    const cellsProp = dts.getPHandleCells(prop.name, ref);
                    const len = cellsProp?.number ?? entry.length - 1;
                    params = [entry.val[0].val, ...new Array(len).map((_, i) => `cell-${i + 1}`)];
                }
            }
        } else {
            params = new Array(entry.length).map((_, i) => `param-${i+1}`);
        }

        if (!params) {
            return;
        }

        const signature = prop.name + ` = < ${params.join(' ')} >;`;

        const info = new vscode.SignatureInformation(signature, propType.description);
        info.parameters = params.map((name, i) => new vscode.ParameterInformation(name));

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
        text = text.replace(/([;{])[ \t]+\r?\n?/g, '$1' + eol);
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
        text = text.replace(/^([ \t]*)([#\w-]+)\s*=\s*((?:(?:".*?"|<.*?>|\[.*?\])[ \t]*,?[ \t]*)+);/gm, (line, indentation, p, val) => {
            if (line.length < 80) {
                return line;
            }
            const parts = val.match(/(".*?"|<.*?>|\[.*?\])[ \t]*,?[ \t]*/g);
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