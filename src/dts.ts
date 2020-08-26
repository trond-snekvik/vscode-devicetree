import * as vscode from 'vscode';
import * as path from 'path';
import * as zephyr from './zephyr';
import { MacroInstance, Macro, preprocess, IncludeStatement, LineMacro, FileMacro, CounterMacro } from './preprocessor';
import { DiagnosticsSet } from './diags';
import { NodeType, TypeLoader } from './types';

export type DiagCollection = {uri: vscode.Uri, diags: vscode.Diagnostic[]};
// export type PropertyValue = _PropertyValue | _PropertyValue[]; // composite

abstract class PropertyValue {
    val: any;
    loc: vscode.Location;

    constructor(val: any, loc: vscode.Location) {
        this.val = val;
        this.loc = loc;
    }

    toString() {
        return this.val.toString();
    }
}

export class StringValue extends PropertyValue {
    val: string;

    constructor(val: string, loc: vscode.Location) {
        super(val, loc);
    }

    static match(state: ParserState): StringValue {
        const string = state.match(/^"(.*?)"/);
        if (string) {
            return new StringValue(string[1], state.location());
        }
    }

    toString() {
        return `"${this.val}"`;
    }
}

export class BoolValue extends PropertyValue {
    val: boolean;

    constructor(loc: vscode.Location) {
        super(true, loc);
    }
}

export class IntValue extends PropertyValue {
    val: number;
    hex: boolean;

    protected constructor(val: number, loc: vscode.Location, hex=false) {
        super(val, loc);
        this.hex = hex;
    }

    static match(state: ParserState): IntValue {
        const number = state.match(/^(0x[\da-fA-F]+|\d+)\b/);
        if (number) {
            return new IntValue(Number.parseInt(number[1]), state.location(), number[1].startsWith('0x'));
        }
    }

    toString(raw=false) {
        const val = this.hex ? `0x${this.val.toString(16)}` : this.val;
        return raw ? val : `< ${val} >`;
    }
}

export class Expression extends IntValue {
    raw: string;

    private constructor(raw: string, loc: vscode.Location) {
        super(eval(raw), loc);
        this.raw = raw;
    }

