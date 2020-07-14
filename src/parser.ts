import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { spawnSync } from 'child_process';
import { isArray } from 'util';

type PHandle = {node: string};
type _PHandleArray = (string | number)[];
type PHandleArray = _PHandleArray | _PHandleArray[];
type _PropertyValue = string | number | boolean | PHandle | PHandle[] | PHandleArray[] | number[];
export type DiagCollection = {uri: vscode.Uri, diags: vscode.Diagnostic[]};
export type PropertyValue = _PropertyValue | _PropertyValue[]; // composite

export function evaluateExpr(expr: string, start: vscode.Position, diags: vscode.Diagnostic[]) {
    expr = expr.trim().replace(/([\d\.]+|0x[\da-f]+)[ULf]+/gi, '$1');
    var m: RegExpMatchArray;
    var level = 0;
    var text = '';
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

export class Macro {
    name: string;
    value: string;
    args?: string[]
    definition?: Line;
    undef?: Line;

    find(text: string, defines: Macro[], loc: vscode.Location, inMacro=false): MacroInstance[] {
        if (!text.includes(this.name)) {
            return [];
        }

        let insertText: string;
        let match: RegExpExecArray;
        let result = new Array<MacroInstance>();
        let tag = this.args ? `${this.name}\\s*\\(` : this.name;

        let regex = new RegExp(`(?<!#)#${tag}|\\b${tag}\\b`, 'g');
        while (match = regex.exec(text)) {
            if (insertText === undefined) {
                let otherDefines = defines.filter(d => d !== this);
                let macros = new Array<MacroInstance>();
                otherDefines.forEach(d => {
                    macros.push(...d.find(this.value, otherDefines, loc, true));
                });

                insertText = MacroInstance.process(this.value, macros);
            }

            let replaceText = match[0].startsWith('#') ? `"${insertText}"` : insertText;

            let raw = match[0];
            let arg = '';
            if (this.args) {
                let args = new Array<string>();
                text = text.slice(match.index + match[0].length);
                let depth = 1;
                while (depth && text.length) {
                    let paramMatch = text.match(/^([^(),]*)(.)/);
                    if (!paramMatch) {
                        return [];
                    }

                    raw += paramMatch[0];
                    arg += paramMatch[0];
                    text = text.slice(paramMatch[0].length);
                    if (paramMatch[2] === '(') {
                        depth++;
                    } else {
                        if (depth === 1) {
                            args.push(arg.slice(0, arg.length-1).trim());
                            arg = '';
                        }

                        if (paramMatch[2] === ')') {
                            depth--;
                        }
                    }
                }

                if (depth) {
                    return [];
                }

                let varArgs = new Macro('__VA_ARGS__', '');

                let macroArgs = args.map((a, i) => {
                    if (i >= this.args.length - 1 && this.args[this.args.length - 1] === '...') {
                        if (varArgs.value) {
                            varArgs.value += ', ';
                        }

                        varArgs.value += a
                        return undefined;
                    } else if (i >= this.args.length) {
                        return undefined;
                    }

                    let macros = new Array<MacroInstance>();
                    defines.forEach(d => {
                        macros.push(...d.find(a, defines, loc, true));
                    });
                    return new Macro(this.args[i], MacroInstance.process(a, macros));
                }).filter(arg => arg !== undefined);

                macroArgs.push(varArgs);
                if (!varArgs.value) {
                    // GCC extension (https://gcc.gnu.org/onlinedocs/cpp/Variadic-Macros.html#Variadic-Macros)
                    macroArgs.push(new Macro(',\\s*##__VA_ARGS__', ''));
                }

                let macros = new Array<MacroInstance>();
                macroArgs.forEach(arg => {
                    macros.push(...arg.find(replaceText, macroArgs, loc, true));
                });
                result.push(new MacroInstance(this, raw, MacroInstance.process(replaceText, macros), match.index));
            } else {
                result.push(new MacroInstance(this, match[0], replaceText, match.index));
            }
        }

        regex = new RegExp(`##`, 'g');
        while (match = regex.exec(text)) {
            if (result.some(m => m.start === match.index + 2 || m.start + m.raw.length === match.index)) {
                result.push(new MacroInstance(this, match[0], '', match.index));
            }
        }

        return result;
    }

    constructor(name: string, value: string, definition?: Line, args?: string[]) {
        this.name = name;
        this.definition = definition;
        this.value = value;
        this.args = args;
    }
};

class LineMacro extends Macro {
    find(text: string, defines: Macro[], loc: vscode.Location, inMacro=false): MacroInstance[] {
        this.value = (loc.range.start.line + 1).toString();
        return super.find(text ,defines, loc, inMacro);
    }

    constructor() {
        super('__LINE__', '<unknown>');
    }
}

class FileMacro extends Macro {
    private cwd: string;

    find(text: string, defines: Macro[], loc: vscode.Location, inMacro=false): MacroInstance[] {
        this.value = `"${path.relative(this.cwd, loc.uri.fsPath).replace(/\\/g, '\\\\')}"`;
        return super.find(text, defines, loc, inMacro);
    }

    constructor(cwd: string) {
        super('__FILE__', '<unknown>');
        this.cwd = cwd;
    }
}

class CounterMacro extends Macro {
    private number = 0;

    find(text: string, defines: Macro[], loc: vscode.Location, inMacro=false): MacroInstance[] {
        this.value = (this.number++).toString();
        return super.find(text ,defines, loc, inMacro);
    }

    constructor() {
        super('__COUNTER__', '0');
    }
}

class MacroInstance {
    raw: string;
    insert: string;
    start: number;
    macro: Macro;

    static process(text: string, macros: MacroInstance[]) {
        let prev: MacroInstance = null;
        macros = macros.sort((a, b) => a.start - b.start).filter(m => {
            const result = !prev || (m.start >= prev.start + prev.raw.length);
            prev = m;
            return result;
        });

        // Replace values from back to front:
        macros.sort((a, b) => b.start - a.start).forEach(m => {
            text = text.slice(0, m.start) + m.insert + text.slice(m.start + m.raw.length);
        });

        return text;
    }

    constructor(macro: Macro, raw: string, insert: string, start: number) {
        this.macro = macro;
        this.raw = raw;
        this.insert = insert;
        this.start = start;
    }
};

class Line {
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


    constructor(text: string, number: number, uri: vscode.Uri, env: Macro[]) {
        this.raw = text;
        this.number = number;
        this.uri = uri;
        this.macros = [];
        this.location = new vscode.Location(this.uri, new vscode.Range(this.number, 0, this.number, this.raw.length));
        env.filter(d => !d.undef).forEach(d => {
            this.macros.push(...d.find(text, env, this.location));
        });
        this.text = MacroInstance.process(text, this.macros);
    }
}

type Offset = { line: number, col: number };

export class ParserState {
    defines: Macro[];
    includes: string[];
    private text: string;
    private offset: Offset;
    private prevMatch: string;
    diags: {[path: string]: DiagCollection};
    fileInclusions: {line: Line, file: vscode.Uri}[];
    lines: Line[];
    uri: vscode.Uri;

    private pushUriDiag(uri: vscode.Uri, diag: vscode.Diagnostic) {
        if (!(uri.fsPath in this.diags)) {
            this.diags[uri.fsPath] = {uri: uri, diags: []};
        }

        this.diags[uri.fsPath].diags.push(diag);
        return diag;
    }

    private pushLineDiag(line: Line, message: string, severity: vscode.DiagnosticSeverity=vscode.DiagnosticSeverity.Error, start: number=0, end: number=99999): vscode.Diagnostic {
        return this.pushUriDiag(line.uri, new vscode.Diagnostic(line.remap(new vscode.Range(line.number, start, line.number, end)), message, severity));
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

        return new vscode.Location(line.uri, line.remap(new vscode.Range(line.number, start, line.number, end)));
    }

    pushDiag(message: string, severity: vscode.DiagnosticSeverity=vscode.DiagnosticSeverity.Error, loc?: vscode.Location): vscode.Diagnostic {
        if (!loc) {
            loc = this.location();
        }

        return this.pushUriDiag(loc.uri, new vscode.Diagnostic(loc.range, message, severity));
    }

    private replaceDefines(text: string, loc: vscode.Location) {
        let macros = new Array<MacroInstance>();
        this.defines.filter(d => !d.undef).forEach(d => {
            macros.push(...d.find(text, this.defines, loc));
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

    private preprocessGCC(): Line[] {
        const extensionDevelopmentPath = path.resolve(__dirname, '../../');
        const args: string[] = [
            '-fno-diagnostics-show-caret',
            '-E',
            ...this.defines.map(d => `-D${d.name}=${d.value}`),
            ...this.includes.map(i => `-I${i}`),
            this.uri.fsPath,
        ];
        var output = spawnSync('gcc', args, { cwd: extensionDevelopmentPath });

        let location: {line: number, uri?: vscode.Uri};

        output.stderr?.toString('utf-8').split(/\r?\n/g).map(l => {
            const diag = l.match(/^(.*?):(\d+):(?:(\d+):) (\w+?): (.*)/);
            if (diag) {
                let file = path.resolve(extensionDevelopmentPath, diag[1]);
                let uri = vscode.Uri.file(file);
                if (!(uri.fsPath in this.diags)) {
                    this.diags[uri.fsPath] = {uri: uri, diags: []};
                }

                let severity = (diag[4] === 'error') ? vscode.DiagnosticSeverity.Error :
                               (diag[4] === 'warning') ? vscode.DiagnosticSeverity.Warning :
                               (diag[4] === 'info') ? vscode.DiagnosticSeverity.Information :
                               vscode.DiagnosticSeverity.Hint;
                this.diags[uri.fsPath].diags.push(new vscode.Diagnostic(new vscode.Range(Number(diag[2]), Number(diag[3]) ?? 0, Number(diag[2]), Number(diag[3]) ?? 0), diag[5], severity));
            }
        });

        return output.stdout?.toString('utf-8').split(/\r?\n/g).map(l => {
            if (l.startsWith('#')) {
                const jump = l.match(/^# (\d+) "(.*?)"/)
                if (jump) {
                    location = {line: Number(jump[1]), uri: jump[2] === '<command-line>' ? undefined : vscode.Uri.file(path.resolve(extensionDevelopmentPath, jump[2]))};
                }
                return undefined;
            }

            if (!location) {
                return undefined;
            }

            return new Line(l, location.line++, location.uri, []);
        }).filter(l => l !== undefined) ?? [];
    }

    private preprocess(): Line[] {
        // return this.preprocessGCC();
        const genLines = (text: string, uri: vscode.Uri): Line[] => {
            return text.split(/\r?\n/g).map((line, i) => new Line(line, i, uri, []));
        };

        let rawLines = genLines(this.text, this.uri);
        let lines = new Array<Line>();
        let scopes: {line: Line, condition: boolean}[] = [];
        let once = new Array<vscode.Uri>();

        while (rawLines.length) {
            let line = rawLines.splice(0, 1)[0];
            let text = line.text;

            try {
                text = text.replace(/\/\/.*/, '');
                text = text.replace(/\/\*.*?\*\//, '');

                let blockComment = text.match(/\/\*.*/);
                if (blockComment) {
                    text = text.replace(blockComment[0], '');
                    while (rawLines) {
                        let blockEnd = rawLines[0].text.match(/^.*?\*\//);
                        if (blockEnd) {
                            rawLines[0].text = rawLines[0].text.slice(blockEnd[0].length);
                            break;
                        }

                        rawLines.splice(0, 1);
                    }
                }

                let directive = text.match(/^\s*#\s*(\w+)/);
                if (directive) {
                    while (text.endsWith('\\') && rawLines.length) {
                        text = text.slice(0, text.length) + rawLines.splice(0, 1)[0].text;
                    }

                    let value =  text.match(/^\s*#\s*(\w+)\s*(.*)/)[2].trim();

                    if (directive[1] === 'if') {
                        if (!value) {
                            this.pushLineDiag(line, 'Missing condition');
                            scopes.push({line: line, condition: false});
                            continue;
                        }

                        value = value.replace(new RegExp(`defined\\((.*?)\\)`, 'g'), (t, define) => {
                            return this.defines.some(d => !d.undef && d.name === define) ? '1' : '0';
                        });

                        scopes.push({line: line, condition: !!this.evaluate(value, line.location)});
                        continue;
                    }

                    if (directive[1] === 'ifdef') {
                        if (!value) {
                            this.pushLineDiag(line, 'Missing condition');
                            scopes.push({line: line, condition: false});
                            continue;
                        }

                        scopes.push({line: line, condition: this.defines.some(d => !d.undef && d.name === value)});
                        continue;
                    }

                    if (directive[1] === 'ifndef') {
                        if (!value) {
                            this.pushLineDiag(line, 'Missing condition');
                            scopes.push({line: line, condition: false});
                            continue;
                        }

                        scopes.push({line: line, condition: !this.defines.some(d => !d.undef && d.name === value)});
                        continue;
                    }

                    if (directive[1] === 'else') {
                        if (!scopes.length) {
                            this.pushLineDiag(line, `Unexpected #else`);
                            continue;
                        }

                        scopes[scopes.length - 1].condition = !scopes[scopes.length - 1].condition;
                        continue;
                    }

                    if (directive[1] === 'elsif') {

                        if (!scopes.length) {
                            this.pushLineDiag(line, `Unexpected #elsif`);
                            continue;
                        }

                        if (!value) {
                            this.pushLineDiag(line, 'Missing condition');
                            scopes.push({line: line, condition: false});
                            continue;
                        }

                        if (scopes[scopes.length - 1].condition) {
                            scopes[scopes.length - 1].condition = false;
                            continue;
                        }

                        let condition = this.replaceDefines(value, line.location);
                        condition = condition.replace(new RegExp(`defined\\((.*?)\\)`, 'g'), (t, define) => {
                            return this.defines.some(d => !d.undef && d.name === define) ? '1' : '0';
                        });

                        scopes[scopes.length - 1].condition = this.evaluate(condition, line.location);
                        continue;
                    }

                    if (directive[1] === 'endif') {
                        if (!scopes.length) {
                            this.pushLineDiag(line, `Unexpected #endif`);
                            continue;
                        }

                        scopes.pop();
                        continue;
                    }

                    // Skip everything else inside a disabled scope:
                    if (!scopes.every(c => c.condition)) {
                        continue;
                    }

                    if (directive[1] === 'define') {
                        let define = value.match(/^(\w+)(?:\((.*?)\))?\s*(.*)/);
                        if (!define) {
                            this.pushLineDiag(line, 'Invalid define syntax');
                            continue;
                        }

                        let existing = this.defines.find(d => !d.undef && d.name === define[1]);
                        if (existing) {
                            this.pushLineDiag(line, 'Duplicate definition');
                            continue;
                        }

                        this.defines.push(new Macro(define[1], define[3], line, define[2]?.split(',').map(a => a.trim())));
                        continue;
                    }

                    if (directive[1] === 'undef') {
                        let undef = value.match(/^\w+/);
                        if (!value) {
                            this.pushLineDiag(line, 'Invalid undef syntax');
                            continue;
                        }

                        let define = this.defines.find(d => d.name === undef[0]);
                        if (!define || define.undef) {
                            this.pushLineDiag(line, 'Unknown define');
                            continue;
                        }

                        define.undef = line;
                        continue;
                    }

                    if (directive[1] === 'pragma') {
                        if (value === 'once') {
                            if (once.some(uri => uri.fsPath === line.uri.fsPath)) {
                                let lines = rawLines.findIndex(l => l.uri.fsPath !== line.uri.fsPath);
                                if (lines > 0) {
                                    rawLines.splice(0, lines);
                                }
                                continue;
                            }

                            once.push(line.uri);
                        } else {
                            this.pushLineDiag(line, `Unknown pragma directive "${value}"`)
                        }
                        continue;
                    }

                    if (directive[1] === 'include') {
                        let include = value.replace(/["<>]/g, '').trim();
                        if (!include) {
                            this.pushLineDiag(line, 'Invalid include');
                            continue;
                        }

                        let includes = [path.resolve(path.dirname(line.uri.fsPath)), ...this.includes];
                        let file = includes.map(dir => path.resolve(dir, include)).find(path => fs.existsSync(path));
                        if (!file) {
                            this.pushLineDiag(line, `No such file: ${include}`, vscode.DiagnosticSeverity.Warning);
                            continue;
                        }

                        let uri = vscode.Uri.file(file);

                        this.fileInclusions.push({line: line, file: uri})

                        // inject the included file's lines. They will be the next to be processed:
                        try {
                            rawLines = [...genLines(fs.readFileSync(file, 'utf-8'), uri), ...rawLines];
                        } catch (e) {
                            this.pushLineDiag(line, 'Unable to read file');
                        }
                        continue;
                    }

                    if (directive[1] === 'error') {
                        this.pushLineDiag(line, value ?? 'Error');
                        continue;
                    }
                }

                if (!text) {
                    continue;
                }

                if (!scopes.every(c => c.condition)) {
                    continue;
                }

                lines.push(new Line(text, line.number, line.uri, this.defines));
            } catch (e) {
                this.pushLineDiag(line, 'Preprocessor crashed: ' + e);
            }
        }

        scopes.forEach(s => this.pushLineDiag(s.line, 'Unterminated scope'));

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
        var match = this.match(/^[#-\w]+|./);
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

    constructor(text: string, uri: vscode.Uri, defines: Macro[]=[], includes: string[]=[]) {
        this.text = text;
        this.defines = [new LineMacro(), new FileMacro(vscode.env.appRoot), new CounterMacro(), ...defines];
        this.includes = [
            path.resolve(vscode.workspace.workspaceFolders[0].uri.fsPath, 'dts'),
            path.resolve(vscode.workspace.workspaceFolders[0].uri.fsPath, 'dts/arm'),
            path.resolve(vscode.workspace.workspaceFolders[0].uri.fsPath, 'dts/common'),
            path.resolve(vscode.workspace.workspaceFolders[0].uri.fsPath, 'include'),
        ];
        this.uri = uri;
        this.diags = {};
        this.offset = {line: 0, col: 0};
        this.fileInclusions = [];

        var timeStart = process.hrtime();
        this.lines = this.preprocess();
        var procTime = process.hrtime(timeStart);

        console.log(`Preprocessed ${uri.fsPath} in ${(procTime[0] * 1e9 + procTime[1]) / 1000000} ms`);
    }
}

function parsePropValue(state: ParserState) {
    var elems: _PropertyValue[] = [];

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
        return true;
    }

    return elems;
}

export class Property {
    name: string;
    labels?: string[];
    value: {value: PropertyValue, raw: string};
    loc: vscode.Location;

    constructor(name: string, loc: vscode.Location, state?: ParserState, labels?: string[]) {
        this.name = name;
        this.loc = loc;
        this.labels = labels;

        if (state) {
            state.skipWhitespace();
            var start = state.freeze();
            var value = parsePropValue(state);
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
    loc: vscode.Location;
    nameLoc: vscode.Location;

    constructor(loc: vscode.Location, node: Node, nameLoc: vscode.Location) {
        this.node = node;
        this.children = [];
        this.properties = [];
        this.loc = loc;
        this.nameLoc = nameLoc;
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

        return prop;
    }

    uniqueProperties(): Property[] {
        var props = this.properties();
        return props.filter((p, i) => i > props.findIndex(pp => p != pp && p.name === pp.name));
    }
};

export class Parser {
    state?: ParserState;
    nodes: {[fullPath: string]: Node};
    root?: Node;
    docs: { [path: string]: {version: number, topLevelEntries: NodeEntry[], diags: {[uri: string]: DiagCollection} }};

    constructor() {
        this.nodes = {};
        this.docs = {};
    }

    nodeArray() {
        return Object.keys(this.nodes).map(k => this.nodes[k]);
    }

    cleanFile(doc: vscode.TextDocument) {
        this.nodeArray().forEach(n => {
            n.entries = n.entries.filter(e => e.loc.uri.fsPath !== doc.uri.fsPath);
        });
    }

    parse(text: string, doc: vscode.TextDocument, documentVersion?: number): NodeEntry[] {
        if (documentVersion !== undefined) {
            if (this.docs[doc.uri.fsPath] && this.docs[doc.uri.fsPath].version === documentVersion) {
                return this.docs[doc.uri.fsPath].topLevelEntries; /* No need to reparse */
            }

            this.docs[doc.uri.fsPath] = {version: documentVersion, topLevelEntries: [], diags: {}};
        }

        this.cleanFile(doc);
        this.state = new ParserState(text, doc.uri);
        var timeStart = process.hrtime();
        var nodeStack: NodeEntry[] = [];
        var requireSemicolon = false;
        var labels = new Array<string>();
        while (this.state.skipWhitespace()) {
            var blockComment = this.state.match(/^\/\*[\s\S]*?\*\//);
            if (blockComment) {
                continue;
            }

            var comment = this.state.match(/^\/\/.*/);
            if (comment) {
                continue;
            }

            if (requireSemicolon) {
                var token = this.state.match(/^[^;]+/);
                if (token) {
                    this.state.pushDiag('Expected semicolon');
                    continue;
                }
                var token = this.state.match(/^;/);
                if (token) {
                    requireSemicolon = false;
                }
                continue;
            }

            var label = this.state.match(/^([\w\-]+):\s*/);
            if (label) {
                labels.push(label[1]);
                continue;
            }

            let name = this.state.match(/^([#?\w,\.+\-]+)/);
            if (name) {
                let nameLoc = this.state.location();

                let nodeMatch = this.state.match(/^(?:@([\da-fA-F]+))?\s*{/);
                if (nodeMatch) {
                    var node = new Node(name[1],
                        nodeMatch[1],
                        nodeStack.length > 0 ? nodeStack[nodeStack.length - 1].node : undefined);

                    if (this.nodes[node.path]) {
                        node = this.nodes[node.path];
                    } else {
                        this.nodes[node.path] = node;
                    }

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

                    let loc = this.state.location();
                    let entry = new NodeEntry(nameLoc, node, nameLoc);

                    entry.labels.push(...labels);
                    node.entries.push(entry);

                    if (nodeStack.length === 0) {
                        this.docs[doc.uri.fsPath].topLevelEntries.push(entry);
                    }

                    if (nodeStack[nodeStack.length - 1].children.indexOf(entry) === -1) {
                        nodeStack[nodeStack.length - 1].children.push(entry);
                    }
                    nodeStack.push(entry);

                    if (nodeMatch[1]?.startsWith('0') && Number(nodeMatch[1]) !== 0) {
                        this.state.pushDiag(`Address should not start with leading 0's`, vscode.DiagnosticSeverity.Warning);
                    }

                    labels = [];
                    continue;
                }

                requireSemicolon = true;

                this.state.skipWhitespace();
                let hasPropValue = this.state.match(/^\=/);
                if (hasPropValue) {
                    if (nodeStack.length > 0) {
                        var p = new Property(name[0], nameLoc, this.state, labels);
                        nodeStack[nodeStack.length - 1].properties.push(p);
                    } else {
                        this.state.pushDiag('Property outside of node context', vscode.DiagnosticSeverity.Error, nameLoc);
                    }

                    labels = [];
                    continue;
                }

                if (nodeStack.length > 0) {
                    var p = new Property(name[0], nameLoc, undefined, labels);
                    nodeStack[nodeStack.length - 1].properties.push(p);
                    labels = [];
                    continue;
                }

                this.state.pushDiag('Property outside of node context', vscode.DiagnosticSeverity.Error, nameLoc);
                continue;
            }

            let refMatch = this.state.match(/^(&[\w\-]+)/);
            if (refMatch) {
                let refLoc = this.state.location();
                this.state.skipWhitespace();

                let isNode = this.state.match(/^{/);
                if (!isNode) {
                    this.state.pushDiag('References can only be made to nodes');
                    continue;
                }

                let node = this.getNode(refMatch[1]);
                if (!node) {
                    this.state.pushDiag('Unknown label', vscode.DiagnosticSeverity.Error, refLoc);
                    node = new Node(refMatch[1]);
                    this.nodes[node.name] = node;
                }

                let entry = new NodeEntry(refLoc, node, refLoc);
                entry.labels.push(...labels);
                node.entries.push(entry);
                entry.ref = refMatch[1];
                if (nodeStack.length === 0) {
                    this.docs[doc.uri.fsPath].topLevelEntries.push(entry);
                }

                nodeStack.push(entry);
                labels = [];
                continue;
            }

            if (labels.length) {
                this.state.pushDiag('Expected node or property after label', vscode.DiagnosticSeverity.Warning);
                labels = [];
            }

            var versionDirective = this.state.match(/^\/dts-v.+?\/\s*/);
            if (versionDirective) {
                requireSemicolon = true;
                continue;
            }

            var deleteNode = this.state.match(/^\/delete-node\//);
            if (deleteNode) {
                this.state.skipWhitespace();
                requireSemicolon = true;

                let node = this.state.match(/^(&?)([\w,\._+\-]+)/);
                if (!node) {
                    this.state.pushDiag(`Expected node`);
                    continue;
                }

                var n = this.nodeArray().find(n => (node[1] ? (n.labels().indexOf(node[2]) !== -1) : (node[2] === n.name)));
                if (n) {
                    n.deleted = true;
                } else {
                    this.state.pushDiag(`Unknown node`, vscode.DiagnosticSeverity.Warning);
                }
                continue;
            }

            var deleteProp = this.state.match(/^\/delete-property\//);
            if (deleteProp) {
                this.state.skipWhitespace();
                requireSemicolon = true;

                var prop = this.state.match(/^[#?\w,\._+\-]+/);
                if (!prop) {
                    this.state.pushDiag('Expected property');
                    continue;
                }

                if (!nodeStack.length) {
                    this.state.pushDiag(`Can only delete properties inside a node`);
                    continue;
                }

                var props = nodeStack[nodeStack.length-1]?.node.properties();
                if (!props) {
                    continue;
                }
                var p = props.find(p => p.name === deleteProp[0]);
                if (!p) {
                    this.state.pushDiag(`Unknown property`, vscode.DiagnosticSeverity.Warning);
                    continue;
                }

                continue;
            }

            var rootMatch = this.state.match(/^\/\s*{/);
            if (rootMatch) {
                if (!this.root) {
                    this.root = new Node('/');
                    this.nodes['/'] = this.root;
                }
                var entry = new NodeEntry(this.state.location(), this.root, new vscode.Location(this.state.location().uri, this.state.location().range.start));
                this.root.entries.push(entry);
                this.docs[doc.uri.fsPath].topLevelEntries.push(entry);
                nodeStack.push(entry);
                continue;
            }

            var closingBrace = this.state.match(/^}/);
            if (closingBrace) {
                if (nodeStack.length > 0) {
                    var entry = nodeStack.pop();
                    entry.loc = new vscode.Location(entry.loc.uri, new vscode.Range(entry.loc.range.start, this.state.location().range.end));
                } else {
                    this.state.pushDiag('Unexpected closing bracket');
                }

                requireSemicolon = true;
                continue;
            }

            this.state.skipToken();
            this.state.pushDiag('Unexpected token');
        }

        if (nodeStack.length > 0) {
            let entry = nodeStack[nodeStack.length - 1];
            entry.loc = new vscode.Location(entry.loc.uri, new vscode.Range(entry.loc.range.start, this.state.location().range.end));
            console.error(`Unterminated node: ${nodeStack[nodeStack.length - 1].node.name}`);
            this.state.pushDiag('Unterminated node', vscode.DiagnosticSeverity.Error, entry.nameLoc);
        }

        var procTime = process.hrtime(timeStart);

        console.log(`Parsed ${doc.uri.fsPath} in ${(procTime[0] * 1e9 + procTime[1]) / 1000000} ms`);

        this.docs[doc.uri.fsPath].diags = this.state.diags;
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
        var allNodes = this.nodeArray().filter(n => n.entries.find(e => e.loc.uri.fsPath === doc.uri.fsPath && e.loc.range.contains(pos)));
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
        var prop = node?.properties().find(p => p.loc.uri.fsPath === doc.uri.fsPath && p.loc.range.contains(pos));
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