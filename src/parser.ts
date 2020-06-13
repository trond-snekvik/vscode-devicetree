import * as vscode from 'vscode';
import * as fs from 'fs';
import { setFlagsFromString } from 'v8';

type PHandle = {node: string};
type _PHandleArray = (string | number)[];
type PHandleArray = _PHandleArray | _PHandleArray[];
type _PropertyValue = string | number | boolean | PHandle | PHandle[] | PHandleArray[] | number[];
export type PropertyValue = _PropertyValue | _PropertyValue[]; // composite

class Define {
    name: string;
    value: string;
    args?: string[]


    replace(text: string): string {
        if (!this.args) {
            return text
                .replace(new RegExp(`(?<!#)#${this.name}\b`, 'g'), `"${this.value}"`)
                .replace(new RegExp(`\b${this.name}\b`), this.value);
        }

        return text.replace(new RegExp(`\b${this.name}\s*\(([^,]+)${',([^,]*)'.repeat(this.args.length - 1)}\)`), (t: string, ...args: string[]) => {
            let text = this.value;
            this.args.forEach((a, i) => {
                text = text.replace(new RegExp(`(?<!#)#${a}\b`, 'g'), `"${args[i]}"`);
                text = text.replace(new RegExp(`\b${a}\b`), args[i]);

            });

            return text.replace('#', '');
        });
    }

    constructor(name: string, value: string, args?: string[]) {
        this.name = name;
        this.value = value;
        this.args = args;
    }
};

class Line {
    text: string;
    number: number;
    uri: vscode.Uri;
    get location(): vscode.Location {
        return new vscode.Location(this.uri, new vscode.Range(this.number, 0, this.number, this.text.length));
    }

    get length(): number {
        return this.text.length;
    }

    constructor(text: string, number: number, uri: vscode.Uri) {
        this.text = text;
        this.number = number;
        this.uri = uri;
    }
}

type Offset = { line: number, col: number };

class ParserState {
    defines: Define[];
    includes: string[];
    private text: string;
    private offset: Offset;
    private prevMatch: string;
    diags: {uri: vscode.Uri, diags: vscode.Diagnostic[]}[];
    lines: Line[];
    uri: vscode.Uri;

    private pushUriDiag(uri: vscode.Uri, diag: vscode.Diagnostic) {
        var collection = this.diags.find(c => c.uri.fsPath === uri.fsPath);
        if (!collection) {
            collection = {uri: uri, diags: [] };
            this.diags.push(collection);
        }

        collection.diags.push(diag);
        return diag;
    }

    private pushLineDiag(line: Line, message: string, severity: vscode.DiagnosticSeverity=vscode.DiagnosticSeverity.Error, start: number=0, end: number=99999): vscode.Diagnostic {
        return this.pushUriDiag(line.uri, new vscode.Diagnostic(new vscode.Range(line.number, start, line.number, end), message, severity));
    }

    private getPrevMatchLine() {
        if (this.offset.col) {
            return this.lines[this.offset.line];
        }

        if (this.offset.line >= 1) {
            return this.lines[this.offset.line - 1];
        }

        return this.lines[0];
    }

    location() {
        var start: number;
        var end: number;
        var line = this.getPrevMatchLine();

        if (this.offset.col) {
            start = this.offset.col - this.prevMatch.length;
            end = this.offset.col;
        } else if (this.offset.line >= 1) {
            start = this.lines[this.offset.line - 1].length - this.prevMatch.length;
            end = this.lines[this.offset.line - 1].length;
        } else {
            start = 0;
            end = this.lines[0].length;
        }

        return new vscode.Location(line.uri, new vscode.Range(line.number, start, line.number, end));
    }

    pushDiag(message: string, severity: vscode.DiagnosticSeverity=vscode.DiagnosticSeverity.Error): vscode.Diagnostic {
        var loc = this.location();
        return this.pushUriDiag(loc.uri, new vscode.Diagnostic(loc.range, message, severity));
    }

