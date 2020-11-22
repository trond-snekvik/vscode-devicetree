/*
 * Copyright (c) 2020 Trond Snekvik
 *
 * SPDX-License-Identifier: MIT
 */
import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { Line } from './dts';
import { DiagnosticsSet } from './diags';
import { evaluateExpr } from './util';

export function replace(text: string, macros: MacroInstance[]) {
    // Replace values from back to front:
    [...macros].sort((a, b) => b.start - a.start).forEach(m => {
        text = text.slice(0, m.start) + m.insert + text.slice(m.start + m.raw.length);
    });

    return text;
}

function parseArgs(text: string): {args: string[], raw: string} {
    const args = new Array<string>();
    const start = text.match(/^\s*\(/);
    if (!start) {
        return {args, raw: ''};
    }
    text = text.slice(start[0].length);
    let depth = 1;
    let arg = '';
    let raw = start[0];

    while (text.length) {
        const paramMatch = text.match(/^([^(),]*)(.)/);
        if (!paramMatch) {
            return { args: [], raw };
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
                if (!--depth) {
                    break;
                }
            }
        }
    }

    if (depth) {
        return {args: [], raw};
    }

    return { args, raw };
}

function resolve(text: string, defines: Defines, loc: vscode.Location): string {
    return replace(text, findReplacements(text, defines, loc));
}

