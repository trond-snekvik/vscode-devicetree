/*
 * Copyright (c) 2020 Trond Snekvik
 *
 * SPDX-License-Identifier: MIT
 */
import * as vscode from 'vscode';
import * as assert from 'assert';
import { after } from 'mocha';
import * as path from 'path';
import * as fs from 'fs';
import { preprocess, Define, MacroInstance, Line, toDefines } from '../preprocessor';
import { evaluateExpr } from '../util';
import { DiagnosticsSet } from '../diags';

// bake: Output needs to be manually verified
const BAKE_OUTPUT = false;

suite('Parser test suite', () => {
	after(() => {
		vscode.window.showInformationMessage('All tests done!');
	});

	test('Preprocessor', async () => {
		const extensionDevelopmentPath = path.resolve(__dirname, '../../../');
		const inputFile = extensionDevelopmentPath + '/src/test/test.h';
		const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(inputFile));
		const diags = new DiagnosticsSet();

		let result = await preprocess(doc, {}, [], diags);
		if (BAKE_OUTPUT) {
			fs.writeFileSync(extensionDevelopmentPath + '/src/test/output.h', result.lines.map(l => l.text).join('\n'));
		}

		const expected = fs.readFileSync(extensionDevelopmentPath + '/src/test/output.h', 'utf-8').split(/\r?\n/g);
		assert.equal(result.lines.length, expected.length);

		result.lines.forEach((l, i) => {
			assert.equal(l.text.trim(), expected[i].trim());
		});

		result = await preprocess(doc, toDefines([new Define('TEST_DIAGS', ''), new Define('TEST_VALID_DIRECTIVES', '')]), [], diags);
		assert.equal(diags.length, 0, diags.toString());
		result = await preprocess(doc, toDefines([new Define('TEST_DIAGS', ''), new Define('TEST_INVALID_DIRECTIVES', '')]), [], diags);
	});

	test('Nested macros', async () => {
		const doc = await vscode.workspace.openTextDocument({language: 'dts', content: `
		#define SUM(a, b) a + b
		#define STR(a) # a
		#define LITERAL(a) a
		#define STR2(a) STR(a)
		#define CONCAT(a, b) a##b
		#define CONCAT2(a, b) CONCAT(a, b)
		#define CONCAT3(a, b, c) a##b##c
		#define VAL xyz
		#define VAL2 ffff
		#define PARAM_CONCAT(a) VAL##a
		#define PARAM_CONCAT2(a) VAL##undefined
		VAL == xyz
		CONCAT(p, q) == pq
		CONCAT(VAL, 1) == VAL1
		CONCAT(VAL, VAL) == VALVAL
		LITERAL(VAL) == xyz
		STR(VAL) == "VAL"
		STR2(VAL) == "xyz"
		CONCAT3(V, A, L) == xyz
		CONCAT2(V, AL) == xyz
		PARAM_CONCAT(2) == ffff
		PARAM_CONCAT2(2) == VALundefined
		`});
		const diags = new DiagnosticsSet();

		const result = await preprocess(doc, {}, [], diags);
		assert.equal(diags.all.length, 0, diags.all.toString());
		result.lines.filter(line => line.text.includes('==')).map(line => {
			const actual = line.text.split('==')[0].trim();
			const expected = line.raw.split('==')[1].trim();
			// console.log(`${actual} == ${expected}`);
			return {actual, expected, line};
		}).forEach((v) => assert.equal(v.actual, v.expected, v.line.raw));
	});

	test('Line remap', () => {
		const line = new Line('foo MACRO_1 MACRO_2 abc', 0, vscode.Uri.file('test'), [
			new MacroInstance(new Define('MACRO_1', 'bar'), 'MACRO_1', 'bar', 4),
			new MacroInstance(new Define('MACRO_2', '1234'), 'MACRO_2', '1234', 12),
		]);

		assert.equal(line.text, 'foo bar 1234 abc');
		assert.equal(line.rawPos(0, true), 0);
		assert.equal(line.rawPos(4, true), 4); // start of first macro
		assert.equal(line.rawPos(5, true), 4); // middle of first macro
		assert.equal(line.rawPos(6, true), 4); // middle of first macro
		assert.equal(line.rawPos(7, true), 11); // right after first macro
		assert.equal(line.rawPos(8, true), 12); // start of second macro
		assert.equal(line.rawPos(11, true), 12); // middle of second macro
		assert.equal(line.rawPos(12, true), 19); // after second macro
		assert.equal(line.rawPos(13, false), 20); // after second macro

		assert.equal(line.rawPos(0, false), 0);
		assert.equal(line.rawPos(4, false), 11); // start of first macro
		assert.equal(line.rawPos(5, false), 11); // middle of first macro
		assert.equal(line.rawPos(6, false), 11); // middle of first macro
		assert.equal(line.rawPos(7, false), 11); // right after first macro
		assert.equal(line.rawPos(8, false), 19); // start of second macro
		assert.equal(line.rawPos(11, false), 19); // middle of second macro
		assert.equal(line.rawPos(12, false), 19); // after second macro
		assert.equal(line.rawPos(13, false), 20); // after second macro
	});

	test('Expressions', () => {
		const position = new vscode.Position(0, 0);
		assert.equal(0, evaluateExpr('0', position, []));
		assert.equal(1, evaluateExpr('1', position, []));
		assert.equal(3, evaluateExpr('1 + 2', position, []));
		assert.equal(3, evaluateExpr('(1 + 2)', position, []));
		assert.equal(256, evaluateExpr('1 << 8', position, []));
		assert.equal(256, evaluateExpr('(1 << 8)', position, []));
		assert.equal(256, evaluateExpr('(1.0f << 8ULL)', position, []));
		assert.equal(1, evaluateExpr('(1)', position, []));
		assert.equal(3, evaluateExpr('(1) + (2)', position, []));
		assert.equal(0, evaluateExpr('(1) + (2 + (3 * 5ULL)) - 18', position, []));
		assert.equal(undefined, evaluateExpr('(', position, []));
		assert.equal(undefined, evaluateExpr(')', position, []));
		assert.equal(undefined, evaluateExpr('())', position, []));
		assert.equal(undefined, evaluateExpr('level + 1', position, []));
		assert.equal(undefined, evaluateExpr('1 + level', position, []));
		assert.equal(undefined, evaluateExpr('1 + 2 level', position, []));
		assert.equal(false, evaluateExpr('1 == 2', position, []));
		assert.equal(true, evaluateExpr('1 <= 2', position, []));
		assert.equal(true, evaluateExpr('1 < 2', position, []));
		assert.equal(98, evaluateExpr("'a' + 1", position, []));
	});
});