    private replaceDefines(text: string) {
        this.defines.forEach(d => {
            text = d.replace(text);
        });

        return text;
    }

    evaluate(text: string): any {
        text = this.replaceDefines(text);
        return eval(text); // Danger! :(
    }

    private preprocess(): Line[] {
        const genLines = (text: string, uri: vscode.Uri): Line[] => {
            return text.split(/\r?\n/g).map((line, i) => new Line(line, i, uri));
        };

        let rawLines = genLines(this.text, this.uri);
        let lines = new Array<Line>();
        let conditions: boolean[] = [];
        let once = new Array<vscode.Uri>();

        while (rawLines.length) {
            var line = rawLines.splice(0)[0];
            var text = line.text;
            while (text.endsWith('\\') && rawLines.length) {
                text = text.slice(0, text.length) + rawLines.splice(0)[0].text;
            }

            try {
                let directive = text.match(/^\s*#\s*(\w+)\s*(.*)/);
                if (directive) {
                    let value = directive[2].trim();

                    if (directive[1] === 'define') {
                        let define = directive[2].match(/^(\w+)\s*(?:\((.*?)\))?\s+(.*)/);
                        if (!define) {
                            this.pushLineDiag(line, 'Invalid define syntax');
                            continue;
                        }

                        this.defines.push(new Define(define[0], define[2], define[1]?.split(',').map(a => a.trim())));
                    } else if (directive[1] === 'undef') {
                        let undef = value.match(/^\w+/);
                        if (!value) {
                            this.pushLineDiag(line, 'Invalid undef syntax');
                            continue;
                        }

                        this.defines = this.defines.filter(d => d.name !== undef[0]);
                    } else if (directive[1] === 'if') {
                        let condition = this.replaceDefines(directive[2]);
                        condition = condition.replace(new RegExp(`defined\\((.*?)\\)`, 'g'), (t, define) => {
                            return this.defines.some(d => d.name === define) ? '1' : '0';
                        });

                        conditions.push(!!this.evaluate(condition));
                    } else if (directive[1] === 'ifdef') {
                        conditions.push(this.defines.some(d => d.name === value));
                    } else if (directive[1] === 'ifndef') {
                        conditions.push(!this.defines.some(d => d.name === value));
                    } else if (directive[1] === 'else') {
                        if (!conditions.length) {
                            this.pushLineDiag(line, `Unexpected #else`);
                            continue;
                        }

                        conditions[conditions.length - 1] = !conditions[conditions.length - 1];
                    } else if (directive[1] === 'elsif') {
                        if (!conditions.length) {
                            this.pushLineDiag(line, `Unexpected #elsif`);
                            continue;
                        }

                        if (conditions[conditions.length - 1]) {
                            conditions[conditions.length - 1] = false;
                            continue;
                        }

                        let condition = this.replaceDefines(directive[2]);
                        condition = condition.replace(new RegExp(`defined\\((.*?)\\)`, 'g'), (t, define) => {
                            return this.defines.some(d => d.name === define) ? '1' : '0';
                        });

                        conditions[conditions.length - 1] = this.evaluate(condition);
                    } else if (directive[1] === 'endif') {
                        if (!conditions.length) {
                            this.pushLineDiag(line, `Unexpected #elsif`);
                            continue;
                        }

                        conditions.pop();
                    } else if (directive[1] === 'pragma') {
                        if (value === 'once') {
                            if (once.some(uri => uri.fsPath === line.uri.fsPath)) {
                                let lines = rawLines.findIndex(l => l.uri.fsPath !== line.uri.fsPath);
                                if (lines >= 0) {
                                    rawLines.splice(0, lines + 1);
                                }
                                continue;
                            }

                            once.push(line.uri);
                        } else {
                            this.pushLineDiag(line, `Unknown pragma directive "${value}"`)
                        }
                    } else if (directive[1] === 'include') {
                        let include = directive[2].replace(/["<>]/g, '').trim();
                        let file = this.includes.find(i => fs.existsSync(i + '/' + include));
                        if (!file) {
                            this.pushLineDiag(line, `No such file: ${include}`, vscode.DiagnosticSeverity.Warning);
                            continue;
                        }

                        // inject the included file's lines. They will be the next to be processed:
                        rawLines = [...genLines(fs.readFileSync(file, 'utf-8'), vscode.Uri.file(file)), ...rawLines];
                    } else if (directive[1] === 'error') {
                        this.pushLineDiag(line, directive[2] ?? 'Error');
                    }

                    continue;
                }

                if (!conditions.every(c => c)) {
                    continue;
                }

                lines.push(new Line(this.replaceDefines(text), line.number, line.uri));
            } catch (e) {
                this.pushLineDiag(line, 'Crashed: ' + e);
            }
        }

        return lines;
    }

    match(pattern: RegExp): RegExpMatchArray | undefined {
        var match = this.peek(pattern);
        if (match) {
            this.offset.col += match[0].length;
            if (this.offset.col === this.lines[this.offset.line].length) {
                this.offset.col = 0;
                this.offset.line++;
            }

            this.prevMatch = match[0];
        }

        return match;
    }

    skipWhitespace() {
        this.match(/^\s+/);
        return this.text.length > 0;
    }

    skipToken() {
        var match = this.match(/^\S+/);
        if (!match) {
            this.offset.line = this.lines.length;
            return '';
        }

        return match[0];
    }

    peek(pattern: RegExp) {
        if (this.offset.line >= this.lines.length) {
            return undefined;
        }

        return this.lines[this.offset.line].text.slice(this.offset.col).match(pattern);
    }

    freeze(): Offset {
        return { ... this.offset };
    }

    since(state: Offset) {
        return this.lines.slice(state.line, this.offset.line).map((l, i) => {
            var start = 0;
            var end = l.length;

            if (i === this.offset.line - state.line) {
                if (i === 0) {
                    return l.text.slice(state.col, this.offset.col);
                }

                return l.text.slice(0, this.offset.col);
            }

            if (i === 0) {
                return l.text.slice(state.col);
            }

            return l.text;
        }).join('\n');
    }

    constructor(text: string, uri: vscode.Uri, defines: Define[]=[], includes: string[]=[]) {
        this.text = text;
        this.defines = defines;
        this.includes = includes;
        this.uri = uri;
        this.diags = [];
        this.offset = {line: 0, col: 0};
        this.lines = this.preprocess();
    }
}

function parsePropValue(state: ParserState) {
    var elems: _PropertyValue[] = [];

    while (state.skipWhitespace()) {
        if (elems.length > 0) {
            if (!state.match(/^,\s*/)) {
                state.pushDiag(`Expected , or ;`);
            }
        }

        var phandle = state.match(/^<\s*&([\w\-]+)\s*>/);
        if (phandle) {
            elems.push(<PHandle>{node: phandle[1]});
            continue;
        }

        var reference = state.match(/^&([\w\-]+)/);
        if (reference) {
            elems.push(<PHandle>{node: reference[1]});
            continue;
        }

        var string = state.match(/^"(.*?)"/);
        if (string) {
            elems.push(string[1]);
            continue;
        }

        var number = state.match(/^<\s*(\d+|0x[\da-fA-F]+)\s*>/);
        if (number) {
            elems.push(parseInt(number[1]));
            continue;
        }

        var numberArray = state.match(/^<\s*((?:(?:\d+|0x[\da-fA-F]+)\s+)*(?:\d+|0x[\da-fA-F]+))\s*>/);
        if (numberArray) {
            var parts = (numberArray[1] as string).split(/\s+/);
            elems.push(parts.map(p => parseInt(p)));
            continue;
        }

        var phandles = state.match(/^<\s*((?:&[\w\-]+\s+)+&[\w\-]+)\s*>/);
        if (phandles) {
            elems.push((phandles[1] as string).split(/\s+/).map(h => { return <PHandle>{ node: h.slice(1) }; }));
            continue;
        }

        var phandleArray = state.match(/^</);
        if (phandleArray) {
            var values: _PHandleArray = [];
            while (state.skipWhitespace()) {
                var m = state.match(/^(0x[\da-fA-F]+|\d+)/);
                if (m) {
                    values.push(parseInt(m[0] as string));
                    continue;
                }

                m = state.match(/^&[\w\-]+/);
                if (m) {
                    values.push(m[0]);
                    continue;
                }

                m = state.match(/^\(/);
                if (m) {
                    var level = 1;
                    var text = '(';
                    while (level !== 0) {
                        m = state.match(/(?:(?:<<|>>|&&|\|\||[!=<>]=|[|&~^<>!=+\-\/*]|\s*|0x[\da-fA-F]+|\d+)\s*)*([()])/);
                        if (!m) {
                            state.pushDiag(`Unterminated expression`);
                            break;
                        }
                        text += m[0];
                        if (m[1] === '(') {
                            level++;
                        } else {
                            level--;
                        }
                    }
                    try {
                        var num = eval(text) as number | undefined;
                        if (num !== undefined) {
                            values.push(num);
                        }
                    } catch (e) {
                        state.pushDiag(`Unable to evaluate expression`);
                    }
                    continue;
                }
                m = state.match(/^>/);
                if (m) {
                    break;
                }

                var unexpectedToken = state.skipToken();
                state.pushDiag(`Unexpected token`);
                if (unexpectedToken === ';') {
                    break;
                }
            }
            elems.push(values as _PropertyValue);
            continue;
        }

        var byteArray = state.match(/^\[\s*((?:[\da-fA-F]{2}\s*)+)\]/);
        if (byteArray) {
            elems.push((byteArray[1] as string).match(/\S{2}/).map(c => parseInt(c, 16)));
            continue;
        }

        if (state.peek(/^;/)) {
            break;
        }

        state.skipToken();
        state.pushDiag(`Unexpected token in property value`);
    }

    if (elems.length === 1) {
        return elems[0];
    }

    if (elems.length === 0) {
        this.pushDiag(`Expected property value`);
    }

    return elems;
}

export class Property {
    name: string;
    labels?: string[];
    value: {value: PropertyValue, raw: string};
    loc: vscode.Location;

    constructor(name: string, loc: vscode.Location, state: ParserState, labels?: string[]) {
        this.name = name;
        this.loc = loc;
        this.labels = labels;


        state.skipWhitespace();
        var start = state.freeze();
        var value = parsePropValue(state);
        if (value) {
            this.value = {value: value, raw: state.since(start)};
        } else {
            this.value = {value: true, raw: ''};
        }
    }

    toString(): string {
        if (this.value === undefined) {
            return `${this.name} = ?`;
        }

        if (this.value.value === true) {
            return `${this.name}`
        }

        return `${this.name} = ${this.value.raw}`;
    }
};

export class OffsetRange {
    doc: vscode.TextDocument;
    start: number;
    length: number;

    constructor(doc: vscode.TextDocument, start: number, length?: number) {
        this.doc = doc;
        this.start = start;
        this.length = length || 0;
    }

    toRange(): vscode.Range {
        return new vscode.Range(this.doc.positionAt(this.start), this.doc.positionAt(this.start + this.length));
    }

    contains(pos: vscode.Position, doc: vscode.TextDocument) {
        return this.doc.uri.fsPath === doc.uri.fsPath && this.toRange().contains(pos);
    }

    containsRange(r: OffsetRange) {
        return this.doc.uri.fsPath === r.doc.uri.fsPath && this.start <= r.start && ((this.start + this.length) >= (r.start + r.length));
    }

    extendTo(offset: number) {
        this.length = offset - this.start;
    }
}

export class NodeEntry {
    node: Node;
    children: NodeEntry[];
    properties: Property[];
    labels: string[];
    ref?: string;
    range: OffsetRange;
    nameRange: OffsetRange;

    constructor(range: OffsetRange, node: Node, nameRange: OffsetRange) {
        this.node = node;
        this.children = [];
        this.properties = [];
        this.range = range;
        this.nameRange = nameRange;
        this.labels = [];
    }
}

export class Node {
    name: string;
    fullName: string;
    deleted: boolean;
    parent?: Node;
    path: string;
    address?: number;
    entries: NodeEntry[];

    constructor(name: string, address?: string, parent?: Node) {
        if (address) {
            this.fullName = name + '@' + address;
        } else {
            this.fullName = name;
        }
        if (parent) {
            this.path = parent.path + this.fullName + '/';
        } else {
            this.path = this.fullName;
        }
        this.parent = parent;
        if (address) {
            this.address = parseInt(address, 16);
        }

        this.name = name;
        this.deleted = false;
        this.entries = [];
    }

    enabled(): boolean {
        var status = this.property('status');
        return !status || (status.value.value === 'okay');
    }

    hasLabel(label: string) {
        return !!this.entries.find(e => e.labels.indexOf(label) != -1);
    }

    children(): Node[] {
        var children: Node[] = [];
        this.entries.forEach(e => children.push(...e.children.map(c => c.node)));
        return children;
    }

    labels(): string[] {
        var labels: string[] = [];
        this.entries.forEach(e => labels.push(...e.labels));
        return labels;
    }

    properties(): Property[] {
        var props: Property[] = [];
        this.entries.forEach(e => props.push(...e.properties));
        return props;
    }

    property(name: string): Property | undefined {
        var prop: Property = undefined;
        // use the last found entry (this is the one that counts according to DTS):
        this.entries.forEach(e => {
            prop = e.properties.find(e => e.name === name);
        });

        return prop ?? undefined;
    }

    uniqueProperties(): Property[] {
        var props = this.properties();
        return props.filter((p, i) => i > props.findIndex(pp => p != pp && p.name === pp.name));
    }
};

export class Parser {

    nodes: {[fullPath: string]: Node};
    root?: Node;
    docs: { [path: string]: {version: number, topLevelEntries: NodeEntry[], diags: vscode.Diagnostic[] }};

    constructor() {
        this.nodes = {};
        this.docs = {};
    }

    nodeArray() {
        return Object.keys(this.nodes).map(k => this.nodes[k]);
    }

    cleanFile(doc: vscode.TextDocument) {
        this.nodeArray().forEach(n => {
            n.entries = n.entries.filter(e => e.range.doc.uri.fsPath !== doc.uri.fsPath);
        });
    }

    editFile(edits: vscode.TextDocumentContentChangeEvent[], doc: vscode.TextDocument) {
        /* TODO: This function is incomplete, and might be abandoned.
         * Reparsing a whole 50 entry document takes about 50ms on a shitty laptop, which is probably just as fast...
         */

        /* This algorithm needs an explanation:
         *
         * There are a set of text edits with ranges that are being replaced by new text.
         * We'll collect the offset each edit makes, and mark the position where that change happens. Note that the offset
         * is negative if we deleted text.
         *
         * Then, we'll go through the entries, and calculate the total delta at their position, by accumulating
         * all the delta up until there. We'll add this to their start positions.
         * But HOLD ON, the edits are ranges and not positions! Therefore, we'll only do this
         * with entires that don't overlap with any edits, then mark all the ones that do as "changed".
         *
         * The changed entries will be deleted and reparsed.
         */
        var offsets = edits.map(e => { return { position: doc.offsetAt(e.range.start), offset: e.text.length - e.rangeLength }; }).sort((a, b) => a.position - b.position);

        var offsetAt = (offset: number) => {
            var offset = 0;
            offsets.find(d => {
                if (d.position > offset) {
                    return true;
                }
                offset += d.offset;
                return false;
            });

            return offset;
        };


        var changed: NodeEntry[] = [];
        this.nodeArray().forEach(n => {
            n.entries.filter(e => e.range.doc.uri.fsPath === doc.uri.fsPath).forEach(entry => {
                if (edits.find(edit => entry.range.toRange().intersection(edit.range))) {
                    changed.push(entry);
                } else {
                    entry.range.start += offsetAt(entry.range.start);
                }
            });
        });

        // todo: do something with the changed entries.
    }

    parse(text: string, doc: vscode.TextDocument, documentVersion?: number, diags: vscode.Diagnostic[]=[]): NodeEntry[] {
        if (documentVersion !== undefined) {
            if (this.docs[doc.uri.fsPath] && this.docs[doc.uri.fsPath].version === documentVersion) {
                diags.push(...this.docs[doc.uri.fsPath].diags);
                return this.docs[doc.uri.fsPath].topLevelEntries; /* No need to reparse */
            }
            this.docs[doc.uri.fsPath] = {version: documentVersion, topLevelEntries: [], diags: []};
        }
        var timeStart = process.hrtime();
        this.cleanFile(doc);
        var state = new ParserState(text, doc.uri);
        var nodeStack: NodeEntry[] = [];
        var requireSemicolon = false;
        while (state.skipWhitespace()) {
            var blockComment = state.match(/^\/\*[\s\S]*?\*\//);
            if (blockComment) {
                continue;
            }

            var comment = state.match(/^\/\/.*/);
            if (comment) {
                continue;
            }

            if (requireSemicolon) {
                var token = state.match(/^[^;]+/);
                if (token) {
                    state.pushDiag('Expected semicolon');
                    continue;
                }
                var token = state.match(/^;/);
                if (token) {
                    requireSemicolon = false;
                }
                continue;
            }

            var versionDirective = state.match(/^\/dts-v.+?\/\s*/);
            if (versionDirective) {
                requireSemicolon = true;
                continue;
            }

            var deleteNode = state.match(/^\/delete-node\//);
            if (deleteNode) {
                state.skipWhitespace();
                requireSemicolon = true;

                let node = state.match(/^(&?)([\w,\._+\-]+)/);
                if (!node) {
                    state.pushDiag(`Expected node`);
                    continue;
                }

                var n = this.nodeArray().find(n => (node[1] ? (n.labels().indexOf(node[2]) !== -1) : (node[2] === n.name)));
                if (n) {
                    n.deleted = true;
                } else {
                    state.pushDiag(`Unknown node`, vscode.DiagnosticSeverity.Warning);
                }
                continue;
            }

            var deleteProp = state.match(/^\/delete-property\//);
            if (deleteProp) {
                state.skipWhitespace();
                requireSemicolon = true;

                var prop = state.match(/^[#?\w,\._+\-]+/);
                if (!prop) {
                    state.pushDiag('Expected property');
                    continue;
                }

                if (!nodeStack.length) {
                    state.pushDiag(`Can only delete properties inside a node`);
                    continue;
                }

                var props = nodeStack[nodeStack.length-1]?.node.properties();
                if (!props) {
                    continue;
                }
                var p = props.find(p => p.name === deleteProp[0]);
                if (!p) {
                    diags.push(new vscode.Diagnostic(new OffsetRange(doc, offset + deleteProp[1].length, deleteProp[0].length).toRange(), `Unknown property ${deleteProp[0]}`, vscode.DiagnosticSeverity.Warning));
                    continue;
                }

                continue;
            }

            var rootMatch = state.match(/^\/\s*{/);
            if (rootMatch) {
                if (!this.root) {
                    this.root = new Node('/');
                    this.nodes['/'] = this.root;
                }
                var entry = new NodeEntry(new OffsetRange(doc, offset, rootMatch[0].length), this.root, new OffsetRange(doc, offset, 1));
                this.root.entries.push(entry);
                this.docs[doc.uri.fsPath].topLevelEntries.push(entry);
                nodeStack.push(entry);
                continue;
            }

            var nodeMatch = state.match(/^((?:[\w\-]+:\s+)*)([\w,\._+\-]+)(?:@([\da-fA-F]+))?\s*{/);
            if (nodeMatch) {

                var node = new Node(nodeMatch[2],
                    nodeMatch[3],
                    nodeStack.length > 0 ? nodeStack[nodeStack.length - 1].node : undefined);

                if (this.nodes[node.path]) {
                    node = this.nodes[node.path];
                } else {
                    this.nodes[node.path] = node;
                }

                var labels = nodeMatch[1].split(':').map(l => l.trim()).filter(l => l.length > 0);
                // find existing alias for this node:
                var existingNode: Node;
                labels.find(l => {
                    existingNode = this.nodes['&' + l];
                    return !!existingNode;
                });

                if (existingNode) {
                    node.entries.push(...existingNode.entries);
                    delete this.nodes[existingNode.name];
                }

                var entry = new NodeEntry(
                    new OffsetRange(doc, offset, nodeMatch[0].length),
                    node,
                    new OffsetRange(doc,
                        offset + (nodeMatch[1] ? nodeMatch[1].length : 0),
                        nodeMatch[2].length + (nodeMatch[3] ? nodeMatch[3].length + 1 : 0)));

                entry.labels.push(...labels);
                node.entries.push(entry);

                if (nodeStack.length === 0) {
                    this.docs[doc.uri.fsPath].topLevelEntries.push(entry);
                }

                if (nodeStack[nodeStack.length - 1].children.indexOf(entry) === -1) {
                    nodeStack[nodeStack.length - 1].children.push(entry);
                }
                nodeStack.push(entry);

                if (nodeMatch[3] && nodeMatch[3].length > 1 && nodeMatch[3].startsWith('0')) {
                    diags.push(new vscode.Diagnostic(entry.nameRange.toRange(), `Address should not start with leading 0's`, vscode.DiagnosticSeverity.Warning));
                }
                continue;
            }

            var nodeRefMatch = state.match(/^((?:[\w\-]+:\s+)*)(&[\w\-]+)\s*{/);
            if (nodeRefMatch) {
                var node = this.getNode(nodeRefMatch[2]);
                if (!node) {
                    diags.push(new vscode.Diagnostic(new OffsetRange(doc, offset + nodeRefMatch[1].length, nodeRefMatch[2].length).toRange(), `Unknown label ${nodeRefMatch[2]}`, vscode.DiagnosticSeverity.Error));
                    node = new Node(nodeRefMatch[2]);
                    this.nodes[node.name] = node;
                }

                var entry = new NodeEntry(
                    new OffsetRange(doc, offset, nodeRefMatch[0].length),
                    node,
                    new OffsetRange(doc, offset + (nodeRefMatch[1] ? nodeRefMatch[1].length : 0), nodeRefMatch[2].length));
                entry.labels.push(...nodeRefMatch[1].split(':').map(l => l.trim()).filter(l => l.length > 0));
                node.entries.push(entry);
                entry.ref = nodeRefMatch[2];
                if (nodeStack.length === 0) {
                    this.docs[doc.uri.fsPath].topLevelEntries.push(entry);
                }
                nodeStack.push(entry);
                continue;
            }


            var preprocessorDirective = state.match(/^#(include|define|include_next|if|else|endif)\b.*?[^\\]\r?\n/);
            if (preprocessorDirective) {
                diags.push(new vscode.Diagnostic(new OffsetRange(doc, offset, preprocessorDirective[0].length).toRange(), `C preprocessor directives are not supported`, vscode.DiagnosticSeverity.Warning));
                continue;
            }

            var propMatch = state.match(/^((?:[\w\-]+:\s+)*)([#?\w,\._+\-]+)(?:\s*=\s*([^;{}]+))?\s*/);
            if (propMatch) {
                if (nodeStack.length > 0) {
                    var p = new Property(
                        propMatch[2],
                        new OffsetRange(doc, offset, propMatch[0].length),
                        propMatch[1] ? propMatch[1].split(':').map(l => l.trim()) : [],
                        propMatch[3],
                        diags);
                    nodeStack[nodeStack.length - 1].properties.push(p);
                } else {
                    diags.push(new vscode.Diagnostic(new OffsetRange(doc, offset, propMatch[0].length).toRange(), `Property outside of node context`, vscode.DiagnosticSeverity.Error));
                }
                requireSemicolon = true;
                continue;
            }
            var closingBrace = state.match(/^}/);
            if (closingBrace) {
                if (nodeStack.length > 0) {
                    var entry = nodeStack.pop();
                    entry.range.extendTo(offset + closingBrace.length);
                } else {
                    diags.push(new vscode.Diagnostic(new OffsetRange(doc, offset, closingBrace[0].length).toRange(), `Unexpected closing bracket`, vscode.DiagnosticSeverity.Error));
                }
                requireSemicolon = true;
                continue;
            }

            var unexpectedToken = state.skipToken();
            diags.push(new vscode.Diagnostic(new OffsetRange(doc, offset, unexpectedToken.length).toRange(), `Unexpected token ${unexpectedToken}`, vscode.DiagnosticSeverity.Error));
        }

        if (nodeStack.length > 0) {
            nodeStack[nodeStack.length - 1].range.extendTo(state.offset);
            console.error(`Unterminated node: ${nodeStack[nodeStack.length - 1].node.name}`);
            diags.push(new vscode.Diagnostic(nodeStack[nodeStack.length - 1].nameRange.toRange(), `Unterminated node ${nodeStack[nodeStack.length - 1].node.name}`, vscode.DiagnosticSeverity.Error));
        }

        var procTime = process.hrtime(timeStart);

        console.log(`Parsed ${doc.uri.fsPath} in ${(procTime[0] * 1e9 + procTime[1]) / 1000000} ms`);

        this.docs[doc.uri.fsPath].diags = [...diags];
        return this.docs[doc.uri.fsPath].topLevelEntries;
    }

    getNode(search: string): Node | undefined {
        if (search.startsWith('&')) {
            var label = search.slice(1);
            var node = this.nodeArray().find(n => n.labels().indexOf(label) !== -1);
            if (node) {
                return this.nodes[node.path];
            }
        }

        if (search.endsWith('/')) {
            return this.nodes[search];
        }

        return this.nodes[search + '/'];
    }

    getNodeAt(pos: vscode.Position, doc: vscode.TextDocument): Node | undefined {
        var allNodes = this.nodeArray().filter(n => n.entries.find(e => e.range.contains(pos, doc)));
        if (allNodes.length === 0) {
            return undefined;
        }
        /* When multiple nodes are matching, they extend each other,
         * and the one with the longest path is the innermost child.
         */
        return allNodes.sort((a, b) => b.path.length - a.path.length)[0];
    }

    getPropertyAt(pos: vscode.Position, doc: vscode.TextDocument): [Node, Property] | undefined {
        var node = this.getNodeAt(pos, doc);

        var prop = node?.properties().find(p => p.range.doc.uri.fsPath === doc.uri.fsPath && p.range.toRange().contains(pos));
        if (prop) {
            return [node, prop];
        }
    }

    getPHandleNode(handle: number | string): Node {
        if (typeof handle === 'number') {
            return this.nodeArray().find(n => n.properties().find(p => p.name === 'phandle' && p.value.value === handle));
        } else if (typeof handle === 'string') {
            return this.nodeArray().find(n => n.labels().find(p => p === handle));
        }
    }
}