export function findReplacements(text: string, defines: Defines, loc: vscode.Location): MacroInstance[] {
    const macros = new Array<MacroInstance>();
    const regex = new RegExp(/\w+|(?<!\\)"/g);
    let inString = false;
    let match: RegExpMatchArray;
    while ((match = regex.exec(text))) {
        if (match[0] === '"') {
            inString = !inString;
            continue;
        }

        if (inString) {
            continue;
        }

        const macro = defines[match[0]];
        if (!macro) {
            continue;
        }
        if (!macro.args) {
            const val = resolve(macro.value(loc), defines, loc);
            macros.push(new MacroInstance(macro, match[0], val, match.index));
            continue;
        }

        const {args, raw: rawArgs} = parseArgs(text.slice(match.index + match[0].length));
        regex.lastIndex = match.index + match[0].length + rawArgs.length;

        /* Replace macro arguments:
         * - Parameters that start with a single "#" will be converted to double quoted strings,
         *   and if they contain defines, they won't be expanded.
         * - Values with preceeded or followed by "##" will be replaced with their value, and
         *   if they contain defines, they won't be expanded.
         * - Other instances are replaced by their values, and any defines will be expanded.
         */
        const replacements = {};
        macro.args.forEach((arg, i, all) => {
            if (i == all.length - 1) {
                if (arg === '...') {
                    replacements['__VA_ARGS__'] = args.slice(i).join(', ');
                    return;
                }

                if (arg.endsWith('...')) {
                    replacements[arg.replace(/\.\.\.$/, '')] = args.slice(i).join(', ');
                    return;
                }
            }
            replacements[arg] = args[i];
        });
        let insert = macro.value(loc).replace(/(?:,\s*##\s*(__VA_ARGS__)|(?<=##)\s*(\w+)\b|\b(\w+)\s*(?=##)|(?<!#)#\s*(\w+)\b|\b(\w+)\b)/g,
            (original, vaArgs, concat1, concat2, stringified, raw) => {
                let v = replacements[vaArgs];
                if (v !== undefined) {
                    // If the value is empty, we'll consume the comma:
                    if (v) {
                        return resolve(', ' + v, defines, loc);
                    }

                    return resolve(v, defines, loc);
                }

                v = replacements[concat1] ?? replacements[concat2];
                if (v !== undefined) {
                    return v;
                }

                v = replacements[stringified];
                if (v !== undefined) {
                    return `"${v}"`;
                }

                v = replacements[raw];
                if (v !== undefined) {
                    return resolve(v, defines, loc);
                }

                return original;
            });


        insert = insert.replace(/\s*##\s*/g, '');

        macros.push(new MacroInstance(macro, match[0] + rawArgs, resolve(insert, defines, loc), match.index));
    }

    return macros;
}

export class Macro {
    private _value: string;
    name: string;
    args?: string[]
    definition?: Line;
    undef?: Line;

    get isDefined() {
        return !this.undef;
    }

    value(loc: vscode.Location) {
        return this._value;
    }

    constructor(name: string, value: string, definition?: Line, args?: string[]) {
        this.name = name;
        this.definition = definition;
        this._value = value;
        this.args = args;
    }
}

export class LineMacro extends Macro {
    value(loc: vscode.Location) {
        return (loc.range.start.line + 1).toString();
    }

    constructor() {
        super('__LINE__', '0');
    }
}

export class FileMacro extends Macro {
    private cwd: string;

    value(loc: vscode.Location) {
        return `"${path.relative(this.cwd, loc.uri.fsPath).replace(/\\/g, '\\\\')}"`;
    }

    constructor(cwd: string) {
        super('__FILE__', '<unknown>');
        this.cwd = cwd;
    }
}

export class CounterMacro extends Macro {
    private number = 0;

    value(loc: vscode.Location) {
        return (this.number++).toString();
    }

    constructor() {
        super('__COUNTER__', '0');
    }
}

export class MacroInstance {
    raw: string;
    insert: string;
    start: number;
    macro: Macro;

    constructor(macro: Macro, raw: string, insert: string, start: number) {
        this.macro = macro;
        this.raw = raw;
        this.insert = insert;
        this.start = start;
    }
}

function readLines(doc: vscode.TextDocument): Line[] | null {
    try {
        const text = doc.getText();
        return text.split(/\r?\n/g).map((line, i) => new Line(line, i, doc.uri));
    } catch (e) {
        return null;
    }
}

export type IncludeStatement = { loc: vscode.Location, dst: vscode.Uri };

type Output = [Line[], Macro[], IncludeStatement[]];
type Defines = { [name: string]: Macro };

function evaluate(text: string, loc: vscode.Location, defines: Defines, diagSet: DiagnosticsSet): any {
    text = resolve(text, defines, loc);
    try {
        const diags = new Array<vscode.Diagnostic>();
        const result = evaluateExpr(text, loc.range.start, diags);
        diags.forEach(d => diagSet.pushLoc(new vscode.Location(loc.uri, d.range), d.message, d.severity));
        return result;
    } catch (e) {
        diagSet.pushLoc(loc, 'Evaluation failed: ' + e.toString(), vscode.DiagnosticSeverity.Error);
    }

    return 0;
}

export async function preprocess(doc: vscode.TextDocument, defines: Macro[], includes: string[], diags: DiagnosticsSet): Promise<Output> {
    const pushLineDiag = (line: Line, message: string, severity: vscode.DiagnosticSeverity=vscode.DiagnosticSeverity.Warning) => {
        const diag = new vscode.Diagnostic(line.location.range, message, severity);
        diags.push(line.uri, diag);
        return diag;
    };

    const timeStart = process.hrtime();
    const macros: Defines = {
        '__FILE__': new FileMacro(path.dirname(doc.uri.fsPath)),
        '__LINE__': new LineMacro(),
        '__COUNTER__': new CounterMacro(),
    };
    defines.forEach(d => macros[d.name] = d);

    const result = {
        lines: new Array<Line>(),
        macros: new Array<Macro>(),
        includes: new Array<IncludeStatement>(),
    };

    let rawLines = readLines(doc);
    if (rawLines === null) {
        diags.push(doc.uri, new vscode.Diagnostic(new vscode.Range(0, 0, 0, 0), 'Unable to read file', vscode.DiagnosticSeverity.Error));
        return Promise.resolve([result.lines, result.macros, result.includes]);
    }

    const scopes: {line: Line, condition: boolean}[] = [];
    const once = new Array<vscode.Uri>();

    while (rawLines.length) {
        const line = rawLines.splice(0, 1)[0];
        let text = line.text;

        try {
            text = text.replace(/\/\/.*/, '');
            text = text.replace(/\/\*.*?\*\//, '');

            const blockComment = text.match(/\/\*.*/);
            if (blockComment) {
                text = text.replace(blockComment[0], '');
                while (rawLines) {
                    const blockEnd = rawLines[0].text.match(/^.*?\*\//);
                    if (blockEnd) {
                        rawLines[0].text = rawLines[0].text.slice(blockEnd[0].length);
                        break;
                    }

                    rawLines.splice(0, 1);
                }
            }

            const directive = text.match(/^\s*#\s*(\w+)/);
            if (directive) {
                while (text.endsWith('\\') && rawLines.length) {
                    text = text.slice(0, text.length - 1) + ' ' + rawLines.splice(0, 1)[0].text;
                }

                let value =  text.match(/^\s*#\s*(\w+)\s*(.*)/)[2].trim();

                if (directive[1] === 'if') {
                    if (!value) {
                        pushLineDiag(line, 'Missing condition');
                        scopes.push({line: line, condition: false});
                        continue;
                    }

                    value = value.replace(new RegExp(`defined\\((.*?)\\)`, 'g'), (t, define) => {
                        return macros[define]?.isDefined ? '1' : '0';
                    });

                    scopes.push({line: line, condition: !!evaluate(value, line.location, macros, diags)});
                    continue;
                }

                if (directive[1] === 'ifdef') {
                    if (!value) {
                        pushLineDiag(line, 'Missing condition');
                        scopes.push({line: line, condition: false});
                        continue;
                    }

                    scopes.push({ line: line, condition: macros[value]?.isDefined });
                    continue;
                }

                if (directive[1] === 'ifndef') {
                    if (!value) {
                        pushLineDiag(line, 'Missing condition');
                        scopes.push({line: line, condition: false});
                        continue;
                    }

                    scopes.push({ line: line, condition: !macros[value]?.isDefined });
                    continue;
                }

                if (directive[1] === 'else') {
                    if (!scopes.length) {
                        pushLineDiag(line, `Unexpected #else`);
                        continue;
                    }

                    scopes[scopes.length - 1].condition = !scopes[scopes.length - 1].condition;
                    continue;
                }

                if (directive[1] === 'elif') {

                    if (!scopes.length) {
                        pushLineDiag(line, `Unexpected #elsif`);
                        continue;
                    }

                    if (!value) {
                        pushLineDiag(line, 'Missing condition');
                        scopes.push({line: line, condition: false});
                        continue;
                    }

                    if (scopes[scopes.length - 1].condition) {
                        scopes[scopes.length - 1].condition = false;
                        continue;
                    }

                    let condition = resolve(value, macros, line.location);
                    condition = condition.replace(new RegExp(`defined\\((.*?)\\)`, 'g'), (t, define) => {
                        return macros[define]?.isDefined ? '1' : '0';
                    });

                    scopes[scopes.length - 1].condition = evaluate(condition, line.location, macros, diags);
                    continue;
                }

                if (directive[1] === 'endif') {
                    if (!scopes.length) {
                        pushLineDiag(line, `Unexpected #endif`);
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
                    const define = value.match(/^(\w+)(?:\((.*?)\))?\s*(.*)/);
                    if (!define) {
                        pushLineDiag(line, 'Invalid define syntax');
                        continue;
                    }

                    const existing = macros[define[1]];
                    if (existing && !existing.undef) {
                        pushLineDiag(line, 'Duplicate definition');
                        continue;
                    }

                    const macro = existing ?? new Macro(define[1], define[3], line, define[2]?.split(',').map(a => a.trim()));
                    macro.undef = undefined;
                    result.macros.push(macro);
                    macros[macro.name] = macro;
                    continue;
                }

                if (directive[1] === 'undef') {
                    const undef = value.match(/^\w+/);
                    if (!value) {
                        pushLineDiag(line, 'Invalid undef syntax');
                        continue;
                    }

                    const define = macros[undef[0]];
                    if (!define || define.undef) {
                        pushLineDiag(line, 'Unknown define');
                        continue;
                    }

                    define.undef = line;
                    continue;
                }

                if (directive[1] === 'pragma') {
                    if (value === 'once') {
                        if (once.some(uri => uri.fsPath === line.uri.fsPath)) {
                            const lines = rawLines.findIndex(l => l.uri.fsPath !== line.uri.fsPath);
                            if (lines > 0) {
                                rawLines.splice(0, lines);
                            }
                            continue;
                        }

                        once.push(line.uri);
                    } else {
                        pushLineDiag(line, `Unknown pragma directive "${value}"`);
                    }
                    continue;
                }

                if (directive[1] === 'include') {
                    const include = value.replace(/(?:"([^\s">]+)"|<([^\s">]+)>)/g, '$1$2').trim();
                    if (!include) {
                        pushLineDiag(line, 'Invalid include');
                        continue;
                    }

                    const file = [path.resolve(path.dirname(line.uri.fsPath)), ...includes].map(dir => path.resolve(dir, include)).find(path => fs.existsSync(path));
                    if (!file) {
                        pushLineDiag(line, `No such file: ${include}`, vscode.DiagnosticSeverity.Warning);
                        continue;
                    }

                    const uri = vscode.Uri.file(file);

                    const start = text.indexOf(value);
                    result.includes.push({ loc: new vscode.Location(line.uri, new vscode.Range(line.number, start, line.number, start + value.length)), dst: uri });

                    // inject the included file's lines. They will be the next to be processed:
                    const doc = await vscode.workspace.openTextDocument(uri);
                    const lines = readLines(doc);
                    if (lines === null) {
                        pushLineDiag(line, 'Unable to read file');
                    } else {
                        rawLines = [...lines, ...rawLines];
                    }
                    continue;
                }

                if (directive[1] === 'error') {
                    pushLineDiag(line, value ?? 'Error');
                    continue;
                }
            }

            if (!text) {
                continue;
            }

            if (!scopes.every(c => c.condition)) {
                continue;
            }

            result.lines.push(new Line(text, line.number, line.uri, findReplacements(text, macros, line.location)));
        } catch (e) {
            pushLineDiag(line, 'Preprocessor crashed: ' + e);
        }
    }

    scopes.forEach(s => pushLineDiag(s.line, 'Unterminated scope'));

    const procTime = process.hrtime(timeStart);
    // console.log(`Preprocessed ${doc.uri.fsPath} in ${(procTime[0] * 1e9 + procTime[1]) / 1000000} ms`);

    return Promise.resolve([result.lines, result.macros, result.includes]);
}
