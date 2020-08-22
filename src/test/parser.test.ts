import * as vscode from 'vscode';
import * as assert from 'assert';
import { after } from 'mocha';
import * as path from 'path';
import * as fs from 'fs';
import { preprocess, Macro } from '../preprocessor';
import { evaluateExpr } from '../dts';
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