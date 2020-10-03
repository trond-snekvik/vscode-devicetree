/*
 * Copyright (c) 2020 Trond Snekvik
 *
 * SPDX-License-Identifier: MIT
 */
import * as vscode from 'vscode';

export class DiagnosticsSet {
    private sets: {[path: string]: {uri: vscode.Uri, diags: vscode.Diagnostic[], actions: vscode.CodeAction[]}} = {};
    private last?: { uri: vscode.Uri, diag: vscode.Diagnostic };

    get length() {
        return Object.values(this.sets).reduce((sum, s) => sum + s.diags.length, 0);
    }

    pushLoc(loc: vscode.Location, message: string, severity: vscode.DiagnosticSeverity=vscode.DiagnosticSeverity.Warning) {
        return this.push(loc.uri, new vscode.Diagnostic(loc.range, message, severity));
    }

    private set(uri: vscode.Uri) {
        if (!(uri.toString() in this.sets)) {
            this.sets[uri.toString()] = {uri: uri, diags: [], actions: []};
        }

        return this.sets[uri.toString()];
    }

    push(uri: vscode.Uri, ...diags: vscode.Diagnostic[]) {
        this.set(uri).diags.push(...diags);

        this.last = { uri, diag: diags[diags.length - 1]};

        return diags[diags.length - 1];
    }

    pushAction(action: vscode.CodeAction, uri?: vscode.Uri) {
        if (uri) {
            /* overrides this.last */
        } else if (this.last) {
            uri = this.last.uri;
            action.diagnostics = [this.last.diag];
        } else {
            throw new Error("Pushing action without uri or existing diag");
        }

        this.set(uri).actions.push(action);

        return action;
    }

    merge(other: DiagnosticsSet) {
        Object.values(other.sets).forEach(set => {
            this.push(set.uri, ...set.diags);
            set.actions.forEach(action => this.pushAction(action, set.uri));
        });
    }

    getActions(uri: vscode.Uri, range: vscode.Range | vscode.Position) {
        const set = this.sets[uri.toString()];
        if (!set) {
            return [];
        }

        if (range instanceof vscode.Position) {
            range = new vscode.Range(range, range);
        }

        return set.actions.filter(action => action.diagnostics?.find(diag => diag.range.intersection(range as vscode.Range)));
    }

    clear() {
        this.sets = {};
        this.last = undefined;
    }

    diags(uri: vscode.Uri) {
        return this.sets[uri.toString()]?.diags;
    }

    get all() {
        return Object.values(this.sets);
    }
}

