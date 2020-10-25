/*
 * Copyright (c) 2020 Trond Snekvik
 *
 * SPDX-License-Identifier: MIT
 */
import * as vscode from 'vscode';
import * as path from 'path';
import { env, config } from 'process';
import { ExecOptions, exec } from 'child_process';
import { existsSync } from 'fs';
import * as glob from 'glob';

export type Board = { name: string, path: string, arch?: string }
const conf = vscode.workspace.getConfiguration();
export let zephyrRoot: string;
let westExe: string;
let westVersion: string;
let boards: Board[];
export let modules: string[];

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
		westExe = 'west';
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
			zephyrRoot = path.join(topdir.trim(), zephyr.trim());
		}, err => {
			vscode.window.showErrorMessage(`Couldn't find Zephyr root`, 'Configure...').then(() => {
				openConfig('devicetree.zephyr');
			});
		});
	}
}

export function findBoard(board: string): Board {
	return boards.find(b => b.name === board);
}

export async function isBoardFile(uri: vscode.Uri) {
	if (path.extname(uri.fsPath) !== '.dts') {
		return false;
	}

	for (const root of boardRoots()) {
		if (uri.fsPath.startsWith(path.normalize(root))) {
			return true;
		}
	}

	return false;
}

export async function defaultBoard(): Promise<Board> {
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
		const board = <Board>{ name: kconfigBoard.board, path: path.join(kconfigBoard.dir, kconfigBoard.board + '.dts'), arch: kconfigBoard.arch };
		if (existsSync(board.path)) {
			console.log('Using Kconfig board');
			return board;
		}
	}

	console.log('Using fallback board');
	return findBoard('nrf52dk_nrf52832') ?? findBoard('nrf52_pca10040');
}

function boardRoots(): string[] {
	return modules.map(m => m + '/boards').filter(dir => existsSync(dir));
}

async function findBoards() {
	boards = new Array<Board>();
	return Promise.all(boardRoots().map(root => new Promise(resolve => glob(`**/*.dts`, { cwd: root }, (err, matches) => {
		if (!err) {
			matches.forEach(m => boards.push({name: path.basename(m, '.dts'), path: `${root}/${m}`, arch: m.split(/[/\\]/)?.[0]}));
		}

		resolve();
	}))));
}

async function loadModules() {
	modules = await west('list', '-f', '{posixpath}').then(out => out.split(/\r?\n/).map(line => line.trim()), _ => []);
	await findBoards();
}

export async function selectBoard(prompt='Set board'): Promise<Board> {
	return vscode.window.showQuickPick(boards.map(board => <vscode.QuickPickItem>{ label: board.name, description: board.arch, board }), { placeHolder: prompt }).then(board => board['board']);
}

export async function activate(ctx: vscode.ExtensionContext) {
	await findWest();
	await findZephyrRoot();
	if (zephyrRoot) {
		await loadModules();
		return;
	}

	return new Promise(resolve => {
		ctx.subscriptions.push(vscode.workspace.onDidChangeConfiguration(async e => {
			if (e.affectsConfiguration('kconfig.zephyr.base') || e.affectsConfiguration('kconfig.zephyr.west') ||
				e.affectsConfiguration('devicetree.zephyr') || e.affectsConfiguration('devicetree.west')) {
				await findWest();
				await findZephyrRoot();
				if (zephyrRoot) {
					await loadModules();
					resolve();
				}
			}
		}));
	});
}
