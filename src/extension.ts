'use strict';
import * as vscode from 'vscode';
import * as parser from './parser';
import * as types from './types';
import * as glob from 'glob';
import { readFileSync } from 'fs';
import * as path from 'path';


function getConfig(variable: string) {
    var config = vscode.workspace.getConfiguration('devicetree');

    var result = config.inspect(variable);
    if (result) {
        return result.workspaceFolderValue || result.workspaceValue || result.globalValue || result.defaultValue;
    }
    return undefined;
}

function getAutoIncludes(dir: string): string[] {
    var patterns = getConfig('autoincludes') as string[];
    patterns = patterns.map(p => {
        return p.replace(/\${(.+?)}/g, (fullMatch: string, variable: string) => {
            if (variable.startsWith('workspaceFolder')) {
                if (vscode.workspace.workspaceFolders.length === 0) {
                    return '';
                }

                var parts = variable.split(':');
                var workspace = vscode.workspace.workspaceFolders.find(f => parts.length === 1 || f.name === parts[1]);
                return workspace ? workspace.uri.fsPath : '';
            }

            if (['file', 'relativeFile', 'relativeFileDirname', 'fileDirname'].indexOf(variable) >= 0 &&
                vscode.window.activeTextEditor &&
                vscode.window.activeTextEditor.document) {
                return vscode.window.activeTextEditor.document.uri.fsPath.replace(/[^\/\\]+$/, '');
            }

            return fullMatch;
        });
    })
    return glob.sync('{' + patterns.join(',') + '}', {cwd: dir, absolute: true, nosort: true}).map(p => path.resolve(dir, p));
}

function appendPropSnippet(p: types.PropertyType, snippet: vscode.SnippetString, parent?: parser.Node, parentType?: types.NodeType, node?: parser.Node) {
    switch (p.type) {
        case 'boolean':
            snippet.appendText(p.name);
            break;
        case 'array':
            snippet.appendText(p.name + ' = < ');
            var cells = getCells(p.name, parent);
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
            snippet.appendText(' >')
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
            snippet.appendText('"')
            break;
        case 'phandle':
            snippet.appendText(p.name + ' = < ');
            snippet.appendPlaceholder('&label');
            snippet.appendText(' >')
            break;
        case 'phandle-array':
            snippet.appendText(p.name + ' = < &');
            snippet.appendPlaceholder('label');
            var cellNames: string[] = []
            var cellsName = `${p.name.slice(0, p.name.length - 1)}-cells`;
            if (p.name.endsWith('s') && parentType && cellsName in parentType) {
                cellNames = parentType[cellsName];
            }

            Array(getPHandleCells(p.name, parent)).forEach((_, i) => {
                (<vscode.SnippetString>snippet).appendText(' ');
                if (i < cellNames.length) {
                    (<vscode.SnippetString>snippet).appendPlaceholder(cellNames[i]);
                } else {
                    (<vscode.SnippetString>snippet).appendPlaceholder(`cell${i+1}`);
                }
            });
            snippet.appendText(' >')
            break;
        case 'uint8-array':
            snippet.appendText(p.name + ' = [ ');
            snippet.appendTabstop();
            snippet.appendText(' ]')
            break;
        case 'compound':
            snippet.appendText(p.name + ' = ');
            snippet.appendTabstop();
            break;
    }

    snippet.appendText(';')
};

function getCells(propName: string, parent?: parser.Node): string[] | undefined {
    var cellProp = getPHandleCells(propName, parent);

    if (cellProp) {
        return ['label'].concat(Array(<number> cellProp.value.value).fill('cell'));
    }

    if (propName === 'reg') {
        var addrCells = 2;
        var sizeCells = 1;
        if (parent) {
            var parentProps = parent.uniqueProperties();

            var addrCellsProp = parentProps.find(p => p.name === '#address-cells');
            if (addrCellsProp) {
                addrCells = addrCellsProp.value.value as number;
            }

            var sizeCellsProp = parentProps.find(p => p.name === '#size-cells');
            if (sizeCellsProp) {
                sizeCells = sizeCellsProp.value.value as number;
            }
        }
        return Array(addrCells).fill('addr').concat(Array(sizeCells).fill('size'));
    }
}

function getPHandleCells(propname: string, parent?: parser.Node): parser.Property {
    if (propname.endsWith('s') && parent) {
        /* Weird rule: phandle array cell count is determined by the #XXX-cells entry in the parent,
         * where XXX is the singular version of the name of this property UNLESS the property is called XXX-gpios, in which
         * case the cell count is determined by the parent's #gpio-cells property
         */
        var cellName = propname.endsWith('-gpios') ? '#gpio-cells' : ('#' + propname.slice(0, propname.length) + '-cells')
        return parent.properties().find(p => p.name === cellName);
    }
}