    static match(state: ParserState): Expression {
        const start = state.freeze();
        let m = state.match(/^\(/);
        if (!m) {
            return undefined;
        }

        let level = 1;
        let text = '(';
        while (level !== 0) {
            m = state.match(/(?:(?:<<|>>|&&|\|\||[!=<>]=|[|&~^<>!=+/*-]|\s*|0x[\da-fA-F]+|[\d.]+)\s*)*([()])/);
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

        const loc = state.location(start);

        try {
            return new Expression(text, loc);
        } catch (e) {
            state.pushDiag(`Unable to evaluate expression`, vscode.DiagnosticSeverity.Error, loc);
        }
    }

    toString(raw=true) {
        if (raw) {
            return this.raw;
        }

        return `< ${this.val} >`;
    }
}

export class ArrayValue extends PropertyValue {
    val: (PHandle | IntValue)[];
    private constructor(value: (PHandle | IntValue)[], loc: vscode.Location) {
        super(value, loc);
    }

    static match(state: ParserState): ArrayValue {
        const start = state.freeze();
        const phandleArray = state.match(/^</);
        if (!phandleArray) {
            return undefined;
        }

        const elems = [IntValue, PHandle, Expression];
        const values: (PHandle | IntValue)[] = [];

        while (state.skipWhitespace() && !state.match(/^>/)) {
            let match: PHandle | IntValue | Expression | undefined;
            elems.find(e => match = e.match(state));
            if (match) {
                values.push(match);
                continue;
            }

            const unexpectedToken = state.skipToken();
            if (unexpectedToken.match(/[;,]/)) {
                state.pushDiag(`Unterminated expression`, vscode.DiagnosticSeverity.Error, state.location(start));
                break;
            }

            state.pushDiag(`Unexpected token`, vscode.DiagnosticSeverity.Error);
        }

        return new ArrayValue(values, state.location(start));
    }

    get length() {
        return this.val.length;
    }

    isNumberArray() {
        return this.val.every(v => v instanceof IntValue);
    }

    isNumber() {
        return (this.val.length === 1) && (this.val[0] instanceof IntValue);
    }

    isPHandle() {
        return (this.val.length === 1) && (this.val[0] instanceof IntValue);
    }

    isPHandleArray() {
        return this.val.every(v => v instanceof PHandle);
    }

    toString() {
        return `< ${this.val.map(v => v.toString(true)).join(' ')} >`;
    }
}

export class BytestringValue extends PropertyValue {
    val: number[];
    private constructor(value: number[], loc: vscode.Location) {
        super(value, loc);
    }

    get length() {
        return this.val.length;
    }

    static match(state: ParserState): BytestringValue {
        const byteArray = state.match(/^\[\s*((?:[\da-fA-F]{2}\s*)+)\]/);
        if (byteArray) {
            return new BytestringValue((byteArray[1] as string).match(/\S{2}/g).map(c => parseInt(c, 16)), state.location());
        }
    }

    toString() {
        return `[ ${this.val.map(v => v.toString(16)).join(' ')} ]`;
    }
}

export class PHandle extends PropertyValue {
    val: string; // includes & (e.g. &gpio0)
    isRef: boolean;

    private constructor(value: string, isRef: boolean, loc: vscode.Location) {
        super(value, loc);
    }

    static match(state: ParserState): PHandle {
        let phandle = state.match(/^&\{([\w/@-]+)\}/); // path reference
        if (phandle) {
            return new PHandle(phandle[1], false, state.location());
        }

        phandle = state.match(/^&[\w-]+/);
        if (phandle) {
            return new PHandle(phandle[0], true, state.location());
        }
        // can be path:
        phandle = state.match(/^"(.+?)"/); // deprecated?
        if (phandle) {
            return new PHandle(phandle[1], false, state.location());
        }
    }

    toString(raw=true) {
        if (this.isRef) {
            return raw ? this.val : `< ${this.val} >`;
        }

        return `"${this.val}"`;
    }
}

export function evaluateExpr(expr: string, start: vscode.Position, diags: vscode.Diagnostic[]) {
    expr = expr.trim().replace(/([\d.]+|0x[\da-f]+)[ULf]+/gi, '$1');
    let m: RegExpMatchArray;
    let level = 0;
    let text = '';
    while ((m = expr.match(/(?:(?:<<|>>|&&|\|\||[!=<>]=|[|&~^<>!=+/*-]|\s*|0x[\da-fA-F]+|[\d.]+)\s*)*([()]?)/)) && m[0].length) {
        text += m[0];
        if (m[1] === '(') {
            level++;
        } else if (m[1] === ')') {
            if (!level) {
                return undefined;
            }

            level--;
        }

        expr = expr.slice(m.index + m[0].length);
    }

    if (!text || level || expr) {
        diags.push(new vscode.Diagnostic(new vscode.Range(start.line, start.character + m.index, start.line, start.character + m.index), `Unterminated expression`));
        return undefined;
    }

    try {
        return eval(text);
    } catch (e) {
        diags.push(new vscode.Diagnostic(new vscode.Range(start.line, start.character, start.line, start.character + text.length), `Unable to evaluate expression`));
        return undefined;
    }
}

export class Line {
    raw: string;
    text: string;
    number: number;
    uri: vscode.Uri;
    macros: MacroInstance[];
    location: vscode.Location;

    get length(): number {
        return this.text.length;
    }

    remap(range: vscode.Range): vscode.Range;
    remap(position: vscode.Position): vscode.Position;

    remap(loc: vscode.Position | vscode.Range) {
        if (loc instanceof vscode.Position) {
            let offset = 0;
            this.macros.forEach(m => {
                if (m.start < loc.character) {
                    if (m.insert.length > loc.character - m.start) {
                        offset += loc.character - m.start;
                    } else {
                        offset += m.raw.length - m.insert.length;
                    }
                }
            });

            return new vscode.Position(loc.line, loc.character - offset);
        } else {
            return new vscode.Range(this.remap(loc.start), this.remap(loc.end));
        }
    }


    constructor(raw: string, number: number, uri: vscode.Uri, macros: MacroInstance[]=[]) {
        this.raw = raw;
        this.number = number;
        this.uri = uri;
        this.macros = macros;
        this.location = new vscode.Location(this.uri, new vscode.Range(this.number, 0, this.number, this.raw.length));
        this.text = MacroInstance.process(raw, macros);
    }
}

type Offset = { line: number, col: number };

class ParserState {
    macros: Macro[];
    private offset: Offset;
    private prevMatch: string;
    diags: DiagnosticsSet;
    includes: IncludeStatement[];
    lines: Line[];
    uri: vscode.Uri;

    private getPrevMatchLine() {
        if (this.offset.col) {
            return this.lines[this.offset.line];
        }

        if (this.offset.line >= 1) {
            return this.lines[this.offset.line - 1];
        }

        return this.lines[0];
    }

    location(start?: Offset) {
        let begin: number;
        let end: number;
        const endLine = this.getPrevMatchLine();
        let startLine = endLine;
        if (start) {
            startLine = this.lines[start.line];
            // Can't range across multiple files, revert to the prevMatch to get at least a partially correct result:
            if (startLine.uri.toString() !== endLine.uri.toString()) {
                startLine = endLine;
            }
        }

        if (this.offset.col) {
            begin = this.offset.col - this.prevMatch.length;
            end = this.offset.col;
        } else if (this.offset.line >= 1) {
            begin = this.lines[this.offset.line - 1].length - this.prevMatch.length;
            end = this.lines[this.offset.line - 1].length;
        } else {
            begin = 0;
            end = this.lines[0].length;
        }

        if (start) {
            begin = start.col;
        }

        return new vscode.Location(endLine.uri, new vscode.Range(startLine.number, begin, endLine.number, end));
    }

    pushDiag(message: string, severity: vscode.DiagnosticSeverity=vscode.DiagnosticSeverity.Error, loc?: vscode.Location): vscode.Diagnostic {
        if (!loc) {
            loc = this.location();
        }

        return this.diags.push(loc.uri, new vscode.Diagnostic(loc.range, message, severity));
    }

    private replaceDefines(text: string, loc: vscode.Location) {
        let macros = new Array<MacroInstance>();
        this.macros.filter(d => !d.undef).forEach(d => {
            macros.push(...d.find(text, this.macros, loc));
        });
        let prev: MacroInstance = null;
        macros = macros.sort((a, b) => a.start - b.start).filter(m => {
            const result = !prev || (m.start >= prev.start + prev.raw.length);
            prev = m;
            return result;
        });

        return MacroInstance.process(text, macros);
    }

    evaluate(text: string, loc: vscode.Location): any {
        text = this.replaceDefines(text, loc);
        try {
            const diags = new Array<vscode.Diagnostic>();
            const result = evaluateExpr(text, loc.range.start, diags);
            diags.forEach(d => this.pushDiag(d.message, d.severity, new vscode.Location(loc.uri, d.range)));
            return result;
        } catch (e) {
            this.pushDiag('Evaluation failed: ' + e.toString(), vscode.DiagnosticSeverity.Error, loc);
        }

        return 0;
    }

    match(pattern: RegExp): RegExpMatchArray | undefined {
        const match = this.peek(pattern);
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

    eof(): boolean {
        return this.offset.line === this.lines.length;
    }

    get next(): string {
        return this.lines[this.offset.line].text.slice(this.offset.col);
    }

    skipWhitespace() {
        while (this.match(/^\s+/));
        return !this.eof();
    }

    skipToken() {
        const match = this.match(/^[#-\w]+|./);
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

        return this.next.match(pattern);
    }

    freeze(): Offset {
        return { ... this.offset };
    }

    since(start: Offset) {
        return this.lines.slice(start.line, this.offset.line + 1).map((l, i) => {
            if (i === this.offset.line - start.line) {
                if (i === 0) {
                    return l.text.slice(start.col, this.offset.col);
                }

                return l.text.slice(0, this.offset.col);
            }

            if (i === 0) {
                return l.text.slice(start.col);
            }

            return l.text;
        }).join('\n');
    }

    constructor(uri: vscode.Uri, diags: DiagnosticsSet, lines: Line[], macros: Macro[], includes: IncludeStatement[]) {
        this.uri = uri;
        this.diags = diags;
        this.offset = {line: 0, col: 0};
        this.lines = lines;
        this.includes = includes;
        this.macros = macros;
    }
}

function parsePropValue(state: ParserState) {
    const elems: PropertyValue[] = [];

    const valueTypes = [ArrayValue, StringValue, BytestringValue, PHandle];

    while (state.skipWhitespace()) {
        if (state.peek(/^;/)) {
            break;
        }

        if (elems.length > 0) {
            if (!state.match(/^,\s*/)) {
                state.pushDiag(`Expected , or ;`);
            }

            state.skipWhitespace();
        }

        let match: PropertyValue;
        valueTypes.find(type => match = type.match(state));
        if (match) {
            elems.push(match);
            continue;
        }

        if (state.peek(/^;/)) {
            break;
        }

        state.skipToken();
        state.pushDiag(`Unexpected token in property value`);
    }

    if (elems.length === 0) {
        return [new BoolValue(state.location())];
    }

    return elems;
}

export class Property {
    name: string;
    labels?: string[];
    value: PropertyValue[];
    loc: vscode.Location;
    fullRange: vscode.Range;
    entry: NodeEntry;

    constructor(name: string, loc: vscode.Location, state: ParserState, entry: NodeEntry, labels: string[]=[]) {
        this.name = name;
        this.loc = loc;
        this.labels = labels;
        this.entry = entry;
        this.value = parsePropValue(state);
        this.fullRange = new vscode.Range(loc.range.start, state.location().range.end);
    }

    toString(): string {
        if (this.value.length === 1 && this.value[0] instanceof BoolValue) {
            return `${this.name}`;
        }

        return `${this.name} = ${this.valueString()}`;
    }

    valueString(): string {
        if (this.value === undefined) {
            return '?';
        }

        if (this.boolean) {
            return 'true';
        }

        return this.value.map(v => v.toString()).join(', ');
    }

    get valueLoc() {
        const range = this.value.reduce((union, v) => {
            if (union) {
                return union.union(v.loc.range);
            }

            return v.loc.range;
        }, <vscode.Range>undefined);

        if (range) {
            return new vscode.Location(this.loc.uri, range);
        }

        return this.loc; // better than nothing
    }

    get boolean() {
        if (this.value.length === 1 && (this.value[0] instanceof BoolValue)) {
            return true;
        }
    }

    get number() {
        if (this.value.length === 1 && (this.value[0] instanceof ArrayValue) && this.value[0].val.length === 1 && (this.value[0].val[0] instanceof IntValue)) {
            return this.value[0].val[0].val as number;
        }
    }

    get string() {
        if (this.value.length === 1 && (this.value[0] instanceof StringValue)) {
            return this.value[0].val as string;
        }
    }

    get pHandle() {
        if (this.value.length === 1 && (this.value[0] instanceof ArrayValue) && this.value[0].val.length === 1 && (this.value[0].val[0] instanceof PHandle)) {
            return this.value[0].val[0] as PHandle;
        }
        if (this.value.length === 1 && (this.value[0] instanceof PHandle)) {
            return this.value[0] as PHandle;
        }
    }

    get bytestring() {
        if (this.value.length === 1 && (this.value[0] instanceof BytestringValue)) {
            return this.value[0] as BytestringValue;
        }
    }

    get array() {
        if (this.value.length === 1 && (this.value[0] instanceof ArrayValue) && this.value[0].val.every(v => v instanceof IntValue)) {
            return this.value[0].val.map(v => v.val) as number[];
        }
    }

    get pHandles() {
        if (this.value.length === 1 && (this.value[0] instanceof ArrayValue) && this.value[0].val.every(v => v instanceof PHandle)) {
            return this.value[0].val as PHandle[];
        }
    }

    get pHandleArray() {
        if (this.value.every(v => v instanceof ArrayValue)) {
            return this.value[0].val as ArrayValue[];
        }
    }

    get stringArray() {
        if (this.value.every(v => v instanceof StringValue)) {
            return this.value.map(v => v.val) as string[];
        }
    }

    type(): string {
        if (this.value.length === 1) {
            const v = this.value[0];
            if (v instanceof ArrayValue) {
                if (v.length === 1) {
                    if (v.val[0] instanceof IntValue) {
                        return 'int';
                    }

                    if (v.val[0] instanceof PHandle) {
                        return 'phandle';
                    }

                    return 'invalid';
                }
                if (v.length > 1) {
                    if (v.val.every(e => e instanceof PHandle)) {
                        return 'phandles';
                    }

                    if (v.val.every(e => e instanceof IntValue)) {
                        return 'array';
                    }

                    return 'phandle-array';
                }

                return 'invalid';
            }

            if (v instanceof StringValue) {
                return 'string';
            }

            if (v instanceof BytestringValue) {
                return 'uint8-array';
            }

            if (v instanceof BoolValue) {
                return 'boolean';
            }

            if (v instanceof PHandle) {
                return 'path';
            }

            return 'invalid';
        }

        if (this.value.every(v => v instanceof ArrayValue)) {

            if (this.value.every((v: ArrayValue) => v.val.every(e => e instanceof PHandle))) {
                return 'phandles';
            }

            if (this.value.every((v: ArrayValue) => v.val.every(e => e instanceof IntValue))) {
                return 'array';
            }

            return 'phandle-array';
        }

        if (this.value.every(v => v instanceof StringValue)) {
            return 'string-array';
        }

        return 'compound';
    }
}

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

export class DTSFile {
    uri: vscode.Uri;
    lines: Line[];
    roots: NodeEntry[];
    entries: NodeEntry[];
    includes: IncludeStatement[];
    macros: Macro[];
    diags: DiagnosticsSet;
    dirty=false;
    priority: number;
    ctx: DTSCtx;

    constructor(uri: vscode.Uri, ctx: DTSCtx) {
        this.uri = uri;
        this.diags = new DiagnosticsSet();
        this.ctx = ctx;
        this.priority = ctx.fileCount;
        this.lines = [];
        this.roots = [];
        this.entries = [];
        this.includes = [];
        this.macros = [];
    }

    remove() {
        this.entries.forEach(e => {
            e.node.entries = e.node.entries.filter(nodeEntry => nodeEntry !== e);
        });
        this.entries = [];
        this.dirty = true;
    }

    has(uri: vscode.Uri) {
        return (
            this.uri.toString() === uri.toString() ||
            this.includes.find(include => uri.toString() === include.dst.toString()));
    }

    getNodeAt(pos: vscode.Position, uri: vscode.Uri): Node {
        return this.getEntryAt(pos, uri)?.node;
    }

    getEntryAt(pos: vscode.Position, uri: vscode.Uri): NodeEntry {
        const entries = this.entries.filter(e => e.loc.uri.fsPath === uri.fsPath && e.loc.range.contains(pos));
        if (entries.length === 0) {
            return undefined;
        }

        /* When multiple nodes are matching, they extend each other,
         * and the one with the longest path is the innermost child.
         */
        return entries.sort((a, b) => b.node.path.length - a.node.path.length)[0];
    }

    getPropertyAt(pos: vscode.Position, uri: vscode.Uri): Property {
        return this.getEntryAt(pos, uri)?.properties.find(p => p.fullRange.contains(pos));
    }
}

export class NodeEntry {
    node: Node;
    children: NodeEntry[];
    parent?: NodeEntry;
    properties: Property[];
    labels: string[];
    ref?: string;
    loc: vscode.Location;
    nameLoc: vscode.Location;
    file: DTSFile;
    number: number;

    constructor(loc: vscode.Location, node: Node, nameLoc: vscode.Location, ctx: DTSFile, number: number) {
        this.node = node;
        this.children = [];
        this.properties = [];
        this.loc = loc;
        this.nameLoc = nameLoc;
        this.labels = [];
        this.file = ctx;
        this.number = number;
    }
}

export class Node {
    name: string;
    fullName: string;
    deleted: boolean;
    parent?: Node;
    path: string;
    address?: number;
    type?: NodeType;
    entries: NodeEntry[];

    constructor(name: string, address?: string, parent?: Node) {
        if (address) {
            this.fullName = name + '@' + address;
        } else {
            this.fullName = name;
        }
        if (address) {
            this.address = parseInt(address, 16);
        }

        if (parent) {
            this.path = parent.path + this.fullName + '/';
        } else {
            this.path = '/';
        }

        this.parent = parent;
        this.name = name;
        this.deleted = false;
        this.entries = [];
    }

    enabled(): boolean {
        const status = this.property('status');
        return !status?.string || (['okay', 'ok'].includes(status.string));
    }

    hasLabel(label: string) {
        return !!this.entries.find(e => e.labels.indexOf(label) != -1);
    }

    children(): Node[] {
        const children: { [path: string]: Node } = {};
        this.entries.forEach(e => e.children.forEach(c => children[c.node.path] = c.node));
        return Object.values(children);
    }

    get sortedEntries() {
        return this.entries.sort((a, b) => 1000000 * (a.file.priority - b.file.priority) + (a.number - b.number));
    }

    labels(): string[] {
        const labels: string[] = [];
        this.entries.forEach(e => labels.push(...e.labels));
        return labels;
    }

    properties(): Property[] {
        const props: Property[] = [];
        this.entries.forEach(e => props.push(...e.properties));
        return props;
    }

    property(name: string): Property | undefined {
        return this.uniqueProperties().find(e => e.name === name);
    }

    uniqueProperties(): Property[] {
        const props = {};
        this.sortedEntries.forEach(e => e.properties.forEach(p => props[p.name] = p));
        return Object.values(props);
    }
}

export class DTSCtx {
    overlays: DTSFile[];
    board: DTSFile;
    nodes: {[fullPath: string]: Node};
    dirty: vscode.Uri[];

    constructor() {
        this.nodes = {};
        this.overlays = [];
        this.dirty = [];
    }

    reset() {
        // Kill all affected files:
        if (this.dirty.some(uri => this.board?.has(uri))) {
            this.board.remove();
        }

        this.overlays
            .filter(overlay => this.dirty.some(uri => overlay.has(uri)))
            .forEach(overlay => overlay.remove());

        const removed = { board: this.board, overlays: this.overlays };

        this.board = null;
        this.overlays = [];
        this.nodes = {};
        this.dirty = [];

        return removed;
    }

    adoptNodes(file: DTSFile) {
        file.entries.forEach(e => {
            if (!(e.node.path in this.nodes)) {
                this.nodes[e.node.path] = e.node;
            }
        });
    }

    isValid() {
        return this.dirty.length === 0 && !this.board?.dirty && !this.overlays.some(overlay => !overlay || overlay.dirty);
    }

    node(name: string): Node | null {
        if (name.startsWith('&{')) {
            const path = name.match(/^&{(.*)}/);
            if (!path) {
                return;
            }

            name = path[1];
        } else if (name.startsWith('&')) {
            const ref = name.slice(1);
            return Object.values(this.nodes).find(n => n.hasLabel(ref)) ?? null;
        }

        if (!name.endsWith('/')) {
            name += '/';
        }

        return this.nodes[name] ?? null;
    }

    nodeArray() {
        return Object.values(this.nodes);
    }

    has(uri: vscode.Uri): boolean {
        return !!this.board?.has(uri) || this.overlays.some(o => o.has(uri));
    }

    getDiags(): DiagnosticsSet {
        const all = new DiagnosticsSet();
        this.files.forEach(ctx => all.merge(ctx.diags));
        return all;
    }

    getNodeAt(pos: vscode.Position, uri: vscode.Uri): Node {
        let node: Node;
        this.files.filter(f => f.has(uri)).find(file => node = file.getNodeAt(pos, uri));
        return node;
    }

    getEntryAt(pos: vscode.Position, uri: vscode.Uri): NodeEntry {
        let entry: NodeEntry;
        this.files.filter(f => f.has(uri)).find(file => entry = file.getEntryAt(pos, uri));
        return entry;
    }

    getPropertyAt(pos: vscode.Position, uri: vscode.Uri): Property {
        let prop: Property;
        this.files.filter(f => f.has(uri)).find(file => prop = file.getPropertyAt(pos, uri));
        return prop;
    }

    getPHandleNode(handle: number | string): Node {
        if (typeof handle === 'number') {
            return this.nodeArray().find(n => n.properties().find(p => p.name === 'phandle' && p.value[0].val === handle));
        } else if (typeof handle === 'string') {
            return this.nodeArray().find(n => n.labels().find(p => p === handle));
        }
    }

    file(uri: vscode.Uri) {
        return this.files.find(f => f.has(uri));
    }

    get files() {
        if (this.board) {
            return [this.board, ...this.overlays];
        }

        return this.overlays;
    }

    get macros() {
        const macros = new Array<Macro>();
        if (this.board) {
            macros.push(...this.board.macros);
        }
        this.overlays.forEach(c => macros.push(...c?.macros));
        return macros;
    }

    get roots() {
        const roots = new Array<NodeEntry>();
        if (this.board) {
            roots.push(...this.board.roots);
        }
        this.overlays.forEach(c => roots.push(...c?.roots));
        return roots;
    }

    get entries() {
        const entries = new Array<NodeEntry>();
        if (this.board) {
            entries.push(...this.board.entries);
        }
        this.overlays.forEach(c => entries.push(...c?.entries));
        return entries;
    }

    get root() {
        return this.nodes['/'];
    }

    get fileCount() {
        return this.overlays.length + (this.board ? 1 : 0);
    }
}

export class Parser {
    private includes: string[];
    private defines: {[name: string]: string};
    private boardPaths: { [board: string]: string };
    private appCtx: DTSCtx[];
    private boardCtx: DTSCtx[]; // Raw board contexts, for when the user just opens a .dts or .dtsi file without any overlay
    private types: TypeLoader;
    private active=false;
    private changeEmitter: vscode.EventEmitter<DTSCtx>;
    onChange: vscode.Event<DTSCtx>;
    currCtx?: DTSCtx;

    constructor(defines: {[name: string]: string}, includes: string[], types: TypeLoader) {
        this.includes = includes;
        this.defines = defines;
        this.types = types;
        this.boardPaths = {};
        this.appCtx = [];
        this.boardCtx = [];
        this.changeEmitter = new vscode.EventEmitter();
        this.onChange = this.changeEmitter.event;
    }

    file(uri: vscode.Uri) {
        let file = this.currCtx?.file(uri);
        if (file) {
            return file;
        }

        this.contexts.find(ctx => file = ctx.files.find(f => f.has(uri)));
        return file;
    }

    ctx(uri: vscode.Uri): DTSCtx {
        if (this.currCtx?.has(uri)) {
            return this.currCtx;
        }

        return this.contexts.find(ctx => ctx.has(uri));
    }

    get contexts() {
        return [...this.appCtx, ...this.boardCtx];
    }

    private async guessOverlayBoard(uri: vscode.Uri) {
        const boardName = path.basename(uri.fsPath, '.overlay');
        // Some generic names are used for .overlay files: These can be ignored.
        const ignoredNames = ['app', 'dts', 'prj'];
        let board: string;
        if (!ignoredNames.includes(boardName)) {
            board = await zephyr.findBoard(boardName);
            if (board) {
                this.boardPaths[boardName] = board;
                return board;
            }
        }

        board = await zephyr.defaultBoard();
        if (board) {
            const options = ['Configure default', 'Select a different board'];
            vscode.window.showInformationMessage(`Using ${path.basename(board, '.dts')} as a default board.`, ...options).then(async e => {
                if (e === options[0]) {
                    zephyr.openConfig('devicetree.board');
                } else if (e === options[1]) {
                    board = await zephyr.selectBoard();
                    if (board) {
                        // TODO: Reload context
                    }
                }
            });
            return board;
        }

        // At this point, the user probably didn't set up their repo correctly, but we'll give them a chance to fix it:
        return await vscode.window.showErrorMessage('DeviceTree: Unable to find board.', 'Select a board').then(e => {
            if (e) {
                return zephyr.selectBoard(); // TODO: Reload context instead of blocking?
            }
        });
    }

    private async onDidOpen(doc: vscode.TextDocument) {
        if (doc.languageId !== 'dts') {
            return;
        }

        let ctx = this.ctx(doc.uri);
        if (ctx) {
            return ctx;
        }

        if (path.extname(doc.fileName) === '.overlay') {
            const boardGuess = await this.guessOverlayBoard(doc.uri);
            if (!boardGuess) {
                return;
            }

            const boardDoc = await vscode.workspace.openTextDocument(boardGuess).then(doc => doc, _ => undefined);
            if (!boardDoc) {
                return;
            }

            const ctx = new DTSCtx();

            ctx.board = await this.parse(ctx, boardDoc);
            ctx.overlays = [await this.parse(ctx, doc)];

            this.appCtx.push(ctx);
            this.currCtx = ctx;
            this.changeEmitter.fire(ctx);
            return ctx;
        }

        /* This is a raw board context with no overlays. Should be allowed use language features here, but it's not a proper context. */
        ctx = this.boardCtx.find(ctx => ctx.has(doc.uri));
        if (ctx) {
            return ctx;
        }

        ctx = new DTSCtx();
        ctx.board = await this.parse(ctx, doc);

        /* We want to keep the board contexts rid of .dtsi files if we can, as they're not complete.
         * Remove any .dtsi contexts this board file includes:
         */
        if (path.extname(doc.fileName) === '.dts') {
            this.boardCtx = this.boardCtx.filter(existing => path.extname(existing.board.uri.fsPath) === '.dts' || !ctx.has(existing.board.uri));
        }

        this.boardCtx.push(ctx);
        this.currCtx = ctx;
        this.changeEmitter.fire(ctx);
        return ctx;
    }

    /** Reparse after a change.
     *
     * When files change, their URI gets registered in each context.
     * To reparse, we wipe the entries in the changed DTSFiles, and finally wipe the context.
     * This causes the set of nodes referenced in the unchanged files to be free of entries from the
     * changed files. For each file that used to be in the context, we either re-add the nodes it held, or
     * reparse the file (adding any new nodes and their entries). Doing this from the bottom of the
     * file list makes the context look the same as it did the first time when they're parsed.
     */
    private async reparse(ctx: DTSCtx) {
        const removed = ctx.reset();

        if (removed.board?.dirty) {
            const doc = await vscode.workspace.openTextDocument(removed.board.uri);
            ctx.board = await this.parse(ctx, doc);
        } else {
            ctx.adoptNodes(removed.board);
            ctx.board = removed.board;
        }

        for (const overlay of removed.overlays) {
            if (overlay.dirty) {
                const doc = await vscode.workspace.openTextDocument(overlay.uri);
                ctx.overlays.push(await this.parse(ctx, doc));
            } else {
                ctx.adoptNodes(overlay);
                ctx.overlays.push(overlay);
            }
        }

        this.changeEmitter.fire(ctx);
    }

    private async onDidChange(e: vscode.TextDocumentChangeEvent) {
        if (!e.contentChanges.length) {
            return;
        }

        // Postpone reparsing of other contexts until they're refocused:
        [...this.appCtx, ...this.boardCtx].filter(ctx => ctx.has(e.document.uri)).forEach(ctx => ctx.dirty.push(e.document.uri)); // TODO: Filter duplicates?

        if (this.currCtx) {
            this.reparse(this.currCtx);
        }
    }

    private async onDidChangetextEditor(editor?: vscode.TextEditor) {
        if (editor?.document?.languageId === 'dts') {
            const ctx = this.ctx(editor.document.uri);
            if (ctx) {
                this.currCtx = ctx;
                if (ctx.dirty.length) {
                    this.reparse(ctx);
                }

                return;
            }

            this.currCtx = await this.onDidOpen(editor.document);
        } else {
            this.currCtx = null;
        }
    }

    activate(ctx: vscode.ExtensionContext) {
        // ctx.subscriptions.push(vscode.workspace.onDidOpenTextDocument(doc => notActive(() => this.onDidOpen(doc))));
        ctx.subscriptions.push(vscode.workspace.onDidChangeTextDocument(doc => this.onDidChange(doc)));
        ctx.subscriptions.push(vscode.window.onDidChangeActiveTextEditor(e => this.onDidChangetextEditor(e)));

        vscode.window.visibleTextEditors.forEach(e => this.onDidOpen(e.document));
    }

    private async parse(ctx: DTSCtx, doc: vscode.TextDocument): Promise<DTSFile> {
        const file = new DTSFile(doc.uri, ctx);
        const preprocessed = await preprocess(doc, ctx.macros, this.includes, file.diags);
        const state = new ParserState(doc.uri, file.diags, ...preprocessed);

        file.includes = state.includes;
        file.lines = state.lines;
        file.macros = state.macros;
        let entries = 0;
        const timeStart = process.hrtime();
        const nodeStack: NodeEntry[] = [];
        let requireSemicolon = false;
        let labels = new Array<string>();
        while (state.skipWhitespace()) {
            const blockComment = state.match(/^\/\*[\s\S]*?\*\//);
            if (blockComment) {
                continue;
            }

            const comment = state.match(/^\/\/.*/);
            if (comment) {
                continue;
            }

            if (requireSemicolon) {
                requireSemicolon = false;
                const loc = state.location();
                const semicolon = state.match(/^;/);
                if (!semicolon) {
                    state.pushDiag('Missing semicolon', vscode.DiagnosticSeverity.Error, loc);
                }

                continue;
            }

            const label = state.match(/^([\w-]+):\s*/);
            if (label) {
                labels.push(label[1]);
                continue;
            }

            const name = state.match(/^([#?\w,.+-]+)/);
            if (name) {
                const nameLoc = state.location();

                const nodeMatch = state.match(/^(?:@([\da-fA-F]+))?\s*{/);
                if (nodeMatch) {
                    let node = new Node(name[1],
                        nodeMatch[1],
                        nodeStack.length > 0 ? nodeStack[nodeStack.length - 1].node : undefined);

                    if (ctx.nodes[node.path]) {
                        node = ctx.nodes[node.path];
                    } else {
                        ctx.nodes[node.path] = node;
                    }

                    const entry = new NodeEntry(nameLoc, node, nameLoc, file, entries++);

                    entry.labels.push(...labels);
                    node.entries.push(entry);
                    file.entries.push(entry);

                    if (nodeStack.length === 0) {
                        file.roots.push(entry);
                    } else {
                        nodeStack[nodeStack.length - 1].children.push(entry);
                        entry.parent = nodeStack[nodeStack.length - 1];
                    }

                    nodeStack.push(entry);

                    if (nodeMatch[1]?.startsWith('0') && Number(nodeMatch[1]) !== 0) {
                        state.pushDiag(`Address should not start with leading 0's`, vscode.DiagnosticSeverity.Warning);
                    }

                    labels = [];
                    continue;
                }

                requireSemicolon = true;

                state.skipWhitespace();
                const hasPropValue = state.match(/^=/);
                if (hasPropValue) {
                    if (nodeStack.length > 0) {
                        const p = new Property(name[0], nameLoc, state, nodeStack[nodeStack.length - 1], labels);
                        nodeStack[nodeStack.length - 1].properties.push(p);
                    } else {
                        state.pushDiag('Property outside of node context', vscode.DiagnosticSeverity.Error, nameLoc);
                    }

                    labels = [];
                    continue;
                }

                if (nodeStack.length > 0) {
                    const p = new Property(name[0], nameLoc, state, nodeStack[nodeStack.length - 1], labels);
                    nodeStack[nodeStack.length - 1].properties.push(p);
                    labels = [];
                    continue;
                }

                state.pushDiag('Property outside of node context', vscode.DiagnosticSeverity.Error, nameLoc);
                continue;
            }

            const refMatch = state.match(/^(&[\w-]+|&{[\w@/-]+})/);
            if (refMatch) {
                const refLoc = state.location();
                state.skipWhitespace();

                const isNode = state.match(/^{/);
                if (!isNode) {
                    state.pushDiag('References can only be made to nodes');
                    continue;
                }

                let node = ctx.node(refMatch[1]);
                if (!node) {
                    state.pushDiag('Unknown label', vscode.DiagnosticSeverity.Error, refLoc);
                    node = new Node(refMatch[1]);
                }

                const entry = new NodeEntry(refLoc, node, refLoc, file, entries++);
                entry.labels.push(...labels);
                node.entries.push(entry);
                entry.ref = refMatch[1];
                if (nodeStack.length === 0) {
                    file.roots.push(entry);
                }

                file.entries.push(entry);
                nodeStack.push(entry);
                labels = [];
                continue;
            }

            if (labels.length) {
                state.pushDiag('Expected node or property after label', vscode.DiagnosticSeverity.Warning);
                labels = [];
            }

            const versionDirective = state.match(/^\/dts-v.+?\/\s*/);
            if (versionDirective) {
                requireSemicolon = true;
                continue;
            }

            const deleteNode = state.match(/^\/delete-node\//);
            if (deleteNode) {
                state.skipWhitespace();
                requireSemicolon = true;

                const node = state.match(/^&?[\w,.+/-]+/);
                if (!node) {
                    state.pushDiag(`Expected node`);
                    continue;
                }

                const n = ctx.node(node[0]);
                if (n) {
                    n.deleted = true;
                } else {
                    state.pushDiag(`Unknown node`, vscode.DiagnosticSeverity.Warning);
                }
                continue;
            }

            const deleteProp = state.match(/^\/delete-property\//);
            if (deleteProp) {
                state.skipWhitespace();
                requireSemicolon = true;

                const prop = state.match(/^[#?\w,._+-]+/);
                if (!prop) {
                    state.pushDiag('Expected property');
                    continue;
                }

                if (!nodeStack.length) {
                    state.pushDiag(`Can only delete properties inside a node`);
                    continue;
                }

                const props = nodeStack[nodeStack.length-1]?.node.properties();
                if (!props) {
                    continue;
                }
                const p = props.find(p => p.name === deleteProp[0]);
                if (!p) {
                    state.pushDiag(`Unknown property`, vscode.DiagnosticSeverity.Warning);
                    continue;
                }

                continue;
            }

            const rootMatch = state.match(/^\/\s*{/);
            if (rootMatch) {
                if (!ctx.root) {
                    ctx.nodes['/'] = new Node('');
                }
                const entry = new NodeEntry(state.location(), ctx.root, new vscode.Location(state.location().uri, state.location().range.start), file, entries++);
                ctx.root.entries.push(entry);
                file.roots.push(entry);
                file.entries.push(entry);
                nodeStack.push(entry);
                continue;
            }

            const closingBrace = state.match(/^}/);
            if (closingBrace) {
                if (nodeStack.length > 0) {
                    const entry = nodeStack.pop();
                    entry.loc = new vscode.Location(entry.loc.uri, new vscode.Range(entry.loc.range.start, state.location().range.end));
                } else {
                    state.pushDiag('Unexpected closing bracket');
                }

                requireSemicolon = true;
                continue;
            }

            state.skipToken();
            state.pushDiag('Unexpected token');
        }

        if (nodeStack.length > 0) {
            const entry = nodeStack[nodeStack.length - 1];
            entry.loc = new vscode.Location(entry.loc.uri, new vscode.Range(entry.loc.range.start, state.location().range.end));
            console.error(`Unterminated node: ${nodeStack[nodeStack.length - 1].node.name}`);
            state.pushDiag('Unterminated node', vscode.DiagnosticSeverity.Error, entry.nameLoc);
        }

        if (requireSemicolon) {
            state.pushDiag(`Expected semicolon`, vscode.DiagnosticSeverity.Error);
        }

        const procTime = process.hrtime(timeStart);

        console.log(`Parsed ${doc.uri.fsPath} in ${(procTime[0] * 1e9 + procTime[1]) / 1000000} ms`);
        console.log(`Nodes: ${Object.keys(ctx.nodes).length} entries: ${Object.values(ctx.nodes).reduce((sum, n) => sum + n.entries.length, 0)}`);

        // Resolve types:
        let time = process.hrtime();
        Object.values(ctx.nodes).forEach(node => {
            if (!node.type) {
                node.type = (this.types.nodeType(node) ?? this.types.types['base']?.[0]);
            }
        });
        time = process.hrtime(time);
        console.log(`Resolved types for ${file.uri.fsPath} in ${(time[0] * 1e9 + time[1]) / 1000000} ms`);

        return file;
    }
}

export function getCells(propName: string, parent?: Node): string[] | undefined {
    const cellProp = getPHandleCells(propName, parent);

    if (cellProp) {
        return ['label'].concat(Array(<number> cellProp.value[0].val).fill('cell'));
    }

    if (propName === 'reg') {
        let addrCells = 2;
        let sizeCells = 1;
        if (parent) {
            const addrCellsProp = parent.property('#address-cells');
            if (addrCellsProp?.number !== undefined) {
                addrCells = addrCellsProp.number;
            }

            const sizeCellsProp = parent.property('#size-cells');
            if (sizeCellsProp?.number !== undefined) {
                sizeCells = sizeCellsProp.number;
            }
        }
        return [...Array(addrCells).fill('addr'), ...Array(sizeCells).fill('size')];
    }
}

export function cellName(propname: string) {
    if (propname.endsWith('s')) {
        /* Weird rule: phandle array cell count is determined by the #XXX-cells entry in the parent,
         * where XXX is the singular version of the name of this property UNLESS the property is called XXX-gpios, in which
         * case the cell count is determined by the parent's #gpio-cells property
         */
        return propname.endsWith('-gpios') ? 'gpio-cells' : propname.slice(0, propname.length) + '-cells';
    }
}

export function getPHandleCells(propname: string, parent: Node): Property {
    return parent?.property(cellName(propname));
}