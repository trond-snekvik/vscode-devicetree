/*
 * Copyright (c) 2020 Trond Snekvik
 *
 * SPDX-License-Identifier: MIT
 */
import * as vscode from 'vscode';
import * as path from 'path';
import * as os from 'os';
import { env } from 'process';
import { exec } from 'child_process';
import { existsSync, readdir, readFile, readFileSync } from 'fs';
import * as glob from 'glob';
import * as yaml from 'js-yaml';
import { config } from './config';
import { Profiler } from './util';

export type BoardInfo = {
    identifier: string;
    name: string;
    type: string;
    arch: string;
    toolchain: string[];
    ram: number;
    flash: number;
    supported: string[];
};
export type Board = { name: string; uri: vscode.Uri; arch?: string; info?: BoardInfo | { [name: string]: any } };
export let zephyrRoot: string;
let boards: Board[];
export let modules: vscode.Uri[];

async function getCMakePackages(): Promise<vscode.Uri[]> {
    const packageToZephyrURI = (entry: string) => {
        return vscode.Uri.file(path.resolve(entry, '..', '..', '..'));
    };

    if (process.platform === 'win32') {
        return new Promise(resolve => {
            exec('reg query HKCU\\Software\\Kitware\\CMake\\Packages\\Zephyr', (err, out) => {
                if (err) {
                    resolve([]);
                } else {
                    resolve(
                        out
                            .split('\n')
                            .filter(line => line.includes('REG_SZ')) // <hash> REG_SZ <zephyr-path/share/zephyr-package/cmake>
                            .map(line => packageToZephyrURI(line.trim().split(' ').pop()))
                    );
                }
            });
        });
    } else {
        const packages = path.resolve(os.homedir(), '.cmake', 'packages', 'Zephyr');
        const entries = await new Promise<string[]>(resolve => readdir(packages, (err, out) => resolve(err ? [] : out)));
        const uris = new Array<vscode.Uri>();
        await Promise.all(
            entries.map(
                entry =>
                    new Promise<void>(resolve => {
                        readFile(path.resolve(packages, entry), 'utf-8', (err, out) => {
                            if (!err) {
                                uris.push(packageToZephyrURI(out.trim()));
                            }
                            resolve();
                        });
                    })
            )
        );
        return uris;
    }
}

async function findZephyr() {
    if (config.get('zephyr')) {
        await setZephyrBase(vscode.Uri.file(config.get('zephyr')));
        return;
    }

    if (env['ZEPHYR_BASE']) {
        await setZephyrBase(vscode.Uri.file(env['ZEPHYR_BASE'] as string));
        return;
    }

    const cmakePackages = await getCMakePackages();
    if (cmakePackages.length === 1) {
        await setZephyrBase(cmakePackages[0]);
        return;
    }

    const pack = cmakePackages.find(uri => {
        // The zephyr folder is inside this workspace:
        if (vscode.workspace.getWorkspaceFolder(uri)) {
            return true;
        }

        // or some folder in this workspace is in this zephyr instance:
        const topdir = path.dirname(uri.fsPath);
        return vscode.workspace.workspaceFolders?.some(folder => !path.relative(topdir, folder.uri.fsPath).startsWith('..'));
    });
    if (pack) {
        await setZephyrBase(pack);
        return;
    }

    if (cmakePackages.length > 1) {
        await setZephyrBase(cmakePackages[0]);

        const buttons = { setDefault: 'Use as default', change: 'Change' };
        vscode.window
            .showInformationMessage(`Using Zephyr installation at ${zephyrRoot}`, ...Object.values(buttons))
            .then(async button => {
                switch (button) {
                    case buttons.change:
                        vscode.window.showQuickPick([...cmakePackages.map(uri => uri.fsPath), 'Browse...']).then(pick => {
                            if (pick === 'Browse...') {
                                vscode.window
                                    .showOpenDialog({
                                        openLabel: 'Set',
                                        canSelectFiles: false,
                                        canSelectFolders: true,
                                    })
                                    .then(
                                        folder => {
                                            config.set('zephyr', zephyrRoot);
                                            setZephyrBase(folder[0]);
                                        },
                                        () => undefined
                                    );
                            } else {
                                setZephyrBase(vscode.Uri.file(pick));
                            }
                        });
                        break;
                    case buttons.setDefault:
                        config.set('zephyr', zephyrRoot);
                        break;
                }
            });
        return;
    }

    vscode.window.showErrorMessage(`Couldn't find Zephyr root`, 'Configure...').then(button => {
        if (button) {
            config.configureSetting('zephyr');
        }
    });
}

