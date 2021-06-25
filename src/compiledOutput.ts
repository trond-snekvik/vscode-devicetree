import * as vscode from 'vscode';
import * as dts from './dts';
import * as path from 'path';

type CompiledEntity = { start: number, end: number, entity?: dts.Node | dts.Property };

export class DTSDocumentProvider implements vscode.TextDocumentContentProvider {
    private static readonly COMMAND = 'devicetree.showOutput';
    private readonly INDENT = ' '.repeat(8);
    private changeEmitter: vscode.EventEmitter<vscode.Uri>;
    onDidChange: vscode.Event<vscode.Uri>;
    currUri?: vscode.Uri;

    entities: CompiledEntity[];

    constructor() {
        this.changeEmitter = new vscode.EventEmitter();
        this.onDidChange = this.changeEmitter.event;

        dts.parser.onChange(ctx => {
            if (this.currUri && ctx.has(vscode.Uri.file(this.currUri.query))) {
                this.changeEmitter.fire(this.currUri);
            }
        });
    }

    activate(ctx: vscode.ExtensionContext) {
        ctx.subscriptions.push(vscode.workspace.registerTextDocumentContentProvider('devicetree', this));
        ctx.subscriptions.push(
            vscode.commands.registerCommand(DTSDocumentProvider.COMMAND, (uri?: dts.DTSCtx | vscode.Uri, options?: vscode.TextDocumentShowOptions) => {
                if (uri instanceof dts.DTSCtx) {
                    uri = uri.files.pop()?.uri;
                } else if (!uri && vscode.window.activeTextEditor?.document.languageId === 'dts') {
                    uri = vscode.window.activeTextEditor?.document.uri;
                }

                if (uri) {
                    const base = path.basename(uri.fsPath, path.extname(uri.fsPath));
                    vscode.window.showTextDocument(
                        vscode.Uri.parse(
                            `devicetree://${path.dirname(uri.path)}/Compiled DeviceTree output (${base})?${uri.path}`
                        ),
                        options ?? { viewColumn: vscode.ViewColumn.Beside }
                    );
                }
            })
        );
    }

    static open(ctx: dts.DTSCtx, options?: vscode.TextDocumentShowOptions) {
        vscode.commands.executeCommand(DTSDocumentProvider.COMMAND, ctx, options);
    }

    private async getDoc() {
        if (!this.currUri) {
            return;
        }

        return vscode.workspace.openTextDocument(this.currUri);
    }

    async entityRange(entity: dts.Node | dts.Property) {
        const doc = await this.getDoc();
        if (!doc) {
            return;
        }

        const e = this.entities.find(e => e.entity === entity);
        if (!e) {
            return;
        }

        return new vscode.Range(doc.positionAt(e.start), doc.positionAt(e.end));
    }

    async getEntity(pos: vscode.Position) {
        const doc = await this.getDoc();
        if (!doc) {
            return;
        }

        const offset = doc.offsetAt(pos);
        return this.entities.find(e => e.start <= offset && e.end >= offset)?.entity;
    }

    is(doc: vscode.Uri) {
        return doc.toString() === this.currUri?.toString();
    }

    provideTextDocumentContent(uri: vscode.Uri, token: vscode.CancellationToken): vscode.ProviderResult<string> {
        this.currUri = uri;
        const ctx = dts.parser.ctx(vscode.Uri.file(uri.query));
        if (!ctx) {
            return `/* Unable to resolve path ${uri.toString()} */`;
        }

        const entities = new Array<CompiledEntity>();
        let text = '/dts-v1/;\n\n';
        const addEntity = (entity: dts.Node | dts.Property | undefined, content: string) => {
            const e = <CompiledEntity>{ entity, start: text.length };
            entities.push(e);
            text += content;
            e.end = text.length;
        };

        const addNode = (n: dts.Node, indent = '') => {
            text += indent;
            const nodeEntity = <CompiledEntity>{ entity: n, start: text.length };
            entities.push(nodeEntity);
            const labels = n.labels();
            if (labels?.length) {
                text += `${labels.join(': ')}: `;
            }

            text += `${n.fullName} {\n`;
            n.uniqueProperties().forEach(p => {
                text += indent + this.INDENT;
                if (p.boolean !== undefined) {
                    addEntity(p, p.name);
                } else {
                    addEntity(p, p.name);
                    text += ' = ';
                    addEntity(undefined, p.valueString((indent + this.INDENT + p.name + ' = ').length));
                }

                text += ';\n';
            });

            n.children().forEach(c => addNode(c, indent + this.INDENT));

            text += `${indent}};`;
            nodeEntity.end = text.length;
            text += '\n\n';
        };

        addNode(ctx.root);

        this.entities = entities.reverse(); // reverse to optimize the entity lookup
        return text;
    }
}
