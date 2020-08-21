import * as vscode from 'vscode';
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
        let string = state.match(/^"(.*?)"/);
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
        let number = state.match(/^(0x[\da-fA-F]+|\d+)\b/);
        if (number) {
            return new IntValue(Number.parseInt(number[1]), state.location(), number[1].startsWith('0x'));
        }
    }

    toString() {
        if (this.hex) {
            return `< 0x${this.val.toString(16)} >`;
        }

        return `< ${this.val} >`
    }
}

export class Expression extends IntValue {
    raw: string;

    private constructor(raw: string, loc: vscode.Location) {
        super(eval(raw), loc);
        this.raw = raw;
    }

    static match(state: ParserState): Expression {
        let start = state.freeze();
        let m = state.match(/^\(/);
        if (!m) {
            return undefined;
        }

        let level = 1;
        let text = '(';
        while (level !== 0) {
            m = state.match(/(?:(?:<<|>>|&&|\|\||[!=<>]=|[|&~^<>!=+\-\/*]|\s*|0x[\da-fA-F]+|[\d\.]+)\s*)*([()])/);
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

        let loc = state.location(start);

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
        let start = state.freeze();
        let phandleArray = state.match(/^</);
        if (!phandleArray) {
            return undefined;
        }

        const elems = [IntValue, PHandle, Expression];
        let values: (PHandle | IntValue)[] = [];

        while (state.skipWhitespace() && !state.match(/^>/)) {
            var match: PHandle | IntValue | Expression | undefined;
            elems.find(e => match = e.match(state));
            if (match) {
                values.push(match);
                continue;
            }

            let unexpectedToken = state.skipToken();
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

    get forEach() {
        return this.val.forEach;
    }

    get find() {
        return this.val.find;
    }

    get every() {
        return this.val.every;
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
        return `< ${this.val.map(v => v.toString())} >`;
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
        let byteArray = state.match(/^\[\s*((?:[\da-fA-F]{2}\s*)+)\]/);
        if (byteArray) {
            return new BytestringValue((byteArray[1] as string).match(/\S{2}/g).map(c => parseInt(c, 16)), state.location());
        }
    }

    toString() {
        return `[ ${this.val.map(v => v.toString(16)).join(' ')} ]`;
    }
}

export class PHandle extends PropertyValue {
    val: string;

    private constructor(value: string, loc: vscode.Location) {
        super(value, loc);
    }

    static match(state: ParserState): PHandle {
        let phandle = state.match(/^&([\w\-]+)/);
        if (phandle) {
            return new PHandle(phandle[1], state.location());
        }
    }

    toString() {
        return `$${this.val}`;
    }
}

export function evaluateExpr(expr: string, start: vscode.Position, diags: vscode.Diagnostic[]) {
    expr = expr.trim().replace(/([\d\.]+|0x[\da-f]+)[ULf]+/gi, '$1');
    let m: RegExpMatchArray;
    let level = 0;
    let text = '';
    while ((m = expr.match(/(?:(?:<<|>>|&&|\|\||[!=<>]=|[|&~^<>!=+\-\/*]|\s*|0x[\da-fA-F]+|[\d\.]+)\s*)*([()]?)/)) && m[0].length) {
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
        let endLine = this.getPrevMatchLine();
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
            let diags = new Array<vscode.Diagnostic>();
            let result = evaluateExpr(text, loc.range.start, diags);
            diags.forEach(d => this.pushDiag(d.message, d.severity, new vscode.Location(loc.uri, d.range)));
            return result;
        } catch (e) {
            this.pushDiag('Evaluation failed: ' + e.toString(), vscode.DiagnosticSeverity.Error, loc);
        }

        return 0;
    }

    match(pattern: RegExp): RegExpMatchArray | undefined {
        let match = this.peek(pattern);
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
        let match = this.match(/^[#-\w]+|./);
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
    let elems: PropertyValue[] = [];

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

        var match: PropertyValue;
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

    constructor(name: string, loc: vscode.Location, state: ParserState, labels?: string[]) {
        this.name = name;
        this.loc = loc;
        this.labels = labels;
        this.value = parsePropValue(state);
        this.fullRange = new vscode.Range(loc.range.start, state.location().range.end);
    }

    toString(): string {
        if (this.value.length === 1 && this.value[0] instanceof BoolValue) {
            return `${this.name}`
        }

        return `${this.name} = ${this.valueString()}`;
    }

    valueString(): string {
        if (this.value === undefined) {
            return '?';
        }

        if (this.value.length === 1 && this.value[0] instanceof BoolValue) {
            return 'true';
        }

        return this.value.map(v => v.val).join(', ');
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
            let v = this.value[0]
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

                if (v.every(e => e instanceof PHandle)) {
                    return 'phandles';
                }

                if (v.every(e => e instanceof IntValue)) {
                    return 'array';
                }

                return 'phandle-array';
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

            if (this.value.every((v: ArrayValue) => v.every(e => e instanceof PHandle))) {
                return 'phandles';
            }

            if (this.value.every((v: ArrayValue) => v.every(e => e instanceof IntValue))) {
                return 'array';
            }

            return 'phandle-array';
        }

        if (this.value.every(v => v instanceof StringValue)) {
            return 'string-array';
        }

        return 'compound';
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

enum CtxKind {
    Board,
    Overlay,
};

export class DTSCtx {
    uri: vscode.Uri;
    lines: Line[];
    roots: NodeEntry[];
    entries: NodeEntry[];
    includes: IncludeStatement[];
    macros: Macro[];
    diags: DiagnosticsSet;
    kind: CtxKind;

    constructor(uri: vscode.Uri, kind: CtxKind) {
        this.uri = uri;
        this.kind = kind;
        this.diags = new DiagnosticsSet();
        this.reset();
    }

    match(uri: vscode.Uri) {
        return (
            this.uri.toString() === uri.toString() ||
            this.includes.find(include => uri.toString() === include.dst.toString()));
    }

    reset() {
        this.lines = [];
        this.roots = [];
        this.entries = [];
        this.includes = [];
        this.macros = [];
        this.diags.clear();
    }
};

export class NodeEntry {
    node: Node;
    children: NodeEntry[];
    parent?: NodeEntry;
    properties: Property[];
    labels: string[];
    ref?: string;
    loc: vscode.Location;
    nameLoc: vscode.Location;
    ctx: DTSCtx;
    number: number;

    constructor(loc: vscode.Location, node: Node, nameLoc: vscode.Location, ctx: DTSCtx, number: number) {
        this.node = node;
        this.children = [];
        this.properties = [];
        this.loc = loc;
        this.nameLoc = nameLoc;
        this.labels = [];
        this.ctx = ctx;
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
        let status = this.property('status');
        return !status || (status.value[0].val === 'okay');
    }

    hasLabel(label: string) {
        return !!this.entries.find(e => e.labels.indexOf(label) != -1);
    }

    children(): Node[] {
        let children: Node[] = [];
        this.entries.forEach(e => children.push(...e.children.map(c => c.node)));
        return children;
    }

    get sortedEntries() {
        return this.entries.sort((a, b) => 1000000 * (a.ctx.kind - b.ctx.kind) + (a.number - b.number));
    }

    labels(): string[] {
        let labels: string[] = [];
        this.entries.forEach(e => labels.push(...e.labels));
        return labels;
    }

    properties(): Property[] {
        let props: Property[] = [];
        this.entries.forEach(e => props.push(...e.properties));
        return props;
    }

    property(name: string): Property | undefined {
        // use the last found entry (this is the one that counts according to DTS):
        return this.uniqueProperties().reverse().find(e => e.name === name);
    }

    uniqueProperties(): Property[] {
        let props = {};
        this.sortedEntries.forEach(e => e.properties.forEach(p => props[p.name] = p));
        return Object.values(props);
    }
};

export class Parser {
    nodes: {[fullPath: string]: Node};
    root?: Node;
    private includes: string[];
    private defines: {[name: string]: string};
    boardCtx?: DTSCtx;
    context?: DTSCtx;
    types: TypeLoader;

    constructor(defines: {}, includes: string[], types: TypeLoader) {
        this.nodes = {};
        this.includes = includes;
        this.defines = defines;
        this.types = types;
    }

    nodeArray() {
        return Object.keys(this.nodes).map(k => this.nodes[k]);
    }

    get roots() {
        var roots = [];
        this.contexts.forEach(c => roots.push(...c.roots))
        return roots;
    }

    get entries() {
        var entries = [];
        this.contexts.forEach(c => entries.push(...c.entries))
        return entries;
    }

    ctx(uri: vscode.Uri): DTSCtx | undefined {
        return this.contexts.find(c => c.uri.toString() === uri.toString()) ?? this.contexts.find(c => c.includes.some(i => i.dst.toString() === uri.toString()));
    }

    private get contexts(): DTSCtx[] {
        let ctxs = [];
        if (this.boardCtx) {
            ctxs.push(this.boardCtx);
        }

        if (this.context) {
            ctxs.push(this.context);
        }

        return ctxs;
    }

    async setBoardFile(uri: vscode.TextDocument) {
        this.boardCtx = await this.parse(uri, CtxKind.Board);
    }

    async setFile(uri: vscode.TextDocument) {
        this.context = await this.parse(uri, CtxKind.Overlay);
    }

    async onChange(e: vscode.TextDocumentChangeEvent) {
        if (!e.contentChanges.length) {
            return;
        }

        if (this.boardCtx?.match(e.document.uri)) {
            this.deleteCtx(this.boardCtx);
            this.boardCtx = await this.parse(await vscode.workspace.openTextDocument(this.boardCtx.uri), CtxKind.Board);
        }

        if (this.context?.match(e.document.uri)) {
            this.deleteCtx(this.context);
            this.context = await this.parse(await vscode.workspace.openTextDocument(this.context.uri), CtxKind.Overlay);
        }
    }

    private deleteCtx(ctx: DTSCtx) {
        Object.values(this.nodes).forEach(n => n.entries = n.entries.filter(e => e.ctx.uri.toString() !== ctx.uri.toString()));
        Object.keys(this.nodes).forEach(k => {
            if (!this.nodes[k].entries.length) {
                delete this.nodes[k];
            }
        });
        ctx.reset();
    }

    private async parse(doc: vscode.TextDocument, kind: CtxKind): Promise<DTSCtx> {
        let ctx = new DTSCtx(doc.uri, kind);
        let macros: Macro[];
        if (kind !== CtxKind.Board && this.boardCtx) {
            macros = this.boardCtx.macros.filter(m => !(m instanceof LineMacro) && !(m instanceof CounterMacro) && !(m instanceof FileMacro));
        } else {
            macros = Object.keys(this.defines).map(d => new Macro(d, this.defines[d]));
        }

        const preprocessed = await preprocess(doc, macros, this.includes, ctx.diags);
        const state = new ParserState(doc.uri, ctx.diags, ...preprocessed);

        ctx.includes = state.includes;
        ctx.lines = state.lines;
        ctx.macros.push(...state.macros);
        let entries = 0;
        let timeStart = process.hrtime();
        let nodeStack: NodeEntry[] = [];
        let requireSemicolon = false;
        let labels = new Array<string>();
        while (state.skipWhitespace()) {
            let blockComment = state.match(/^\/\*[\s\S]*?\*\//);
            if (blockComment) {
                continue;
            }

            let comment = state.match(/^\/\/.*/);
            if (comment) {
                continue;
            }

            if (requireSemicolon) {
                requireSemicolon = false;
                let loc = state.location();
                let semicolon = state.match(/^;/);
                if (!semicolon) {
                    state.pushDiag('Missing semicolon', vscode.DiagnosticSeverity.Error, loc);
                }

                continue;
            }

            let label = state.match(/^([\w\-]+):\s*/);
            if (label) {
                labels.push(label[1]);
                continue;
            }

            let name = state.match(/^([#?\w,\.+\-]+)/);
            if (name) {
                let nameLoc = state.location();

                let nodeMatch = state.match(/^(?:@([\da-fA-F]+))?\s*{/);
                if (nodeMatch) {
                    let node = new Node(name[1],
                        nodeMatch[1],
                        nodeStack.length > 0 ? nodeStack[nodeStack.length - 1].node : undefined);

                    if (this.nodes[node.path]) {
                        node = this.nodes[node.path];
                    } else {
                        this.nodes[node.path] = node;
                    }

                    // find existing alias for this node:
                    let existingNode: Node;
                    labels.find(l => {
                        existingNode = this.nodes['&' + l];
                        return !!existingNode;
                    });

                    if (existingNode) {
                        node.entries.push(...existingNode.entries);
                        delete this.nodes[existingNode.name];
                    }

                    let entry = new NodeEntry(nameLoc, node, nameLoc, ctx, entries++);

                    entry.labels.push(...labels);
                    node.entries.push(entry);
                    ctx.entries.push(entry);

                    if (nodeStack.length === 0) {
                        ctx.roots.push(entry);
                    } else if (nodeStack[nodeStack.length - 1].children.indexOf(entry) === -1) {
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
                let hasPropValue = state.match(/^\=/);
                if (hasPropValue) {
                    if (nodeStack.length > 0) {
                        let p = new Property(name[0], nameLoc, state, labels);
                        nodeStack[nodeStack.length - 1].properties.push(p);
                    } else {
                        state.pushDiag('Property outside of node context', vscode.DiagnosticSeverity.Error, nameLoc);
                    }

                    labels = [];
                    continue;
                }

                if (nodeStack.length > 0) {
                    let p = new Property(name[0], nameLoc, undefined, labels);
                    nodeStack[nodeStack.length - 1].properties.push(p);
                    labels = [];
                    continue;
                }

                state.pushDiag('Property outside of node context', vscode.DiagnosticSeverity.Error, nameLoc);
                continue;
            }

            let refMatch = state.match(/^(&[\w\-]+)/);
            if (refMatch) {
                let refLoc = state.location();
                state.skipWhitespace();

                let isNode = state.match(/^{/);
                if (!isNode) {
                    state.pushDiag('References can only be made to nodes');
                    continue;
                }

                let node = this.getNode(refMatch[1]);
                if (!node) {
                    state.pushDiag('Unknown label', vscode.DiagnosticSeverity.Error, refLoc);
                    node = new Node(refMatch[1]);
                    this.nodes[node.name] = node;
                }

                let entry = new NodeEntry(refLoc, node, refLoc, ctx, entries++);
                entry.labels.push(...labels);
                node.entries.push(entry);
                entry.ref = refMatch[1];
                if (nodeStack.length === 0) {
                    ctx.roots.push(entry);
                }

                ctx.entries.push(entry);
                nodeStack.push(entry);
                labels = [];
                continue;
            }

            if (labels.length) {
                state.pushDiag('Expected node or property after label', vscode.DiagnosticSeverity.Warning);
                labels = [];
            }

            let versionDirective = state.match(/^\/dts-v.+?\/\s*/);
            if (versionDirective) {
                requireSemicolon = true;
                continue;
            }

            let deleteNode = state.match(/^\/delete-node\//);
            if (deleteNode) {
                state.skipWhitespace();
                requireSemicolon = true;

                let node = state.match(/^(&?)([\w,\._+\-]+)/);
                if (!node) {
                    state.pushDiag(`Expected node`);
                    continue;
                }

                let n = this.nodeArray().find(n => (node[1] ? (n.labels().indexOf(node[2]) !== -1) : (node[2] === n.name)));
                if (n) {
                    n.deleted = true;
                } else {
                    state.pushDiag(`Unknown node`, vscode.DiagnosticSeverity.Warning);
                }
                continue;
            }

            let deleteProp = state.match(/^\/delete-property\//);
            if (deleteProp) {
                state.skipWhitespace();
                requireSemicolon = true;

                let prop = state.match(/^[#?\w,\._+\-]+/);
                if (!prop) {
                    state.pushDiag('Expected property');
                    continue;
                }

                if (!nodeStack.length) {
                    state.pushDiag(`Can only delete properties inside a node`);
                    continue;
                }

                let props = nodeStack[nodeStack.length-1]?.node.properties();
                if (!props) {
                    continue;
                }
                let p = props.find(p => p.name === deleteProp[0]);
                if (!p) {
                    state.pushDiag(`Unknown property`, vscode.DiagnosticSeverity.Warning);
                    continue;
                }

                continue;
            }

            let rootMatch = state.match(/^\/\s*{/);
            if (rootMatch) {
                if (!this.root) {
                    this.root = new Node('/');
                    this.nodes['/'] = this.root;
                }
                let entry = new NodeEntry(state.location(), this.root, new vscode.Location(state.location().uri, state.location().range.start), ctx, entries++);
                this.root.entries.push(entry);
                ctx.roots.push(entry);
                ctx.entries.push(entry);
                nodeStack.push(entry);
                continue;
            }

            let closingBrace = state.match(/^}/);
            if (closingBrace) {
                if (nodeStack.length > 0) {
                    let entry = nodeStack.pop();
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
            let entry = nodeStack[nodeStack.length - 1];
            entry.loc = new vscode.Location(entry.loc.uri, new vscode.Range(entry.loc.range.start, state.location().range.end));
            console.error(`Unterminated node: ${nodeStack[nodeStack.length - 1].node.name}`);
            state.pushDiag('Unterminated node', vscode.DiagnosticSeverity.Error, entry.nameLoc);
        }

        if (requireSemicolon) {
            state.pushDiag(`Expected semicolon`, vscode.DiagnosticSeverity.Error);
        }

        let procTime = process.hrtime(timeStart);

        console.log(`Parsed ${doc.uri.fsPath} in ${(procTime[0] * 1e9 + procTime[1]) / 1000000} ms`);
        this.resolveTypes(ctx);
        console.log(`Nodes: ${Object.keys(this.nodes).length} entries: ${Object.values(this.nodes).reduce((sum, n) => sum + n.entries.length, 0)}`);
        return Promise.resolve(ctx);
    }

    resolveTypes(ctx: DTSCtx) {
        let time = process.hrtime();
        ctx.entries.forEach(e => e.node.type = (this.types.nodeType(e.node) ?? this.types.types['base']?.[0]));
        time = process.hrtime(time);
        console.log(`Resolved types for ${ctx.uri.fsPath} in ${(time[0] * 1e9 + time[1]) / 1000000} ms`);
    }

    getDiags(): DiagnosticsSet {
        const all = new DiagnosticsSet();
        this.contexts.forEach(ctx => all.merge(ctx.diags));
        return all;
    }

    getNode(search: string): Node | undefined {
        if (search.startsWith('&')) {
            let label = search.slice(1);
            let node = this.nodeArray().find(n => n.labels().indexOf(label) !== -1);
            if (node) {
                return this.nodes[node.path];
            }
        }

        if (search.endsWith('/')) {
            return this.nodes[search];
        }

        return this.nodes[search + '/'];
    }

    getNodeAt(pos: vscode.Position, uri: vscode.Uri): Node | undefined {
        let allNodes = this.nodeArray().filter(n => n.entries.find(e => e.loc.uri.fsPath === uri.fsPath && e.loc.range.contains(pos)));
        if (allNodes.length === 0) {
            return undefined;
        }
        /* When multiple nodes are matching, they extend each other,
         * and the one with the longest path is the innermost child.
         */
        return allNodes.sort((a, b) => b.path.length - a.path.length)[0];
    }

    getPropertyAt(pos: vscode.Position, uri: vscode.Uri): [Node, Property] | undefined {
        let node = this.getNodeAt(pos, uri);
        let prop = node?.properties().find(p => p.loc.uri.fsPath === uri.fsPath && p.fullRange.contains(pos));
        if (prop) {
            return [node, prop];
        }
    }

    getPHandleNode(handle: number | string): Node {
        if (typeof handle === 'number') {
            return this.nodeArray().find(n => n.properties().find(p => p.name === 'phandle' && p.value[0].val === handle));
        } else if (typeof handle === 'string') {
            return this.nodeArray().find(n => n.labels().find(p => p === handle));
        }
    }
}

export function getCells(propName: string, parent?: Node): string[] | undefined {
    let cellProp = getPHandleCells(propName, parent);

    if (cellProp) {
        return ['label'].concat(Array(<number> cellProp.value[0].val).fill('cell'));
    }

    if (propName === 'reg') {
        let addrCells = 2;
        let sizeCells = 1;
        if (parent) {
            let parentProps = parent.uniqueProperties();

            let addrCellsProp = parentProps.find(p => p.name === '#address-cells');
            if (addrCellsProp) {
                addrCells = addrCellsProp.value[0].val as number;
            }

            let sizeCellsProp = parentProps.find(p => p.name === '#size-cells');
            if (sizeCellsProp) {
                sizeCells = sizeCellsProp.value[0].val as number;
            }
        }
        return Array(addrCells).fill('addr').concat(Array(sizeCells).fill('size'));
    }
}

export function getPHandleCells(propname: string, parent: Node): Property {
    if (propname.endsWith('s')) {
        /* Weird rule: phandle array cell count is determined by the #XXX-cells entry in the parent,
         * where XXX is the singular version of the name of this property UNLESS the property is called XXX-gpios, in which
         * case the cell count is determined by the parent's #gpio-cells property
         */
        let cellName = propname.endsWith('-gpios') ? '#gpio-cells' : ('#' + propname.slice(0, propname.length) + '-cells')
        return parent.property(cellName);
    }
}