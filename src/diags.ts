import * as vscode from 'vscode';
import { isArray } from 'util';

export class DiagnosticsSet {
    private sets: {[path: string]: {uri: vscode.Uri, diags: vscode.Diagnostic[]}} = {};

    get length() {
        return Object.values(this.sets).reduce((sum, s) => sum + s.diags.length, 0);
    }

    pushLoc(loc: vscode.Location, message: string, severity: vscode.DiagnosticSeverity=vscode.DiagnosticSeverity.Warning) {
        return this.push(loc.uri, new vscode.Diagnostic(loc.range, message, severity));
    }

    push(uri: vscode.Uri, ...diags: vscode.Diagnostic[]) {
        if (!(uri.toString() in this.sets)) {
            this.sets[uri.toString()] = {uri: uri, diags: []};
        }

        this.sets[uri.toString()].diags.push(...diags);

        return diags[0];
    }

    merge(other: DiagnosticsSet) {
        Object.values(other.sets).forEach(set => this.push(set.uri, ...set.diags));
    }

    clear() {
        this.sets = {};
    }

    diags(uri: vscode.Uri) {
        return this.sets[uri.toString()]?.diags;
    }

    get all() {
        return Object.values(this.sets);
    }
}