class DTSEngine implements vscode.DocumentSymbolProvider, vscode.DefinitionProvider, vscode.HoverProvider, vscode.CompletionItemProvider, vscode.SignatureHelpProvider, vscode.DocumentRangeFormattingEditProvider {
    parser: parser.Parser;
    diags: vscode.DiagnosticCollection;
    types: types.TypeLoader;

    constructor(context: vscode.ExtensionContext) {
        this.parser = new parser.Parser();
        this.types = new types.TypeLoader();
        this.diags = vscode.languages.createDiagnosticCollection('Devicetree');
        vscode.workspace.workspaceFolders.forEach(f => this.types.addFolder(f.uri.fsPath + '/dts/bindings'));

        this.setDoc(vscode.window.activeTextEditor.document)
        context.subscriptions.push(vscode.window.onDidChangeActiveTextEditor(editor => this.setDoc(editor.document)));
        context.subscriptions.push(vscode.workspace.onDidChangeTextDocument(change => this.parseDoc(change.document)));
    }

    addMissing(entry: parser.NodeEntry, propType: types.PropertyType) {
        if (vscode.window.activeTextEditor.document.uri.fsPath !== entry.range.doc.uri.fsPath) {
            return;
        }
        var indent = vscode.window.activeTextEditor.options.insertSpaces ? ' '.repeat(vscode.window.activeTextEditor.options.tabSize as number) : '\t';
        var line = entry.range.toRange().end.line;
        var snippet = new vscode.SnippetString(`\n${indent}${propType.name} = `);
        appendPropSnippet(propType, snippet, entry.node.parent, entry.node.parent && this.types.nodeType(entry.node.parent), entry.node);
        vscode.window.activeTextEditor.insertSnippet(snippet, new vscode.Position(line - 1, 99999999));
    }

    setDoc(document: vscode.TextDocument) {
        if (document.languageId !== 'dts') {
            return;
        }

        if (document.uri.fsPath in this.parser.docs) {
            return;
        }

        this.parser = new parser.Parser();

        var dir = document.uri.fsPath.replace(/[\\/][^\\/]+$/, '').replace(/\\/g, '/');

        var docs = getAutoIncludes(dir);

        Promise.all(docs.map(d => {
            return vscode.workspace.openTextDocument(d).then(doc => this.parseDoc(doc));
        })).then(_ => {
            this.parseDoc(document);
        });
    }

