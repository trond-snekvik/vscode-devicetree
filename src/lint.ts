import * as vscode from 'vscode';
import { Parser, getCells, getPHandleCells, NodeEntry } from './dts';
import * as types from './types';
import { DiagnosticsSet } from './diags';
import { isArray } from 'util';

export type LintCtx = { parser: Parser, types: types.TypeLoader, diags: DiagnosticsSet };

function lintNode(entry: NodeEntry, ctx: LintCtx) {
    var node = entry.node;
    const props = node.properties();

    if (node.fullName === 'aliases' || node.fullName === 'chosen') {
        if (node.path === '/aliases/' || node.path === '/chosen/') {
            if (node.children().length > 0) {
                ctx.diags.pushLoc(entry.nameLoc, `Node ${node.name} shouldn't have child nodes`, vscode.DiagnosticSeverity.Error);
            }

            entry.properties.forEach(p => {
                if (p.value.raw.startsWith('&')) {
                    var ref = ctx.parser.getNode(p.value.raw);
                    if (!ref) {
                        ctx.diags.pushLoc(p.loc, `Unknown reference to ${p.value.raw}`, vscode.DiagnosticSeverity.Error);
                    }
                } else if (typeof p.value.actual === 'string') {
                    var ref = ctx.parser.getNode(p.value.actual);
                    if (!ref) {
                        ctx.diags.pushLoc(p.loc, `Unknown reference to ${p.value.raw}`, vscode.DiagnosticSeverity.Error);
                    }
                } else {
                    ctx.diags.pushLoc(p.loc, `Properties in ${node.name} must be references to nodes`, vscode.DiagnosticSeverity.Error);
                }
            });
        } else {
            ctx.diags.pushLoc(entry.nameLoc, `Node ${node.name} must be under the root node`, vscode.DiagnosticSeverity.Error);
        }
        return;
    }

    if (node.fullName === 'cpus') {
        if (node.path !== '/cpus/') {
            ctx.diags.pushLoc(entry.nameLoc, `Node cpus must be directly under the root node`, vscode.DiagnosticSeverity.Error);
        }
    }

    // Check overlapping ranges
    if (props.find(p => p.name === '#address-cells' && p.value.actual === 1) && props.find(p => p.name === '#size-cells' && p.value.actual === 1)) {
        let ranges = new Array<{ n: NodeEntry, start: number, size: number }>();
        entry.children.forEach(c => {
            let reg = c.properties.find(p => p.name === 'reg');
            if (c.node.enabled() && reg && isArray(reg.value.actual)) {
                let range = { n: c, start: reg.value.actual[0], size: reg.value.actual[1] };
                let overlap = ranges.find(r => r.start + r.size > range.start && range.start + range.size > r.start);
                if (overlap) {
                    let diag = ctx.diags.pushLoc(c.nameLoc, `Range overlaps with ${overlap.n.node.fullName}`);
                    if (overlap.start < range.start) {
                        diag.message += ` (ends at 0x${(overlap.start + overlap.size).toString(16)})`;
                    } else {
                        diag.message += ` (${c.node.fullName} ends at 0x${(range.start + range.size).toString(16)})`;
                    }
                    diag.relatedInformation = [new vscode.DiagnosticRelatedInformation(new vscode.Location(overlap.n.nameLoc.uri, overlap.n.nameLoc.range), `${overlap.n.node.fullName} declared here`)];
                }

                ranges.push(range);
            }
        });
    }

    if (!node.type) {
        ctx.diags.pushLoc(entry.nameLoc, `Unknown node type`);
        return;
    }

    if (node.type['on-bus'] && node.type['on-bus'] !== node.parent?.type?.['bus']) {
        ctx.diags.pushLoc(entry.nameLoc, `Node should only occur on the ${node.type['on-bus']} bus.`, vscode.DiagnosticSeverity.Error);
    }

    node.type.properties.forEach(propType => {
        var prop = props.find(p => p.name === propType.name);
        if (prop) {
            prop = entry.properties.find(p => p.name === prop.name);
            if (prop) {
                const correctType = (type: types.PropertyTypeString) => {
                    const isPhandleArrayElem = (e) => {
                        if (Array.isArray(e)) {
                            return e.every(isPhandleArrayElem);
                        }

                        return (typeof e === 'number') || (typeof e === 'string' && e.startsWith('&'));
                    };

                    switch (type) {
                        case 'array':
                            return (typeof prop.value.actual === 'number') || (Array.isArray(prop.value.actual) && (prop.value.actual as any[]).every(v => typeof v === 'number'));
                        case 'boolean':
                            return (typeof prop.value.actual === 'boolean');
                        case 'compound':
                            return true; // any
                        case 'int':
                            return (typeof prop.value.actual === 'number') || (Array.isArray(prop.value.actual) && prop.value.actual.length === 1 && typeof prop.value.actual[0] === 'number');
                        case 'phandle':
                            /* PHandles can be numbers if there's a node with that number as the value of their phandle property. */
                            return ((typeof prop.value.actual === 'object') && ('node' in prop.value.actual)) ||
                                ((typeof prop.value.actual === 'number') && (ctx.parser.getPHandleNode(prop.value.actual)));
                        case 'phandle-array':
                            return isPhandleArrayElem(prop.value.actual);
                        case 'string':
                            return (typeof prop.value.actual === 'string');
                        case 'string-array':
                            return (typeof prop.value.actual === 'string') || (Array.isArray(prop.value.actual) && (prop.value.actual as any[]).every(v => typeof v === 'string'));
                        case 'uint8-array':
                            return (Array.isArray(prop.value.actual) && (prop.value.actual as any[]).every(v => typeof v === 'number') && prop.value.raw.match(/\[[\da-fA-F\s]+\]/));
                        default:
                            return true;
                    }
                };

                if (Array.isArray(propType.type)) {
                    if (!propType.type.find(correctType)) {
                        ctx.diags.pushLoc(prop.loc, 'Property value type must be one of ' + propType.type.join(', '));
                    }
                } else if (!correctType(propType.type)) {
                    ctx.diags.pushLoc(prop.loc, `Property value type must be ${propType.type}`);
                }

                if (propType.enum && propType.enum.indexOf(prop.value.actual.toString()) < 0) {
                    ctx.diags.pushLoc(prop.loc, 'Property value must be one of ' + propType.enum.join(', '));
                }

                if (propType.const !== undefined && propType.const !== prop.value.actual) {
                    ctx.diags.pushLoc(prop.loc, `Property value must be ${propType.const}`);
                }

                if (propType.type === 'phandle-array') {
                    (<(string | number)[]>prop.value.actual).forEach(e => {
                        if (typeof e === 'string' && !ctx.parser.getPHandleNode(e.slice(1))) {
                            ctx.diags.pushLoc(prop.loc, `Unknown label`);
                        }
                    })
                }

                if (prop.name === 'reg') {
                    var cells = getCells(prop.name, node.parent);

                    if (cells) {
                        if ((typeof prop.value.actual === 'number' && cells.length !== 1) ||
                            (Array.isArray(prop.value.actual) && prop.value.actual.length !== cells.length)) {
                            ctx.diags.pushLoc(prop.loc, `reg property must be on format <${cells.join(' ')}>`, vscode.DiagnosticSeverity.Error);
                        } else if (cells.length > 0 && cells[0] === 'addr' && node.address !== NaN && node.address !== prop.value.actual && node.address !== prop.value.actual[0]) {
                            ctx.diags.pushLoc(prop.loc, `Node address does not match address cell (expected 0x${node.address.toString(16)})`);
                        }
                    } else {
                        ctx.diags.pushLoc(prop.loc, `Unable to fetch addr and size count`, vscode.DiagnosticSeverity.Error);
                    }

                    if (node.parent && node.type["on-bus"] === 'spi') {
                        let cs = node.parent.property('cs-gpios');
                        if (!cs || !Array.isArray(cs.value.actual) || cs.value.actual.length <= prop.value.actual) {
                            ctx.diags.pushLoc(prop.loc, `No cs-gpios entry for SPI device ${prop.value.actual}`);
                        }
                    }
                } else if (prop.name === 'compatible') {
                    let types: string[] = typeof prop.value.actual === 'string' ? [prop.value.actual] : prop.value.actual as string[];
                    types.forEach(t => {
                        var type = ctx.types.get(t);
                        if (!type) {
                            ctx.diags.pushLoc(prop.loc, `Unknown node type ${t}`);
                        }
                    });
                } else if (propType.type === 'phandle-array' && Array.isArray(prop.value.actual)) {
                    let c = getPHandleCells(prop.name, node.parent);
                    if (c) {
                        let value = c.value.actual as (string | number)[];
                        if (typeof c.value.actual === 'number') {
                            if ((value.length % (c.value.actual + 1)) !== 0) {
                                ctx.diags.pushLoc(prop.loc, `PHandle array must have ${c.value.actual} number cells`, vscode.DiagnosticSeverity.Error);
                            }
                        } else {
                            ctx.diags.pushLoc(prop.loc, `Parent's *-cells property must be an int`, vscode.DiagnosticSeverity.Error);
                        }
                    }
                }
            }
        } else if (propType.required) {
            let status = props.find(p => p.name === 'status');
            ctx.diags.pushLoc(entry.nameLoc, `Property "${propType.name}" is required`, (status && status.value.raw === 'okay') ? vscode.DiagnosticSeverity.Error : vscode.DiagnosticSeverity.Information);
        }
    });

    entry.properties.forEach(p => {
        if (!node.type.properties.find(t => t.name === p.name)) {
            ctx.diags.pushLoc(p.loc, `Property not mentioned in type "${node.type.name ?? (node.parent?.type?.name ?? '<unknown>') + '::child-node'}"`);
        }
    });
}

export function lint(entries: NodeEntry[], ctx: LintCtx) {
    entries.forEach(e => lintNode(e, ctx));
}