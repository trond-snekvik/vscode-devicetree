import * as vscode from 'vscode';


type PHandle = {node: string};
type _PHandleArray = (string | number)[];
type PHandleArray = _PHandleArray | _PHandleArray[];
type _PropertyValue = string | number | boolean | PHandle | PHandle[] | PHandleArray[] | number[];
export type PropertyValue = _PropertyValue | _PropertyValue[]; // composite

function parsePropValue(value: string) {
    var match: RegExpMatchArray;
    var elems: _PropertyValue[] = [];

    var matcher = new RegExp(/(".*?"|<.*?>|\[.*?\])(?=\s*(?:,|$))/g);

    while (match = matcher.exec(value)) {
        var e = match[1];
        var phandle = e.match(/^<\s*&([\w\-]+)\s*>/);
        if (phandle) {
            elems.push(<PHandle>{node: phandle[1]});
            continue;
        }

        var string = e.match(/^"(.*?)"/);
        if (string) {
            elems.push(string[1]);
            continue;
        }

        var number = e.match(/^<\s*(\d+|0x[\da-fA-F]+)\s*>/);
        if (number) {
            elems.push(parseInt(number[1]));
            continue;
        }

        var numberArray = e.match(/^<\s*((?:(?:\d+|0x[\da-fA-F]+)\s+)*(?:\d+|0x[\da-fA-F]+))\s*>/);
        if (numberArray) {
            var parts = (numberArray[1] as string).split(/\s+/);
            elems.push(parts.map(p => parseInt(p)));
            continue;
        }

        var phandles = e.match(/^<\s*((?:&[\w\-]+\s+)+&[\w\-]+)\s*>/);
        if (phandles) {
            elems.push((phandles[1] as string).split(/\s+/).map(h => { return <PHandle>{ node: h.slice(1) }; }));
            continue;
        }

        var phandleArray = e.match(/^<\s*(.+)\s*>/);
        if (phandleArray) {
            var state = new ParserState(phandleArray[1]);
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
                        m = state.match(/(?:(?:<<|>>|&&|\|\||[!=<>]=|[<>!=+\-\/*]|\s*|0x[\da-fA-F]+|\d+)\s*)*([()])/);
                        if (!m) {
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
                        // pass
                    }
                    continue;
                }
                break;
            }
            elems.push(values as _PropertyValue);
            continue;
        }

        var byteArray = e.match(/^\[\s*((?:[\da-fA-F]{2}\s*)+)\]/);
        if (byteArray) {
            elems.push((byteArray[1] as string).match(/\S{2}/).map(c => parseInt(c, 16)));
            continue;
        }

        console.error(`Unknown property value ${e}`);
    }

    if (elems.length === 1) {
        return elems[0];
    }

    return elems;
}

export class Property {
    name: string;
    labels?: string[];
    value: {value: PropertyValue, raw: string};
    range: OffsetRange;

    constructor(name: string, range: OffsetRange, labels?: string[], value?: string) {
        this.name = name;
        this.range = range;
        this.labels = labels;
        this.value = value ? {value: parsePropValue(value), raw: value} : {value: true, raw: ''};
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

    extendTo(offset: number) {
        this.length = offset - this.start;
    }
}

export class NodeEntry {
    node: Node;
    children: NodeEntry[];
    properties: Property[];
    labels: string[];
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
        this.address = parseInt(address, 16);
        this.name = name;
        this.deleted = false;
        this.entries = [];
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

    uniqueProperties(): Property[] {
        var props = this.properties();
        return props.filter((p, i) => i > props.findIndex(pp => p != pp && p.name === pp.name));
    }
};

class ParserState {
    text: string;
    offset: number;

    match(pattern: RegExp): RegExpMatchArray | undefined {
        var match = this.text.match(pattern);
        if (match) {
            this.text = this.text.slice(match[0].length);
            this.offset += match[0].length;
        }
        return match;
    }

    skipWhitespace() {
        this.match(/^\s+/);
        return this.text.length > 0;
    }

    skipToken() {
        var match = this.match(/^\S+/);
        console.error(`Unknown token ${match ? match[0] : this.text}`);
        if (!match) {
            this.offset += this.text.length;
            this.text = '';
        }
    }

    constructor(text: string) {
        this.text = text;
        this.offset = 0;
    }
}

export class Parser {

    nodes: {[fullPath: string]: Node};
    root?: Node;
    docs: { [path: string]: {version: number, topLevelEntries: NodeEntry[] }};

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

    parse(text: string, doc: vscode.TextDocument, documentVersion?: number): NodeEntry[] {
        if (documentVersion !== undefined) {
            if (this.docs[doc.uri.fsPath] && this.docs[doc.uri.fsPath].version === documentVersion) {
                return this.docs[doc.uri.fsPath].topLevelEntries; /* No need to reparse */
            }
            this.docs[doc.uri.fsPath] = {version: documentVersion, topLevelEntries: []};
        }

        var timeStart = process.hrtime();
        this.cleanFile(doc);
        var state = new ParserState(text);
        var nodeStack: NodeEntry[] = [];
        while (state.skipWhitespace()) {
            var offset = state.offset;
            var blockComment = state.match(/^\/\*[\s\S]*?\*\//);
            if (blockComment) {
                continue;
            }

            var comment = state.match(/^\/\/.*/);
            if (comment) {
                continue;
            }

            var versionDirective = state.match(/^\/dts-v.+?\/\s*;?/);
            if (versionDirective) {
                continue;
            }

            var deleteNode = state.match(/^\/delete-node\/\s+(&?)([\w,\._+\-]+);/);
            if (deleteNode) {
                var n = this.nodeArray().find(n => (deleteNode[1] ? (n.labels().indexOf(deleteNode[2]) !== -1) : (deleteNode[2] === n.name)));
                if (n) {
                    n.deleted = true;
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

                var entry = new NodeEntry(
                    new OffsetRange(doc, offset, nodeMatch[0].length),
                    node,
                    new OffsetRange(doc,
                        offset + (nodeMatch[1] ? nodeMatch[1].length : 0),
                        nodeMatch[2].length + (nodeMatch[3] ? nodeMatch[3].length + 1 : 0)));

                entry.labels.push(...nodeMatch[1].split(':').map(l => l.trim()).filter(l => l.length > 0));
                node.entries.push(entry);

                if (nodeStack.length === 0) {
                    this.docs[doc.uri.fsPath].topLevelEntries.push(entry);
                }

                if (nodeStack[nodeStack.length - 1].children.indexOf(entry) === -1) {
                    nodeStack[nodeStack.length - 1].children.push(entry);
                }
                nodeStack.push(entry);
                continue;
            }

            var nodeRefMatch = state.match(/^((?:[\w\-]+:\s+)*)(&[\w\-]+)\s*{/);
            if (nodeRefMatch) {
                var node = this.getNode(nodeRefMatch[2]);
                if (!node) {
                    console.error(`Referenced unknown node ${nodeRefMatch[2]}`);
                    continue;
                }

                var entry = new NodeEntry(
                    new OffsetRange(doc, offset, nodeRefMatch[0].length),
                    node,
                    new OffsetRange(doc, offset + nodeRefMatch[1] ? nodeRefMatch[1].length : 0, nodeRefMatch[2].length));
                entry.labels.push(...nodeRefMatch[1].split(':').map(l => l.trim()).filter(l => l.length > 0));
                node.entries.push(entry);
                if (nodeStack.length === 0) {
                    this.docs[doc.uri.fsPath].topLevelEntries.push(entry);
                }
                nodeStack.push(entry);
                continue;
            }

            var propMatch = state.match(/^((?:[\w\-]+:\s+)*)([#?\w,\._+\-]+)(?:\s*=\s*([^;{}]+?))?\s*;/);
            if (propMatch) {
                var p = new Property(
                    propMatch[2],
                    new OffsetRange(doc, offset, propMatch[0].length),
                    propMatch[1] ? propMatch[1].split(':').map(l => l.trim()) : [],
                    propMatch[3],
                );
                nodeStack[nodeStack.length - 1].properties.push(p);
                continue;
            }

            var closingBrace = state.match(/^}\s*;/);
            if (closingBrace) {
                var entry = nodeStack.pop();
                entry.range.extendTo(offset + closingBrace.length);
                continue;
            }

            state.skipToken();
        }

        if (nodeStack.length > 0) {
            nodeStack[nodeStack.length - 1].range.extendTo(state.offset);
            console.error(`Unterminated node: ${nodeStack[0].node.name}`);
        }

        var procTime = process.hrtime(timeStart);

        console.log(`Parsed in ${(procTime[0] * 1e9 + procTime[1]) / 1000000} ms`);

        return this.docs[doc.uri.fsPath].topLevelEntries;
    }

    getNode(search: string): Node | undefined {
        if (search.startsWith('&')) {
            var label = search.slice(1);
            var node = this.nodeArray().find(n => n.labels().indexOf(label) !== -1);
            return this.nodes[node.path];
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
        var prop = node.properties().find(p => p.range.doc.uri.fsPath === doc.uri.fsPath && p.range.toRange().contains(pos));
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