    parseDoc(doc: vscode.TextDocument) {
        if (doc.languageId !== 'dts') {
            return;
        }
        var diags: vscode.Diagnostic[] = [];

        var topLevelEntries = this.parser.parse(doc.getText(), doc, doc.version, diags);

        var annotateNode = (entry: parser.NodeEntry, parentType?: types.NodeType) => {
            var node = entry.node;
            const props = node.properties();
            var type: types.NodeType;

            var type = this.types.nodeType(node, parentType, diags);

            if (node.fullName === 'aliases' || node.fullName === 'chosen') {
                if (node.path === '/aliases/' || node.path === '/chosen/') {
                    if (node.children().length > 0) {
                        diags.push(new vscode.Diagnostic(entry.nameRange.toRange(), `Node ${node.name} shouldn't have child nodes`, vscode.DiagnosticSeverity.Error));
                    }

                    entry.properties.forEach(p => {
                        if (p.value.raw.startsWith('&')) {
                            var ref = this.parser.getNode(p.value.raw);
                            if (!ref) {
                                diags.push(new vscode.Diagnostic(p.range.toRange(), `Unknown reference to ${p.value.raw}`, vscode.DiagnosticSeverity.Error));
                            }
                        } else if (typeof p.value.value === 'string') {
                            var ref = this.parser.getNode(p.value.value);
                            if (!ref) {
                                diags.push(new vscode.Diagnostic(p.range.toRange(), `Unknown reference to ${p.value.raw}`, vscode.DiagnosticSeverity.Error));
                            }
                        } else {
                            diags.push(new vscode.Diagnostic(p.range.toRange(), `Properties in ${node.name} must be references to nodes`, vscode.DiagnosticSeverity.Error));
                        }
                    });
                } else {
                    diags.push(new vscode.Diagnostic(entry.nameRange.toRange(), `Node ${node.name} must be under the root node`, vscode.DiagnosticSeverity.Error));
                }
                return;
            }

            if (node.fullName === 'cpus') {
                if (node.path !== '/cpus/') {
                    diags.push(new vscode.Diagnostic(entry.nameRange.toRange(), `Node cpus must be directly under the root node`, vscode.DiagnosticSeverity.Error));
                }
            }

            entry.children.forEach(c => annotateNode(c, type));

            if (!type) {
                diags.push(new vscode.Diagnostic(entry.nameRange.toRange(), `Unknown node type`, vscode.DiagnosticSeverity.Warning));
                return;
            }

            type.properties.forEach(propType => {
                var prop = props.find(p => p.name === propType.name);
                if (prop) {
                    prop = entry.properties.find(p => p.name === prop.name);
                    if (prop) {
                        var correctType = (type: types.PropertyTypeString) => {
                            switch (type) {
                                case 'array':
                                    return (typeof prop.value.value === 'number') || (Array.isArray(prop.value.value) && (prop.value.value as any[]).every(v => typeof v === 'number'));
                                case 'boolean':
                                    return (typeof prop.value.value === 'boolean');
                                case 'compound':
                                    return true; // any
                                case 'int':
                                    return (typeof prop.value.value === 'number');
                                case 'phandle':
                                    /* PHandles can be numbers if there's a node with that number as the value of their phandle property. */
                                    return ((typeof prop.value.value === 'object') && ('node' in prop.value.value)) ||
                                           ((typeof prop.value.value === 'number') && (this.parser.getPHandleNode(prop.value.value)));
                                case 'phandle-array':
                                    return (Array.isArray(prop.value.value) && (prop.value.value as any[]).every(v => typeof v === 'number' || (typeof v === 'string' && v.startsWith('&')))) ||
                                            (typeof prop.value.value === 'number' || (typeof prop.value.value === 'string' && prop.value.value.startsWith('&')));
                                case 'string':
                                    return (typeof prop.value.value === 'string');
                                case 'string-array':
                                    return (typeof prop.value.value === 'string') || (Array.isArray(prop.value.value) && (prop.value.value as any[]).every(v => typeof v === 'string'));
                                case 'uint8-array':
                                    return (Array.isArray(prop.value.value) && (prop.value.value as any[]).every(v => typeof v === 'number') && prop.value.raw.match(/\[[\da-fA-F\s]+\]/));
                                default:
                                    return true;
                            }
                        };

                        if (Array.isArray(propType.type)) {
                            if (!propType.type.find(correctType)) {
                                diags.push(new vscode.Diagnostic(prop.range.toRange(), 'Property value type must be one of ' + propType.type.join(', '), vscode.DiagnosticSeverity.Warning));
                            }
                        } else if (!correctType(propType.type)) {
                            diags.push(new vscode.Diagnostic(prop.range.toRange(), `Property value type must be ${propType.type}`, vscode.DiagnosticSeverity.Warning));
                        }

                        if (propType.enum && propType.enum.indexOf(prop.value.value.toString()) < 0) {
                            diags.push(new vscode.Diagnostic(prop.range.toRange(), 'Property value must be one of ' + propType.enum.join(', '), vscode.DiagnosticSeverity.Warning));
                        }

                        if (propType.const !== undefined && propType.const !== prop.value.value) {
                            diags.push(new vscode.Diagnostic(prop.range.toRange(), `Property value must be ${propType.const}`, vscode.DiagnosticSeverity.Warning));
                        }

                        if (propType.type === 'phandle-array') {
                            var propText = doc.getText(prop.range.toRange()) as string;
                            (<(string | number)[]>prop.value.value).forEach(e => {
                                if (typeof e === 'string' && !this.parser.getPHandleNode(e.slice(1))) {
                                    diags.push(new vscode.Diagnostic(new parser.OffsetRange(doc, prop.range.start + propText.indexOf(e)).toRange(), `Unknown label`, vscode.DiagnosticSeverity.Warning));
                                }
                            })
                        }

                        if (prop.name === 'reg') {
                            var cells = getCells(prop.name, node.parent);

                            if (cells) {
                                if ((typeof prop.value.value === 'number' && cells.length !== 1) ||
                                    (Array.isArray(prop.value.value) && prop.value.value.length !== cells.length)) {
                                    diags.push(new vscode.Diagnostic(
                                        prop.range.toRange(),
                                        `reg property must be on format <${cells.join(' ')}>`,
                                        vscode.DiagnosticSeverity.Error));
                                }
                            } else {
                                diags.push(new vscode.Diagnostic(
                                    prop.range.toRange(),
                                    `Unable to fetch addr and size count`,
                                    vscode.DiagnosticSeverity.Error));

                            }
                        } else if (prop.name === 'compatible') {
                            var propText = doc.getText(prop.range.toRange());
                            var types: string[] = typeof prop.value.value === 'string' ? [prop.value.value] : prop.value.value as string[];
                            var type = types.map(t => {
                                var type = this.types.get(t, node.name);
                                if (!type) {
                                    var range = doc.getWordRangeAtPosition(doc.positionAt(prop.range.start + propText.indexOf(`"${t}"`)), /".*?"/);
                                    diags.push(new vscode.Diagnostic(range, `Unknown node type ${t}`, vscode.DiagnosticSeverity.Warning));
                                }
                                return type;
                            }).find(t => t);

                            if (type && type['parent-bus'] && parentType) {
                                if (parentType['child-bus'] !== type['parent-bus']) {
                                    diags.push(new vscode.Diagnostic(
                                        entry.nameRange.toRange(),
                                        `Invalid bus: Node exists on bus "${type['parent-bus']}", parent bus is "${parentType['child-bus']}" `,
                                        vscode.DiagnosticSeverity.Error));
                                }
                            }

                        } else if (propType.type === 'phandle-array' && Array.isArray(prop.value.value)) {
                            var c = getPHandleCells(prop.name, node.parent);
                            if (c) {
                                var value = c.value.value as (string | number)[];
                                if (typeof c.value.value === 'number') {
                                    if ((value.length % (c.value.value + 1)) !== 0) {
                                        diags.push(new vscode.Diagnostic(prop.range.toRange(), `PHandle array must have ${c.value.value} number cells`, vscode.DiagnosticSeverity.Error));
                                    }
                                } else {
                                    diags.push(new vscode.Diagnostic(prop.range.toRange(), `Parent's *-cells property must be an int`, vscode.DiagnosticSeverity.Error));
                                }
                            }
                        }
                    }
                } else if (propType.required) {
                    var status = props.find(p => p.name === 'status');
                    var diag = new vscode.Diagnostic(entry.nameRange.toRange(), `Property "${propType.name}" is required`, (status && status.value.raw === 'okay') ? vscode.DiagnosticSeverity.Error : vscode.DiagnosticSeverity.Information);
                    diags.push(diag);
                }
            });

            entry.properties.forEach(p => {
                if (!type.properties.find(t => t.name === p.name)) {
                    diags.push(new vscode.Diagnostic(p.range.toRange(), `Property not mentioned in type "${type.name}"`, vscode.DiagnosticSeverity.Warning));
                }
            });
        }

        topLevelEntries.forEach(e => annotateNode(e));
        this.diags.set(doc.uri, diags);
    }

