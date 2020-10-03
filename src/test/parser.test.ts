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
import { preprocess, Macro, MacroInstance } from '../preprocessor';
import { evaluateExpr, Line } from '../dts';
import { DiagnosticsSet } from '../diags';
// import * as myExtension from '../extension';

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

		let [lines, macros, includes] = await preprocess(doc, [], [], diags);
		if (BAKE_OUTPUT) {
			fs.writeFileSync(extensionDevelopmentPath + '/src/test/output.h', lines.map(l => l.text).join('\n'));
		}

		assert.equal(lines.map(l => l.text).join('\n'), fs.readFileSync(extensionDevelopmentPath + '/src/test/output.h'));

		[lines, macros, includes] = await preprocess(doc, [new Macro('TEST_DIAGS', ''), new Macro('TEST_VALID_DIRECTIVES', '')], [], diags);
		assert.equal(diags.length, 0, JSON.stringify(diags));
		[lines, macros, includes] = await preprocess(doc, [new Macro('TEST_DIAGS', ''), new Macro('TEST_INVALID_DIRECTIVES', '')], [], diags);
		assert.equal(diags.length, 1, JSON.stringify(diags));
		assert.equal(diags[0].uri.fsPath, path.resolve(extensionDevelopmentPath + '/src/test/test.invalid.c'));
		assert.equal(diags[0].diags.length, fs.readFileSync(diags[0].uri.fsPath).toString().match(/\/\/ fail/g).length, diags.toString());
	});

	test('Line remap', () => {
		const line = new Line('foo MACRO_1 MACRO_2 abc', 0, vscode.Uri.file('test'), [
			new MacroInstance(new Macro('MACRO_1', 'bar'), 'MACRO_1', 'bar', 4),
			new MacroInstance(new Macro('MACRO_2', '1234'), 'MACRO_2', '1234', 12),
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
	});
});