function resolveModules(): vscode.Uri[] {
    const dirs = config.get('modules');
    const uris = new Array<vscode.Uri>();
    dirs.map(d =>
        d
            .replace(/\${(.*?)}/g, (original, name: string) => {
                if (name === 'workspaceFolder') {
                    return vscode.workspace.workspaceFolders?.[0].uri.fsPath ?? vscode.env.appRoot;
                }

                if (name.startsWith('workspaceFolder:')) {
                    const folder = name.split(':')[1];
                    return vscode.workspace.workspaceFolders.find(w => w.name === folder)?.uri.fsPath ?? original;
                }

                if (name.toLowerCase().startsWith('env:')) {
                    const variable = name.split(':')[1];
                    return process.env[variable] ?? '';
                }

                if (['zephyr_base', 'zephyrbase', 'zephyr'].includes(name.toLowerCase())) {
                    return zephyrRoot;
                }

                return original;
            })
            .replace(/^~/, os.homedir())
    ).forEach(p => {
        if (path.isAbsolute(p)) {
            uris.push(vscode.Uri.file(p));
        } else {
            vscode.workspace.workspaceFolders?.forEach(workspace => uris.push(vscode.Uri.joinPath(workspace.uri, p)));
        }
    });

    return uris;
}

export async function setZephyrBase(uri: vscode.Uri) {
    zephyrRoot = uri.fsPath;
    modules = resolveModules();
    boards = resolveBoards();
    zephyrEmitter.fire(zephyrRoot);
}

export function findBoard(board: string): Board | undefined {
    return boards.find(b => b.name === board);
}

export async function isBoardFile(uri: vscode.Uri) {
    if (path.extname(uri.fsPath) !== '.dts') {
        return false;
    }

    return boardRoots().some(root => !path.relative(root.fsPath, uri.fsPath).startsWith('..'));
}

export async function defaultBoard(): Promise<Board> {
    const dtsBoard = config.get('defaultBoard') as string;
    if (dtsBoard) {
        const path = findBoard(dtsBoard);
        if (path) {
            console.log('Using default board');
            return path;
        }
    }

    return findBoard('nrf52dk_nrf52832') ?? findBoard('nrf52_pca10040');
}

function boardRoots(): vscode.Uri[] {
    return modules.map(m => vscode.Uri.joinPath(m, 'boards')).filter(dir => existsSync(dir.fsPath));
}

export function board(uri: vscode.Uri): Board {
    const name = path.basename(uri.fsPath, path.extname(uri.fsPath));
    const arch = path.basename(path.resolve(path.dirname(uri.fsPath), '..'));

    return {
        name,
        uri,
        arch,
    };
}

function resolveBoards() {
    const boards = new Array<Board>();
    const roots = boardRoots();
    roots.forEach(root => {
        const matches = glob.sync('**/*_defconfig', { cwd: root.fsPath, absolute: true });
        matches.forEach(m => {
            const dir = vscode.Uri.file(path.dirname(m));
            const dts = vscode.Uri.joinPath(dir, path.basename(m, '_defconfig') + '.dts');
            boards.push(board(dts));
        });
    });

    return boards;
}

export async function selectBoard(prompt = 'Set board'): Promise<Board> {
    return vscode.window
        .showQuickPick(
            boards.map(board => <vscode.QuickPickItem>{ label: board.name, description: board.arch, board }),
            { placeHolder: prompt }
        )
        .then(board => board['board']);
}

export function activate(ctx: vscode.ExtensionContext) {
    config.onChange('modules', () => (modules = resolveModules()));
    config.onChange('zephyr', findZephyr);
    return findZephyr();
}

const zephyrEmitter = new vscode.EventEmitter<string>();
export const onChange = zephyrEmitter.event;

export function resolveBoardInfo(board: Board) {
    const file = vscode.Uri.joinPath(board.uri, '..', board.name + '.yaml');
    if (!existsSync(file.fsPath)) {
        return;
    }

    const out = readFileSync(file.fsPath, 'utf-8');
    if (!out) {
        return;
    }

    board.info = <BoardInfo>yaml.load(out, { json: true }) || {};
}
