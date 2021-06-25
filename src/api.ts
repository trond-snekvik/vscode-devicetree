/*
 * Copyright (c) 2021 Trond Snekvik
 *
 * SPDX-License-Identifier: MIT
 */
import * as vscode from "vscode";
import * as dts from "./dts";
import { DeviceTree, Context, InfoItem, File } from "../api";
import { TreeInfoItem, iconPath, treeView } from "./treeView";
import { DTSDocumentProvider } from "./compiledOutput";
import { typeLoader } from "./types";
import * as zephyr from './zephyr';

function packFile(file: dts.DTSFile): File {
    const getIncludes = (uri: vscode.Uri): vscode.Uri[] => {
        return file.includes.filter(i => i.loc.uri.fsPath === uri.fsPath).map(i => i.dst);
    };

    const packIncludeStatement = (uri: vscode.Uri): File => {
        return {
            uri,
            includes: getIncludes(uri).map(packIncludeStatement),
        };
    };

    const includes = getIncludes(file.uri);
    return {
        uri: file.uri,
        includes: includes.map(packIncludeStatement),
    };
}

function packCtx(ctx: dts.DTSCtx): Context {
    return {
        overlays: ctx.overlays.map(packFile),
        boardFile: packFile(ctx.boardFile),
        name: ctx.name,
        id: ctx.id,
    };
}

function packInfoItem(item: TreeInfoItem): InfoItem {
    const packed = { ...item.treeItem } as InfoItem;
    packed.children = item.children.map(packInfoItem);
    return packed;
}

export class API implements DeviceTree {
    private _changeEmitter = new vscode.EventEmitter<Context>();
    onChange = this._changeEmitter.event;
    icons = {
        dts: iconPath('devicetree-inner'),
        adc: iconPath('adc'),
        bus: iconPath('bus'),
        board: iconPath('circuit-board'),
        clock: iconPath('clock'),
        dac: iconPath('dac'),
        flash: iconPath('flash'),
        gpio: iconPath('gpio'),
        interrupts: iconPath('interrupts'),
        overlay: iconPath('overlay'),
        shield: iconPath('shield'),
        addShield: iconPath('add-shield'),
        removeShield: iconPath('remove-shield'),
    };
    version = 1;

    constructor() {
        dts.parser.onStable(ctx => {
            this._changeEmitter.fire(packCtx(ctx));
        });
    }

    async addContext(boardUri: vscode.Uri, overlays: vscode.Uri[] = [], name?: string): Promise<Context> {
        const ctx =
            dts.parser.contexts.find(
                ctx =>
                    ctx.overlays.length === overlays.length &&
                    ctx.overlays.every(overlay => overlays.find(uri => uri.fsPath === overlay.uri.fsPath)) &&
                    ctx.board?.uri.fsPath === boardUri.fsPath
            ) ?? (await dts.parser.addContext(boardUri, overlays, name));

        if (ctx) {
            ctx.external = true;
            return packCtx(ctx);
        }

        return Promise.reject();
    }

    setZephyrBase(uri: vscode.Uri) {
        return zephyr.setZephyrBase(uri);
    }

    removeContext(id: number) {
        const ctx = dts.parser.ctx(id);
        if (ctx) {
            dts.parser.removeCtx(ctx);
        }
    }

    setOverlays(id: number, overlays: vscode.Uri[]) {
        const ctx = dts.parser.ctx(id);
        if (ctx) {
            ctx.setOverlays(overlays);
            dts.parser.reparse(ctx);
        }
    }

    getContext(id: number): Context | undefined {
        const ctx = dts.parser.ctx(id);
        if (ctx) {
            return packCtx(ctx);
        }
    }

    getDetails(id: number): InfoItem | undefined {
        const ctx = dts.parser.ctx(id);
        if (ctx) {
            return packInfoItem(treeView.details(ctx));
        }
    }

    preview(id: number, options?: vscode.TextDocumentShowOptions) {
        const ctx = dts.parser.ctx(id);
        if (ctx) {
            DTSDocumentProvider.open(ctx, options);
        }
    }
}
