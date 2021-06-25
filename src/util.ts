/*
 * Copyright (c) 2020 Trond Snekvik
 *
 * SPDX-License-Identifier: MIT
 */
import * as vscode from 'vscode';

export function countText(count: number, text: string, plural?: string): string {
	if (!plural) {
		plural = text + 's';
	}

	let out = count.toString() + ' ';
	if (count === 1) {
		out += text;
	} else {
		out += plural;
	}

	return out;
}

export function capitalize(str: string): string {
	return str.replace(/([a-z])(\w+)/g, (word, first: string, rest: string) => {
		const acronyms = [
			'ADC', 'DAC', 'GPIO', 'SPI', 'I2C', 'RX', 'TX', 'DMA',
		];
		if (acronyms.includes(word.toUpperCase())) {
			return word.toUpperCase();
		}
		return first.toUpperCase() + rest;
	});
}

export function evaluateExpr(expr: string, start: vscode.Position, diags: vscode.Diagnostic[]=[]) {
    expr = expr.trim().replace(/([\d.]+|0x[\da-f]+)[ULf]+/gi, '$1');
    let m: RegExpMatchArray;
    let level = 0;
    let text = '';
    while ((m = expr.match(/(?:(?:<<|>>|&&|\|\||[!=<>]=|[|&~^<>!=+/*-]|\s*|0x[\da-fA-F]+|[\d.]+|'.')\s*)*([()]?)/)) && m[0].length) {
        text += m[0].replace(/'(.)'/g, (_, char: string) => char.codePointAt(0).toString());
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

export function sizeString(size): string {
    const spec = [
        { size: 1024 * 1024 * 1024, name: 'GB' },
        { size: 1024 * 1024, name: 'MB' },
        { size: 1024, name: 'kB' },
        { size: 1, name: 'bytes' },
    ].find(spec => Math.abs(size) >= spec.size && !(size % spec.size));

    if (size % spec.size) {
        return (size / spec.size).toFixed(3) + ' ' + spec.name;
    }

    return (size / spec.size).toString() + ' ' + spec.name;
}

/**
 * Basic resettable timer
 */
export class Debounce {
    private timer?: NodeJS.Timer;
    private cb?: () => any;

    constructor(private time = 1000) {}

    set(cb: () => any) {
        this.cb = cb;
        if (this.timer) {
            clearTimeout(this.timer);
        }

        setTimeout(() => {
            this.timer = undefined;
            this.cb();
        }, this.time);
    }

    clear() {
        if (this.timer) {
            clearTimeout(this.timer);
            this.timer = undefined;
        }
    }
}

export class Profiler {
    private start: [number, number];
    private time: [number, number];
    constructor() {
        this.time = process.hrtime();
        this.start = this.time;
    }

    private ms(time: [number, number]) {
        return (time[0] + time[1] / 1e9) * 1000;
    }

    delta(): number {
        const delta = process.hrtime(this.time);
        this.time = process.hrtime(this.time);
        return this.ms(delta);
    }

    total(): number {
        return this.ms(process.hrtime(this.start));
    }
}