    provideDocumentSymbols(document: vscode.TextDocument, token: vscode.CancellationToken): vscode.ProviderResult<vscode.SymbolInformation[]> {
        var propSymbolKind = (p: parser.Property) => {
            if (p.name.startsWith('#')) {
                return vscode.SymbolKind.Number;
            }
            switch (typeof p.value.value) {
                case 'boolean': return vscode.SymbolKind.Boolean;
                case 'number': return vscode.SymbolKind.Operator;
                case 'string':
                    if (p.name === 'compatible') {
                        return vscode.SymbolKind.TypeParameter;
                    }
                    if (p.name === 'status') {
                        return vscode.SymbolKind.Event;
                    }
                    return vscode.SymbolKind.String;
                default:
                    if (Array.isArray(p.value.value)) {
                        if (typeof p.value.value[0] === 'string') {
                            return vscode.SymbolKind.String;
                        }
                        if (p.value.raw.startsWith('[')) {
                            return vscode.SymbolKind.Array;
                        }
                    }
                    if (p.value.raw.startsWith('&')) {
                        return vscode.SymbolKind.Interface;
                    }
                    return vscode.SymbolKind.Object;
            }
        };

        var symbols: vscode.SymbolInformation[] = [];
        this.parser.nodeArray().forEach(n => {
            n.entries.filter(e => e.range.doc.uri.fsPath === document.uri.fsPath).map(e => {
                var node = new vscode.SymbolInformation(e.node.fullName, vscode.SymbolKind.Class, e.node.parent && e.node.parent.fullName, new vscode.Location(document.uri, e.range.toRange()));
                symbols.push(node);
                symbols.push(...e.properties.map(p => new vscode.SymbolInformation(p.name, propSymbolKind(p), e.node.fullName, new vscode.Location(document.uri, p.range.toRange()))));
            });
        });
        return symbols;
    }

