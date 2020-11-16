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
        const result = new Array<MacroInstance>();
        const tag = this.args ? `${this.name}\\s*\\(` : this.name;

        let regex = new RegExp(`(?<!#)#${tag}|\\b${tag}\\b`, 'g');
        while ((match = regex.exec(text))) {
            if (insertText === undefined) {
                const otherDefines = defines.filter(d => d !== this);
                const macros = new Array<MacroInstance>();
                otherDefines.forEach(d => {
                    macros.push(...d.find(this.value, otherDefines, loc, true));
                });

                insertText = MacroInstance.process(this.value, macros);
            }

            const replaceText = match[0].startsWith('#') ? `"${insertText}"` : insertText;

            let raw = match[0];
            let arg = '';
            if (this.args) {
                const args = new Array<string>();
                text = text.slice(match.index + match[0].length);
                let depth = 1;
                while (depth && text.length) {
                    const paramMatch = text.match(/^([^(),]*)(.)/);
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

                const varArgs = new Macro('__VA_ARGS__', '');

                const macroArgs = args.map((a, i) => {
                    if (i >= this.args.length - 1 && this.args[this.args.length - 1] === '...') {
                        if (varArgs.value) {
                            varArgs.value += ', ';
                        }

                        varArgs.value += a;
                        return undefined;
                    } else if (i >= this.args.length) {
                        return undefined;
                    }

                    const macros = new Array<MacroInstance>();
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

                const macros = new Array<MacroInstance>();
                macroArgs.forEach(arg => {
                    macros.push(...arg.find(replaceText, macroArgs, loc, true));
                });
                result.push(new MacroInstance(this, raw, MacroInstance.process(replaceText, macros), match.index));
            } else {
                result.push(new MacroInstance(this, match[0], replaceText, match.index));
            }
        }

        regex = new RegExp(`##`, 'g');
        while ((match = regex.exec(text))) {
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
}

export class LineMacro extends Macro {
    find(text: string, defines: Macro[], loc: vscode.Location, inMacro=false): MacroInstance[] {
        this.value = (loc.range.start.line + 1).toString();
        return super.find(text ,defines, loc, inMacro);
    }

    constructor() {
        super('__LINE__', '<unknown>');
    }
}

export class FileMacro extends Macro {
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

export class CounterMacro extends Macro {
    private number = 0;

    find(text: string, defines: Macro[], loc: vscode.Location, inMacro=false): MacroInstance[] {
        this.value = (this.number++).toString();
        return super.find(text ,defines, loc, inMacro);
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

export async function preprocess(doc: vscode.TextDocument, macros: Macro[], includes: string[], diags: DiagnosticsSet): Promise<Output> {
    const pushLineDiag = (line: Line, message: string, severity: vscode.DiagnosticSeverity=vscode.DiagnosticSeverity.Warning) => {
        const diag = new vscode.Diagnostic(line.location.range, message, severity);
        diags.push(line.uri, diag);
        return diag;
    };

    const timeStart = process.hrtime();

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
                    text = text.slice(0, text.length) + rawLines.splice(0, 1)[0].text;
                }

                let value =  text.match(/^\s*#\s*(\w+)\s*(.*)/)[2].trim();

                if (directive[1] === 'if') {
                    if (!value) {
                        pushLineDiag(line, 'Missing condition');
                        scopes.push({line: line, condition: false});
                        continue;
                    }

                    value = value.replace(new RegExp(`defined\\((.*?)\\)`, 'g'), (t, define) => {
                        return macros.some(d => !d.undef && d.name === define) ? '1' : '0';
                    });

                    scopes.push({line: line, condition: !!this.evaluate(value, line.location)});
                    continue;
                }

                if (directive[1] === 'ifdef') {
                    if (!value) {
                        pushLineDiag(line, 'Missing condition');
                        scopes.push({line: line, condition: false});
                        continue;
                    }

                    scopes.push({line: line, condition: macros.some(d => !d.undef && d.name === value)});
                    continue;
                }

                if (directive[1] === 'ifndef') {
                    if (!value) {
                        pushLineDiag(line, 'Missing condition');
                        scopes.push({line: line, condition: false});
                        continue;
                    }

                    scopes.push({line: line, condition: !macros.some(d => !d.undef && d.name === value)});
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

                    let condition = this.replaceDefines(value, line.location);
                    condition = condition.replace(new RegExp(`defined\\((.*?)\\)`, 'g'), (t, define) => {
                        return macros.some(d => !d.undef && d.name === define) ? '1' : '0';
                    });

                    scopes[scopes.length - 1].condition = this.evaluate(condition, line.location);
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

                    const existing = macros.find(d => d.name === define[1]);
                    if (existing && !existing.undef) {
                        pushLineDiag(line, 'Duplicate definition');
                        continue;
                    }

                    const macro = existing ?? new Macro(define[1], define[3], line, define[2]?.split(',').map(a => a.trim()));
                    macro.undef = undefined;
                    result.macros.push(macro);
                    macros.push(macro);
                    continue;
                }

                if (directive[1] === 'undef') {
                    const undef = value.match(/^\w+/);
                    if (!value) {
                        pushLineDiag(line, 'Invalid undef syntax');
                        continue;
                    }

                    const define = macros.find(d => d.name === undef[0]);
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

            const lineMacros = [];
            macros.filter(d => !d.undef).forEach(d => {
                lineMacros.push(...d.find(text, macros, line.location));
            });

            result.lines.push(new Line(text, line.number, line.uri, lineMacros));
        } catch (e) {
            pushLineDiag(line, 'Preprocessor crashed: ' + e);
        }
    }

    scopes.forEach(s => pushLineDiag(s.line, 'Unterminated scope'));

    const procTime = process.hrtime(timeStart);
    console.log(`Preprocessed ${doc.uri.fsPath} in ${(procTime[0] * 1e9 + procTime[1]) / 1000000} ms`);

    return Promise.resolve([result.lines, result.macros, result.includes]);
}
