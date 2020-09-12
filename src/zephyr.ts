import * as vscode from 'vscode';
import * as path from 'path';
import { env, config } from 'process';
import { ExecOptions, exec } from 'child_process';
import { existsSync } from 'fs';
import * as glob from 'glob';

const conf = vscode.workspace.getConfiguration();
export let zephyrRoot: string;
let westExe: string;
let westVersion: string;

function west(...args: string[]): Promise<string> {

	const command = westExe + ' ' + args.join(' ');

	const options: ExecOptions = {
		cwd: zephyrRoot ?? vscode.workspace.workspaceFolders?.find(w => w.name.match(/zephyr/i))?.uri.fsPath ?? vscode.workspace.workspaceFolders?.[0].uri.fsPath,
	};

	return new Promise<string>((resolve, reject) => {
		exec(command, options, (err, out) => {
			if (err) {
				reject(err);
			} else {
				resolve(out);
			}
		});
	});
}

export function openConfig(entry: string) {
	vscode.commands.executeCommand('workbench.action.openSettings', entry);
}

async function findWest() {
	if (!(westExe = conf.get('devicetree.west') as string) &&
		!(westExe = conf.get('kconfig.zephyr.west') as string)) {
		if (process.platform === 'win32') {
			westExe = 'west';
		} else {
			westExe = [
				env['HOME'] + '/.local/bin/west',
				'/usr/local/bin/west',
				'/usr/bin/west',
			].find(p => existsSync(p)) ?? 'west';
		}
	}

	return west('-V').then(version => {
		westVersion = version.match(/v\d+\.\d+\.\d+/)?.[0];
	}, (err: Error) => {
		vscode.window.showErrorMessage(`Couldn't find west (${err.name})`, 'Configure west path...').then(() => {
			openConfig('devicetree.west');
		});
	});
}

async function findZephyrRoot() {
	if (!(zephyrRoot = conf.get('devicetree.zephyr') as string) &&
		!(zephyrRoot = conf.get('kconfig.zephyr.base') as string) &&
		!(zephyrRoot = env['ZEPHYR_BASE'] as string)) {
		return Promise.all([west('topdir'), west('config', 'zephyr.base')]).then(([topdir, zephyr]) => {
			zephyrRoot = path.resolve(topdir.trim() + '/' + zephyr.trim());
		}, err => {
			vscode.window.showErrorMessage(`Couldn't find Zephyr root`, 'Configure...').then(() => {
				openConfig('devicetree.zephyr');
			});
		});
	}
}


async function* boardRoots(): AsyncIterable<string> {
	if (zephyrRoot) {
		yield zephyrRoot + '/boards';
	}

	for (const module of await west('list', '-f', '{posixpath}').then(output => output.split(/\r?\n/), rejected => [])) {
		const dir = module.trim();
		if (dir && existsSync(dir + '/boards')) {
			yield dir + '/boards';
		}
	}
}

async function findBoards(filter='*', maxCount=0): Promise<string[]> {
	const boards = new Array<string>();
	for await (const root of boardRoots()) {
		const g = new glob.Glob(`**/${filter}.dts`, { cwd: root });
		g.on('match', (m: string) => {
			boards.push(`${root}/${m}`);
			if (maxCount && boards.length === maxCount) {
				g.abort();
			}
		});

		await new Promise(resolve => {
			g.on('end', resolve);
			g.on('abort', resolve);
		});

		if (maxCount && boards.length === maxCount) {
			break;
		}
	}

	return boards;
}

export async function findBoard(board: string): Promise<string> {
	return findBoards(board, 1).then(boards => boards[0]);
}

export async function isBoardFile(uri: vscode.Uri) {
	if (path.extname(uri.fsPath) !== '.dts') {
		return false;
	}

	for await (const root of boardRoots()) {
		if (uri.fsPath.startsWith(path.normalize(root))) {
			return true;
		}
	}

	return false;
}

export async function defaultBoard(): Promise<string> {
	const dtsBoard = conf.get('devicetree.board') as string;
	if (dtsBoard) {
		const path = await findBoard(dtsBoard);
		if (path) {
			console.log('Using configured board');
			return path;
		}

	}

	const kconfigBoard = conf.get('kconfig.zephyr.board') as { board: string, arch: string, dir: string };
	if (kconfigBoard?.dir && kconfigBoard.board) {
		const kConfigBoardPath = path.join(kconfigBoard.dir, kconfigBoard.board + '.dts');
		if (existsSync(kConfigBoardPath)) {
			console.log('Using Kconfig board');
			return kConfigBoardPath;
		}
	}

	console.log('Using fallback board');
	return (await findBoard('nrf52dk_nrf52832')) ?? (await findBoard('nrf52_pca10040'));
}

export async function selectBoard() {
	return vscode.window.showQuickPick((await findBoards()).map(board => <vscode.QuickPickItem>{ label: path.basename(board, '.dts'), detail: board }), { placeHolder: 'Default board' }).then(board => board.detail!);
}

export async function activate(ctx: vscode.ExtensionContext) {
	await findWest();
	await findZephyrRoot();
	if (zephyrRoot) {
		return;
	}

	return new Promise(resolve => {
		ctx.subscriptions.push(vscode.workspace.onDidChangeConfiguration(async e => {
			if (e.affectsConfiguration('kconfig.zephyr.base') || e.affectsConfiguration('kconfig.zephyr.west') ||
				e.affectsConfiguration('devicetree.zephyr') || e.affectsConfiguration('devicetree.west')) {
				await findWest();
				await findZephyrRoot();
				if (zephyrRoot) {
					resolve();
				}
			}
		}));
	});
}