    getNodeDefinition(document: vscode.TextDocument, position: vscode.Position): [vscode.Range, parser.Node] | undefined {
        var word = document.getWordRangeAtPosition(position, /&[\w\-]+/);
        if (word) {
            var symbol = document.getText(word);
            if (symbol.startsWith('&')) { // label
                var node = this.parser.getNode(symbol);
                if (node) {
                    return [word, node];
                }
            }
        }

        word = document.getWordRangeAtPosition(position, /"[\w,\-/@]+"/);
        if (word) {
            var symbol = document.getText(word);

            if (symbol) {
                symbol = symbol.slice(1, symbol.length - 1);
                var property = this.parser.getPropertyAt(position, document);
                if (!property) {
                    return;
                }

                if (property[0].name === 'aliases' || property[0].name === 'chosen') { // the string should be a path
                    var node = this.parser.getNode(symbol);
                    if (!node) {
                        return;
                    }

                    return [word, node];
                }
            }
        }
    }

    provideHover(document: vscode.TextDocument, position: vscode.Position, token: vscode.CancellationToken): vscode.ProviderResult<vscode.Hover> {
        // hover alias
        var bundle = this.getNodeDefinition(document, position);
        if (bundle) {
            var node = bundle[1];

            var expanded = `${node.fullName} {`;

            expanded += node.uniqueProperties().map(p => `\n\t${p.toString()};`).join('');
            expanded += node.children().map(c => `\n\t${c.name} { /* ... */ };`).join('');
            expanded += '\n};';

            return new vscode.Hover([new vscode.MarkdownString('`' + node.path + '`'), {language: 'dts', value: expanded}], bundle[0]);
        }

        // hover property name
        var word = document.getWordRangeAtPosition(position);
        if (!word) {
            return;
        }
        var symbol = document.getText(word);
        var node = this.parser.getNodeAt(position, document);
        if (!node) {
            return;
        }
        var type = this.types.nodeType(node, node.parent && this.types.nodeType(node.parent));
        var prop = type.properties.find(p => p.name === symbol);
        if (prop) {
            var results: vscode.MarkedString[] = [new vscode.MarkdownString('type: `' + (Array.isArray(prop.type) ? prop.type.join('`, `') : prop.type) + '`')];
            if (prop.description) {
                results.push(new vscode.MarkdownString(prop.description));
            }
            return new vscode.Hover(results, word);
        }
    }

    provideDefinition(document: vscode.TextDocument, position: vscode.Position, token: vscode.CancellationToken): vscode.ProviderResult<vscode.Definition> {
        if (document.languageId === 'yaml') {
            var range = document.getWordRangeAtPosition(position, /[\w\-\.,]+\.ya?ml/);
            var text = document.getText(range);
            if (text) {
                var type = Object.keys(this.types.types).map(t => this.types.types[t]).find(t => t.filename.match(new RegExp('.*/' + text)));
                if (type) {
                    return new vscode.Location(vscode.Uri.file(type.filename), new vscode.Position(0, 0));
                }
            }
            return;
        }

        var bundle = this.getNodeDefinition(document, position);
        if (bundle) {
            return bundle[1].entries
                .filter(e => !e.range.toRange().contains(position))
                .map(e => new vscode.Location(e.range.doc.uri, e.range.toRange()));
        }

        var word = document.getWordRangeAtPosition(position, /"[\w,\-]+"/);
        if (!word) {
            return;
        }
        var symbol = document.getText(word);

        if (symbol) {
            symbol = symbol.slice(1, symbol.length - 1);
            var property = this.parser.getPropertyAt(position, document);
            if (!property) {
                return;
            }

            if (property[1].name === 'compatible') {
                var type = this.types.get(symbol);
                if (type && type.filename.length > 0) {
                    return new vscode.Location(vscode.Uri.file(type.filename), new vscode.Position(0, 0));
                }
            }
        }
    }

