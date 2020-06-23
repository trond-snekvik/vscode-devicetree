import * as assert from 'assert';
import { after } from 'mocha';
import * as path from 'path';
import * as fs from 'fs';
import { ParserState, Macro, evaluateExpr } from '../parser';
// You can import and use all API from the 'vscode' module
// as well as import your extension to test it
import * as vscode from 'vscode';
// import * as myExtension from '../extension';

// bake: Output needs to be manually verified
const BAKE_OUTPUT = false;

suite('Parser test suite', () => {
	after(() => {
		vscode.window.showInformationMessage('All tests done!');
	});

	test('Preprocessor', () => {
		const extensionDevelopmentPath = path.resolve(__dirname, '../../../');
		const inputFile = extensionDevelopmentPath + '/src/test/test.h';
		const inputText = fs.readFileSync(inputFile).toString();

		let parser = new ParserState(inputText, vscode.Uri.file(inputFile));
		if (BAKE_OUTPUT) {
			fs.writeFileSync(extensionDevelopmentPath + '/src/test/output.h', parser.lines.map(l => l.text).join('\n'));
		}

		assert.equal(parser.lines.map(l => l.text).join('\n'), fs.readFileSync(extensionDevelopmentPath + '/src/test/output.h'));

		parser = new ParserState(inputText, vscode.Uri.file(inputFile), [new Macro('TEST_DIAGS', ''), new Macro('TEST_VALID_DIRECTIVES', '')]);
		assert.equal(parser.diags.length, 0, JSON.stringify(parser.diags));
		parser = new ParserState(inputText, vscode.Uri.file(inputFile), [new Macro('TEST_DIAGS', ''), new Macro('TEST_INVALID_DIRECTIVES', '')]);
		assert.equal(parser.diags.length, 1, JSON.stringify(parser.diags));
		assert.equal(parser.diags[0].uri.fsPath, path.resolve(extensionDevelopmentPath + '/src/test/test.invalid.c'));
		assert.equal(parser.diags[0].diags.length, fs.readFileSync(parser.diags[0].uri.fsPath).toString().match(/\/\/ fail/g).length, parser.diags.toString());
	});

	test('Expressions', () => {
		var position = new vscode.Position(0, 0);
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