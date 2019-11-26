'use strict';
import * as vscode from 'vscode';
import * as parser from './parser';
import * as types from './types';



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

class DTSEngine implements vscode.DocumentSymbolProvider, vscode.DefinitionProvider, vscode.HoverProvider, vscode.CompletionItemProvider {
    parser: parser.Parser;
    diags: vscode.DiagnosticCollection;
    types: types.TypeLoader;

    constructor(context: vscode.ExtensionContext) {
        this.parser = new parser.Parser();
        this.types = new types.TypeLoader();
        this.diags = vscode.languages.createDiagnosticCollection('Devicetree');
        vscode.workspace.workspaceFolders.forEach(f => this.types.addFolder(f.uri.fsPath + '/dts/bindings'));

        this.parseDoc(vscode.window.activeTextEditor.document);
        context.subscriptions.push(vscode.window.onDidChangeActiveTextEditor(editor => this.parseDoc(editor.document)));
        context.subscriptions.push(vscode.workspace.onDidOpenTextDocument(doc => this.parseDoc(doc)));
        context.subscriptions.push(vscode.workspace.onDidChangeTextDocument(change => this.parseDoc(change.document)));
    }

    parseDoc(doc: vscode.TextDocument) {
        if (doc.languageId !== 'dts') {
            return;
        }

        var topLevelEntries = this.parser.parse(doc.getText(), doc, doc.version);

        var diags: vscode.Diagnostic[] = [];

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

                        if (prop.name === 'reg') {
                            if (node.parent) {
                                var parentProps = node.parent.properties();
                                var sizeCells = parentProps.find(p => p.name === '#size-cells');
                                var addressCells = parentProps.find(p => p.name === '#address-cells');
                                if (sizeCells && addressCells && typeof sizeCells.value.value === 'number' && typeof addressCells.value.value === 'number') {
                                    if ((typeof prop.value.value === 'number' && sizeCells.value.value + addressCells.value.value !== 1) ||
                                        (Array.isArray(prop.value.value) && prop.value.value.length !== sizeCells.value.value + addressCells.value.value)) {
                                        diags.push(new vscode.Diagnostic(
                                            prop.range.toRange(),
                                            `reg property must be on format <${Array(addressCells.value.value).fill('address').join(' ')} ${Array(sizeCells.value.value).fill('size').join(' ')}>`,
                                            vscode.DiagnosticSeverity.Error));
                                    }
                                } else {
                                    diags.push(new vscode.Diagnostic(
                                        prop.range.toRange(),
                                        `Unknown reg property format: Should be defined by parent's #size-cells and #address-cells properties`,
                                        vscode.DiagnosticSeverity.Warning));
                                }
                            } else {
                                diags.push(new vscode.Diagnostic(
                                    prop.range.toRange(),
                                    `Unknown reg property format: No parent`,
                                    vscode.DiagnosticSeverity.Warning));
                            }
                        } else if (propType.type === 'phandle-array' && Array.isArray(prop.value.value)) {
                            var cells = getPHandleCells(prop.name, node.parent);
                            if (cells) {
                                var value = cells.value.value as (string | number)[];
                                if (typeof cells.value.value === 'number') {
                                    if ((value.length % (cells.value.value + 1)) !== 0) {
                                        diags.push(new vscode.Diagnostic(prop.range.toRange(), `PHandle array must have ${cells.value.value} number cells`, vscode.DiagnosticSeverity.Error));
                                    }
                                } else {
                                    diags.push(new vscode.Diagnostic(prop.range.toRange(), `Parent's *-cells property must be an int`, vscode.DiagnosticSeverity.Error));
                                }
                            }
                        }
                    }
                } else if (propType.required) {
                    var status = props.find(p => p.name === 'status');
                    diags.push(new vscode.Diagnostic(entry.nameRange.toRange(), `Property ${propType.name} is required`, (status && status.value.raw === 'okay') ? vscode.DiagnosticSeverity.Error : vscode.DiagnosticSeverity.Information));
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

    getDefinition(document: vscode.TextDocument, position: vscode.Position): [vscode.Range, parser.Node] | undefined {
        var word = document.getWordRangeAtPosition(position, /&[\w\-]+/);
        if (!word) {
            return;
        }
        var symbol = document.getText(word);
        if (symbol.startsWith('&')) { // label
            return [word, this.parser.getNode(symbol)];
        }
    }

    provideHover(document: vscode.TextDocument, position: vscode.Position, token: vscode.CancellationToken): vscode.ProviderResult<vscode.Hover> {
        // hover alias
        var bundle = this.getDefinition(document, position);
        if (bundle) {
            var node = bundle[1];

            var expanded = `${node.fullName} {`;

            expanded += node.uniqueProperties().map(p => `\n\t${p.toString()};`).join('');
            expanded += node.children().map(c => `\n\t${c.name} = { /* ... */ };`).join('');
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
        var bundle = this.getDefinition(document, position);
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

        if (symbol) { // potential compatible-string
            var property = this.parser.getPropertyAt(position, document);
            if (property && property[1].name === 'compatible') {
                var type = this.types.get(symbol.slice(1, symbol.length - 1));
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
        if (!node) {
            var root = new vscode.CompletionItem('/', vscode.CompletionItemKind.Class);
            root.insertText = new vscode.SnippetString('/ {\n\t');
            root.insertText.appendTabstop();
            root.insertText.appendText('\n};\n');
            root.detail = 'root node';
            root.documentation = 'The devicetree has a single root node of which all other device nodes are descendants. The full path to the root node is /.';
            root.preselect = true;

            var labels: {label: string, node: parser.Node, type?: types.NodeType}[] = [];
            Object.keys(this.parser.nodes).forEach(name => {
                var node = this.parser.nodes[name];
                var t = this.types.get(node.name);
                labels.push(...node.labels().map(l => {return {label: l, node: node, type: t}; }));
            });
            return [root, ...labels.map(l => {
                var completion = new vscode.CompletionItem(`&${l.label}`, vscode.CompletionItemKind.Class);
                completion.insertText = new vscode.SnippetString(completion.label + ' {\n\t');
                completion.insertText.appendTabstop();
                completion.insertText.appendText('\n};\n');
                completion.detail = l.node.path;
                if (l.type) {
                    completion.documentation = new vscode.MarkdownString(`**${l.type.title}**\n\n${l.type.description}`);
                }
                return completion;
            })];
        }

        var lineRange = new vscode.Range(position.line, 0, position.line, 999999);
        var line = document.getText(lineRange);
        // var indent =
        // var replaceRange: vscode.Range;
        // if (line.indexOf('{') >= 0) {
        //     // replace the entire node
        //     var text = document.getText(new vscode.Range(position.line, 0, position.line + 200, 0));
        //     var match;
        //     var level = 0;
        //     var length = 0;
        //     while (match = text.match(/^.*?([{}])/)) {
        //         if (match[1] === '{') {
        //             level++;
        //         } else {
        //             level--;
        //         }
        //         length += match[0].length;
        //         text = text.slice(match[0].length);

        //         if (level === 0) {
        //             match = text.match(/.*?;/);
        //             length += match ? match[0].length : 0;
        //             break;
        //         }
        //     }
        //     replaceRange = new vscode.Range(lineRange.start, document.positionAt(document.offsetAt(lineRange.start) + length));
        // } else {
        //     replaceRange = lineRange;
        // }

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
                    start = line.indexOf(braces[0], line.indexOf('=')) + 1;
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

            return [];
        }

        var appendPropSnippet = (p: types.PropertyType, parent: parser.Node, parentType: types.NodeType, snippet: vscode.SnippetString) => {
            switch (p.type) {
                case 'boolean':
                    snippet.appendText(p.name);
                    break;
                case 'array':
                    snippet.appendText(p.name + ' = <');
                    if (p.name === 'reg' && parent) {
                        var addrCells = parent.properties().find(p => p.name === '#address-cells');
                        var sizeCells = parent.properties().find(p => p.name === '#size-cells');

                        var args = Array((addrCells ? <number>addrCells.value.value : 0)).fill('addr').concat(
                                    Array((sizeCells ? <number>sizeCells.value.value : 0)).fill('size'));

                        for (var i = 0; i < args.length; i++) {
                            snippet.appendPlaceholder(args[i]);
                            if (i !== args.length - 1) {
                                snippet.appendText(' ');
                            }
                        }
                    } else {
                        snippet.appendTabstop();
                    }
                    snippet.appendText('>');
                    break;
                case 'int':
                    snippet.appendText(p.name + ' = <');
                    if (p.default) {
                        snippet.appendPlaceholder(p.default.toString());
                    } else if (p.const) {
                        snippet.appendText(p.const.toString());
                    } else if (p.enum) {
                        snippet.appendPlaceholder(p.enum[0]);
                    } else {
                        snippet.appendTabstop();
                    }
                    snippet.appendText('>')
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
                    snippet.appendText(p.name + ' = <');
                    snippet.appendPlaceholder('&label');
                    snippet.appendText('>')
                    break;
                case 'phandle-array':
                    snippet.appendText(p.name + ' = <&');
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
                    snippet.appendText('>')
                    break;
                case 'uint8-array':
                    snippet.appendText(p.name + ' = [');
                    snippet.appendTabstop();
                    snippet.appendText(']')
                    break;
                case 'compound':
                    snippet.appendText(p.name + ' = ');
                    snippet.appendTabstop();
                    break;
            }

            snippet.appendText(';')
        };

        var propCompletions = type.properties.map(p => {
            var completion = new vscode.CompletionItem(p.name, vscode.CompletionItemKind.Property);
            completion.detail = Array.isArray(p.type) ? p.type[0] : p.type;
            completion.documentation = p.description;
            if (p.name === 'compatible') {
                completion.kind = vscode.CompletionItemKind.TypeParameter;
            }

            completion.insertText = new vscode.SnippetString();
            appendPropSnippet(p, node.parent, parentType, completion.insertText);
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
            type['child-binding'].properties.filter(p => p.required).forEach(p => {
                (<vscode.SnippetString>anyNode.insertText).appendText(`\t`);
                appendPropSnippet(p, node, type, <vscode.SnippetString>anyNode.insertText);
                (<vscode.SnippetString>anyNode.insertText).appendText(`\n`);
            });

        } else {
            anyNode.insertText.appendText(' {\n\tcompatible = "');
            anyNode.insertText.appendTabstop();
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
}

export function activate(context: vscode.ExtensionContext) {
    var engine = new DTSEngine(context);
    const selector = <vscode.DocumentSelector>{ language: 'dts', scheme: 'file' };
    var disposable = vscode.languages.registerDocumentSymbolProvider(selector, engine);
    context.subscriptions.push(disposable);
    disposable = vscode.languages.registerDefinitionProvider(selector, engine);
    context.subscriptions.push(disposable);
    disposable = vscode.languages.registerHoverProvider(selector, engine);
    context.subscriptions.push(disposable);
    disposable = vscode.languages.registerCompletionItemProvider(selector, engine, '&', '#', '<', '"', '\t');
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