    resolveCompletionItem?(item: vscode.CompletionItem, token: vscode.CancellationToken): vscode.ProviderResult<vscode.CompletionItem> {
        if (item.kind === vscode.CompletionItemKind.Class) {
            var node = this.parser.getNode(item.label);
            if (node) {
                var type = this.types.nodeType(node, node.parent && this.types.nodeType(node.parent));
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
        var node = this.parser.getNodeAt(position, document);

        var labelItems = (asNode: boolean) => {
            var labels: {label: string, node: parser.Node, type?: types.NodeType}[] = [];
            Object.keys(this.parser.nodes).forEach(name => {
                var node = this.parser.nodes[name];
                var t = this.types.get(node.name);
                labels.push(...node.labels().map(l => {return {label: l, node: node, type: t}; }));
            });

            return labels.map(l => {
                var completion = new vscode.CompletionItem(`&${l.label}`, vscode.CompletionItemKind.Class);
                if (asNode) {
                    completion.insertText = new vscode.SnippetString(completion.label + ' {\n\t');
                    completion.insertText.appendTabstop();
                    completion.insertText.appendText('\n};\n');
                }
                completion.detail = l.node.path;
                if (l.type) {
                    completion.documentation = new vscode.MarkdownString(`**${l.type.title}**\n\n${l.type.description}`);
                }
                return completion;
            });
        }

        if (!node) {
            var root = new vscode.CompletionItem('/', vscode.CompletionItemKind.Class);
            root.insertText = new vscode.SnippetString('/ {\n\t');
            root.insertText.appendTabstop();
            root.insertText.appendText('\n};\n');
            root.detail = 'root node';
            root.documentation = 'The devicetree has a single root node of which all other device nodes are descendants. The full path to the root node is /.';
            root.preselect = true;

            return [root, ...labelItems(true)];
        }

        var lineRange = new vscode.Range(position.line, 0, position.line, 999999);
        var line = document.getText(lineRange);

        var propValueTemplate = (value: string, propType: types.PropertyTypeString | types.PropertyTypeString[]) => {
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
        }

        var parentType = node.parent ? this.types.nodeType(node.parent) : undefined;
        var type = this.types.nodeType(node, parentType);

        var property = this.parser.getPropertyAt(position, document);
        if (property) {
            var before = line.slice(0, position.character);
            if (before.includes('=')) {
                var after = line.slice(position.character);
                const surroundingBraces = [['<', '>'], ['"', '"'], ['[', ']']];
                var braces = surroundingBraces.find(b => before.includes(b[0], before.indexOf('=')) && after.includes(b[1]));
                var start: number, end: number;
                if (braces) {
                    start = line.slice(0, position.character).lastIndexOf(braces[0]) + 1;
                    end = line.indexOf(braces[1], position.character);
                } else {
                    start = line.indexOf('=') + 1;
                    end = position.character + (after.indexOf(';') >= 0 ? after.indexOf(';') : after.length);
                }

                var range = new vscode.Range(position.line, start, position.line, end);
                var propType = (type && type.properties.find(p => p.name === property[1].name));
                if (propType) {
                    if (propType.enum) {
                        var filterText = document.getText(document.getWordRangeAtPosition(position));
                        return propType.enum.map(e => {
                            var completion = new vscode.CompletionItem(e, vscode.CompletionItemKind.EnumMember);
                            completion.range = range;
                            completion.filterText = filterText;
                            if (!braces) {
                                completion.insertText = propValueTemplate(e, propType.type);
                            }
                            return completion;
                        });
                    }

                    if (propType.const) {
                        var completion = new vscode.CompletionItem(propType.const.toString(), vscode.CompletionItemKind.Constant);
                        completion.range = range;
                        if (!braces) {
                            completion.insertText = propValueTemplate(propType.const.toString(), propType.type);
                        }
                    }
                }

                var ref = before.match(/&([\w\-]*)$/);
                if (ref) {
                    return labelItems(false);
                }

                if (property[1].name === 'compatible') {
                    return Object.keys(this.types.types).filter(t => !t.startsWith('/')).map(t => {
                        var completion = new vscode.CompletionItem(t, vscode.CompletionItemKind.EnumMember);
                        completion.range = range;
                        if (!braces) {
                            completion.insertText = propValueTemplate(t, 'string');
                        }
                        if (this.types.types[t].loaded) {
                            completion.detail = this.types.types[t].title;
                            completion.documentation = this.types.types[t].description;
                        }
                        return completion;
                    })
                }
            }
        }

        var nodeProps = node.properties();

        var props = type.properties;
        if (!document.getWordRangeAtPosition(position)) {
            props = props.filter(p => (p.name !== '#size-cells') && (p.name !== '#address-cells') && p.isLoaded && !nodeProps.find(pp => pp.name === p.name));
        }

        var propCompletions = props
            .map(p => {
                var completion = new vscode.CompletionItem(p.name, vscode.CompletionItemKind.Property);
                completion.detail = Array.isArray(p.type) ? p.type[0] : p.type;
                completion.documentation = p.description;
                if (p.name === 'compatible') {
                    completion.kind = vscode.CompletionItemKind.TypeParameter;
                }

                completion.insertText = new vscode.SnippetString();
                appendPropSnippet(p, completion.insertText, node.parent, parentType, node);
                return completion;
            });

        var nodes: types.NodeType[] = [];
        if (type['child-bus']) {
            nodes = Object.keys(this.types.types)
                .map(t => this.types.types[t])
                .filter(n => n.name !== '/')
                .filter(n => n.loaded && n['parent-bus'] === type['child-bus']);
        }

        nodes = nodes.filter(n => !n.name.startsWith('/') || n.name.startsWith(node.name));

        if (type['child-binding']) {
            nodes.push(type['child-binding']);
        }

        var anyNode = new vscode.CompletionItem('node', vscode.CompletionItemKind.Class);
        anyNode.insertText = new vscode.SnippetString();
        anyNode.insertText.appendPlaceholder('node-name');
        if (type && type["child-binding"]) {
            anyNode.insertText.appendText(' {\n');
            type['child-binding'].properties.filter(p => p.required || p.name === 'status').forEach(p => {
                (<vscode.SnippetString>anyNode.insertText).appendText(`\t`);
                appendPropSnippet(p, <vscode.SnippetString>anyNode.insertText, node, type);
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

        return [
            ...propCompletions,
            anyNode,
            ...nodes.map(n => {
                var completion = new vscode.CompletionItem(n.name, vscode.CompletionItemKind.Class);
                completion.insertText = new vscode.SnippetString();
                completion.insertText.appendPlaceholder('node-name');
                completion.insertText.appendText(` {\n\tcompatible = "${n.name}";\n\t`);
                completion.insertText.appendTabstop();
                completion.insertText.appendText('\n};')
                completion.documentation = n.description;
                completion.detail = n.title;
                return completion;
            }),
        ];
    }

    provideSignatureHelp(document: vscode.TextDocument, position: vscode.Position, token: vscode.CancellationToken, context: vscode.SignatureHelpContext): vscode.ProviderResult<vscode.SignatureHelp> {
        var prop = this.parser.getPropertyAt(position, document);
        if (!prop) {
            return;
        }
        var parentType = prop[0].parent && this.types.nodeType(prop[0].parent);
        var nodeType = this.types.nodeType(prop[0], parentType);
        if (!nodeType) {
            return;
        }

        var propType = nodeType.properties.find(p => p.name === prop[1].name);
        if (!propType) {
            return;
        }

        if (propType.type !== 'phandle-array' && propType.type !== 'array') {
            return;
        }

        var text = document.getText(prop[1].range.toRange());
        var rawVal = prop[1].value.raw.slice(1);
        var offset = prop[1].range.start + text.indexOf(rawVal);
        var cursorOffset = document.offsetAt(position);
        if (cursorOffset < offset) {
            return;
        }

        var paramStarts: number[] = [];
        var paramOffset = 0;
        while (rawVal.length) {

            var whitespace = rawVal.match(/^\s+/);
            if (whitespace) {
                paramOffset += whitespace[0].length;
                rawVal = rawVal.slice(whitespace[0].length);
                continue;
            }

            if (rawVal.match(/^\(/)) {
                paramStarts.push(paramOffset);
                paramOffset++;
                rawVal = rawVal.slice(1);
                var parenLvl = 1;
                var match: RegExpMatchArray;
                while (parenLvl > 0 && (match = rawVal.match(/^.*?([()])/))) {
                    parenLvl += 2 * Number(match[1] === '(') - 1;
                    paramOffset += match[0].length;
                    rawVal = rawVal.slice(match[0].length);
                }
                if (parenLvl > 0) {
                    break;
                }
                continue;
            }

            var paramMatch = rawVal.match(/[^\s>]+/);
            if (paramMatch) {
                paramStarts.push(paramOffset);
                paramOffset += paramMatch[0].length;
                rawVal = rawVal.slice(paramMatch[0].length);
                continue;
            }
            break;
        }

        var paramIndex = paramStarts.findIndex(i => (cursorOffset < offset + i)) - 1;
        if (paramIndex < 0 && paramStarts.length > 0 && cursorOffset > offset + paramStarts[0]) {
            paramIndex = paramStarts.length - 1;
        }
        var params: string[];

        var cells = getCells(prop[1].name, prop[0].parent);
        if (cells) {
            params = cells;
        } else {
            params = Array((<[]>prop[1].value.value).length).fill('').map((_, i) => `param-${i+1}`);
        }

        var signature = prop[1].name + ` = < ${params.join(' ')} >;`;

        var info = new vscode.SignatureInformation(signature, propType.description);
        info.parameters = params.map((name, i) => new vscode.ParameterInformation(name));

        return <vscode.SignatureHelp>{activeParameter: paramIndex, activeSignature: 0, signatures: [info]};
    }

    provideDocumentRangeFormattingEdits(document: vscode.TextDocument, range: vscode.Range, options: vscode.FormattingOptions, token: vscode.CancellationToken): vscode.ProviderResult<vscode.TextEdit[]> {
        var entries: parser.NodeEntry[] = [];
        this.parser.nodeArray().forEach(n => {
            entries.push(...n.entries.filter(e => e.range.doc.uri.fsPath === document.uri.fsPath && e.range.toRange().intersection(range)));
        });

        // only format the outermost nodes
        entries = entries.filter(e => !entries.find(ee => ee !== e && ee.range.containsRange(e.range)));

        var eol = document.eol == vscode.EndOfLine.CRLF ? '\r\n' : '\n';

        return entries.map(e => {
            var range = e.range.toRange();
            var text = document.getText(range);
            var firstLine = document.getText(new vscode.Range(range.start.line, 0, range.start.line, 99999));
            var indent = firstLine.match(/^\s*/)[0];

            text = text.replace(/([\w,\-]+)\s*:[\t ]*/g, '$1: ');
            text = text.replace(/(&[\w,\-]+)\s*{[\t ]*/g, '$1 {');
            text = text.replace(/([\w,\-]+)@0*([\da-fA-F]+)\s*{[\t ]*/g, '$1@$2 {');
            text = text.replace(/(\w+)\s*=\s*(".*?"|<.*?>|\[.*?\])\s*;/g, '$1 = $2;');
            text = text.replace(/<\s*(.*?)\s*>/g, '< $1 >');
            text = text.replace(/([;{])[ \t]*\r?\n?/g, '$1' + eol);
            text = text.replace(/\[\s*((?:[\da-fA-F]{2}\s*)+)\s*\]/g, (_, contents: string) => `[ ${contents.replace(/([\da-fA-F]{2})\s*/g, '$1 ')} ]`);
            text = text.replace(/[ \t]+\r?\n/g, eol);

            // convert tabs to spaces to get the right line width:
            text = text.replace(/\t/g, ' '.repeat(options.tabSize));

            // move comma separated property values on new lines:
            text = text.replace(/^([ \t]*)([#\w\-]+)\s*=\s*((?:(?:".*?"|<.*?>|\[.*?\])[ \t]*,?[ \t]*)+);/gm, (line, indentation, p, val) => {
                if (line.length < 80) {
                    return line;
                }
                var parts = val.match(/(".*?"|<.*?>|\[.*?\])[ \t]*,?[ \t]*/g);
                var start = `${indentation}${p} = `;
                return start + parts.map(p => p.trim()).join(`${eol}${indentation}${' '.repeat(p.length + 3)}`) + ';';
            });

            var indentStep = options.insertSpaces ? ' '.repeat(options.tabSize) : '\t';
            if (options.insertSpaces) {
                text = text.replace(/^\t+/g, tabs => indentStep.repeat(tabs.length));
            } else {
                text = text.replace(new RegExp(`^( {${options.tabSize}})+`, 'gm'), spaces => '\t'.repeat(spaces.length / options.tabSize));
            }

            // indentation
            var commaIndent = '';
            text = text.split(/\r?\n/).map(line => {
                var delta = (line.match(/{/g) || []).length - (line.match(/}/g) || []).length;
                if (delta < 0) {
                    indent = indent.slice(indentStep.repeat(-delta).length);
                }
                var retval = line.replace(/^[ \t]*/g, indent + commaIndent);
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

            // The indentation stuff broke multiline comments. The * on the follow up lines must align with the * in /*:
            text = text.replace(/\/\*[\s\S]*?\*\//g, content => {
                return content.replace(/^([ \t]*)\*/gm, '$1 *');
            });

            return new vscode.TextEdit(e.range.toRange(), text);
        })
    }
}

export function activate(context: vscode.ExtensionContext) {
    var engine = new DTSEngine(context);
    const selector = <vscode.DocumentFilter>{ language: 'dts', scheme: 'file' };
    var disposable = vscode.languages.registerDocumentSymbolProvider(selector, engine);
    context.subscriptions.push(disposable);
    disposable = vscode.languages.registerDefinitionProvider([selector, <vscode.DocumentFilter>{ language: 'yaml', scheme: 'file' }], engine);
    context.subscriptions.push(disposable);
    disposable = vscode.languages.registerHoverProvider(selector, engine);
    context.subscriptions.push(disposable);
    disposable = vscode.languages.registerCompletionItemProvider(selector, engine, '&', '#', '<', '"', '\t');
    context.subscriptions.push(disposable);
    disposable = vscode.languages.registerSignatureHelpProvider(selector, engine, '<', ' ');
    context.subscriptions.push(disposable);
    disposable = vscode.languages.registerDocumentRangeFormattingEditProvider(selector, engine);
    context.subscriptions.push(disposable);

    vscode.languages.setLanguageConfiguration('dts',
        <vscode.LanguageConfiguration>{
            wordPattern: /(0x[a-fA-F\d]+|-?\d+|&?[#\w\-,]+)/,
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
        })
}

export function deactivate() {
}