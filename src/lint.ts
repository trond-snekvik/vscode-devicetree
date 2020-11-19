/*
 * Copyright (c) 2020 Trond Snekvik
 *
 * SPDX-License-Identifier: MIT
 */
import * as vscode from 'vscode';
import { getPHandleCells, NodeEntry, Node, ArrayValue, IntValue, PHandle, StringValue, DTSCtx, Property } from './dts';
import * as types from './types';
import { DiagnosticsSet } from './diags';

export type LintCtx = { ctx: DTSCtx, types: types.TypeLoader, diags: DiagnosticsSet, gpioControllers: Node[], labels: {[name: string]: Node} };

function countText(count: number, text: string, plural?: string): string {
    if (!plural) {
        plural = text + 's';
    }

    let out = count.toString() + ' ';
    if (count === 1) {
        out += text;
    } else {
        out += plural;
    }

    return out;
}

function lintNode(node: Node, ctx: LintCtx) {
    const props = node.uniqueProperties();

    // Reset node pins in case they end up being removed:
    node.pins = undefined;

    props.forEach(prop => {
        // special properties:
        if (prop.name === 'reg') {
            const addrCells = node.parent?.addrCells() ?? 2;
            const sizeCells = node.parent?.sizeCells() ?? 1;
            const format = '< ' + [...new Array(addrCells).fill('addr'), ...new Array(sizeCells).fill('size')].join(' ') + ' >';
            if (!prop.pHandleArray) {
                ctx.diags.pushLoc(prop.loc, `reg property must be on the ${format} format`, vscode.DiagnosticSeverity.Error);
            } else {
                prop.pHandleArray.forEach((p, i) => {
                    if (p.val.length % (addrCells + sizeCells) || p.val.length === 0) {
                        ctx.diags.pushLoc(p.loc, `reg property must be on format ${format}.`, vscode.DiagnosticSeverity.Error);
                    } else if (i === 0 && addrCells === 1 && Number.isInteger(node.address) && node.address !== p.val[0].val) {
                        ctx.diags.pushLoc(p.val[0].loc, `Node address does not match address cell (expected 0x${node.address.toString(16)})`);
                        const action = ctx.diags.pushAction(new vscode.CodeAction('Change to match node address', vscode.CodeActionKind.QuickFix));
                        action.edit = new vscode.WorkspaceEdit();
                        action.edit.replace(p.val[0].loc.uri, p.val[0].loc.range, `0x${node.address.toString(16)}`);
                    }
                });
            }

            if (node.address === undefined) {
                node.entries.forEach(e => ctx.diags.pushLoc(e.nameLoc, `Nodes with reg properties must have a unit address.`));
            }
        } else if (prop.name === 'compatible') {
            const nonStrings = prop.value.filter(v => !(v instanceof StringValue));
            if (nonStrings.length > 0) {
                const diag = ctx.diags.pushLoc(prop.loc, `All values in compatible property must be strings`, vscode.DiagnosticSeverity.Error);
                diag.relatedInformation = nonStrings.map(v => new vscode.DiagnosticRelatedInformation(v.loc, `${v} is a ${v.constructor.name}`));
            }

            prop.value.filter(v => v instanceof StringValue).forEach((t: StringValue) => {
                const type = ctx.types.get(t.val);
                if (!type) {
                    ctx.diags.pushLoc(t.loc, `Unknown node type ${t}`);
                }
            });
        } else if (prop.name === 'interrupts-extended') {
            const interrupts = node.property('interrupts');
            if (interrupts) {
                const diag = ctx.diags.pushLoc(prop.loc, `The interrupts-extended or interrupts properties are mutually exclusive`);
                diag.relatedInformation = [new vscode.DiagnosticRelatedInformation(interrupts.loc, 'interrupts defined here')];
            }
        } else if (prop.name === 'ranges') {
            const ranges = new Array<{ childAddr: IntValue[], parentAddr: IntValue[], length: IntValue[] }>();
            const addrCells = node.addrCells();
            const parentAddrCells = node.parent?.addrCells() ?? 2;
            const sizeCells = node.sizeCells();

            if (sizeCells === 1) { // not sure how to deal with multidimensional stuff
                prop.pHandleArray?.forEach(v => {
                    if (!v.val.every(cell => cell instanceof IntValue)) {
                        return;
                    }

                    let i = 0;
                    while (i + addrCells + parentAddrCells + sizeCells <= v.val.length) {
                        const entry = v.val.slice(i, i + addrCells + parentAddrCells + sizeCells);
                        const range = {
                            childAddr: <IntValue[]>entry.slice(0, addrCells),
                            parentAddr: <IntValue[]>entry.slice(addrCells, addrCells + parentAddrCells),
                            length: <IntValue[]>entry.slice(addrCells + parentAddrCells),
                        };

                        const rangeLoc = r => new vscode.Location(prop.valueLoc.uri, new vscode.Range(r.childAddr[0].loc.range.start, r.length[0].loc.range.end));

                        const overlap = ranges.find(r => {
                            for (let j = 0; j < addrCells; j++) {
                                if ((r.childAddr[j].val >= range.childAddr[j].val && r.childAddr[j].val < range.childAddr[j].val + range.length[j].val) ||
                                    (range.childAddr[j].val >= r.childAddr[j].val && range.childAddr[j].val < r.childAddr[j].val + r.length[j].val)) {
                                    return true;
                                }
                            }
                        });

                        if (overlap) {
                            const diag = ctx.diags.pushLoc(rangeLoc(range), `Ranges shouldn't overlap.`);
                            diag.relatedInformation = [new vscode.DiagnosticRelatedInformation(rangeLoc(overlap), 'Overlaps with ' + overlap.childAddr[0].toString(true))];
                        }

                        ranges.push(range);
                        i += entry.length;
                    }

                    v.val.slice(i).forEach(c => ctx.diags.pushLoc(c.loc, `Excessive range entries`));
                });

                if (ranges.length) {
                    // All children must have addresses in the childAddr ranges:
                    node.children().forEach(c => {
                        c.regs().forEach(reg => {
                            reg.addrs.slice(0, addrCells).some((addr, i) => {
                                if (!ranges.find(r => addr.val >= r.childAddr[i].val && addr.val < r.childAddr[i].val + r.length[0].val)) {
                                    const loc = new vscode.Location(reg.addrs[0].loc.uri, reg.addrs[0].loc.range.union([...reg.addrs, ...reg.sizes].pop().loc.range));
                                    const diag = ctx.diags.pushLoc(loc, `Not in parent address range`);
                                    diag.relatedInformation = [new vscode.DiagnosticRelatedInformation(prop.loc, `Parent ranges property declared here`)];
                                    return true;
                                }
                            });
                        });
                    });
                }
            }

        } else if (prop.name.endsWith('-map')) {
            /* Nexus nodes have specifier maps (section 2.5.1 of the spec).
             * These specifier maps are lists of translations to other entries.
             * For instance, an alias for a gpio header with different pin numbers, can have a list of mappings from its own
             * pins to another gpio header.
             *
             * Each entry in the map has three components:
             * - Input cells: a list of number-cells matching the reference cells. These are matched against the input
             *   parameters when this node is referenced, to figure out which entry to translate it to.
             * - Output node: a PHandle pointing to the node we're mapping to
             * - Output cells: The cell values to send to the referenced node.
             *
             * When doing lookup into the specifier map, we'll first apply a mask to the input cells ("<specifier>-map-mask" property),
             * then run through every entry in the <specifier>-map to find matching input cells. When we find a matching entry, we'll translate
             * the input to the output reference, and pass through cell values that match the <specifier>-map-pass-thru value.
             *
             * Example: a nexus node is named shield, and has these properties:
             * #gpio-cells = < 2 >;
             * gpio-map-mask = < 0xffffffff 0xfffffff0 >;
             * gpio-map-pass-thru = < 0x00 0x0f >;
             * gpio-map = < 0x00 0x10 &gpio0 0x15 0x10>, < 0x00 0x00 &gpio0 0x15 0x00>, < 0x01 0x00 &gpio0 0x03 0x00>;
             *
             * When we reference the nexus node and the gpio node, the following is equivalent:
             * <&shield 0x00 0x10> and <&gpio0 0x15 0x10>
             * <&shield 0x00 0x13> and <&gpio0 0x15 0x13>
             * <&shield 0x00 0x08> and <&gpio0 0x15 0x08>
             * <&shield 0x01 0x08> and <&gpio0 0x03 0x08>
             * And the following produces an error, as the masked cell values can't be found in the map:
             * <&shield 0x00 0x20>
             * <&shield 0x01 0x10>
             * <&shield 0x02 0x00>
             */

            // Validate nexus node format:
            const specifier = prop.name.match(/^(.*)-map$/)[1];
            const cells = props.find(p => p.name === `#${specifier}-cells`);
            const mask = props.find(p => p.name === `${specifier}-map-mask`);
            const passThru = props.find(p => p.name === `${specifier}-map-pass-thru`);
            const addressCells = node.parent?.addrCells() ?? 2;
            const isInterrupt = specifier === 'interrupt';

            // const map = prop.nexusMap;
            // if (!map) {
            //     return; // todo: diag?
            // }

            if (!cells?.number) {
                ctx.diags.pushLoc(prop.loc, `Nexus nodes need numeric cells specifier (Node is missing #${specifier}-cells property)`, vscode.DiagnosticSeverity.Error);
                return;
            }

            const cellCount = isInterrupt ? cells.number + addressCells : cells.number;
            if (mask && mask.array?.length !== cellCount) {
                ctx.diags.pushLoc(mask.loc, `Nexus mask must be an array of ${countText(cellCount, 'mask')} (e.g. < ${new Array(cellCount).fill('0xffffffff').join(' ')} >)`, vscode.DiagnosticSeverity.Error);
                return;
            }

            if (passThru && mask.array?.length !== cellCount) {
                ctx.diags.pushLoc(passThru.loc, `Nexus pass thru mask must be an array of ${countText(cellCount, 'mask')} (e.g. < ${new Array(cellCount).fill('0xffffffff').join(' ')} >)`, vscode.DiagnosticSeverity.Error);
                return;
            }

            const maskValue = mask ? (mask.value[0] as ArrayValue).val.map((v: IntValue) => v.val) : new Array<number>(cellCount).fill(0xffffffff);

            if (prop.value.filter(v => {
                if (!(v instanceof ArrayValue)) {
                    ctx.diags.pushLoc(v.loc, `Nexus map values must be PHandle arrays`, vscode.DiagnosticSeverity.Error);
                    return true;
                }
            }).length) {
                return;
            }

            // Map entries are either formatted as < 1 2 &ref 3 4>, < 5 6 &ref 7 8 > or < 1 2 &ref 3 4 5 6 &ref 7 8 >, so we flatten them:
            const merged = prop.value.flatMap(v => <(IntValue | PHandle)[]>v.val);

            // Use the reference node as an anchor for each entry: each entry starts with <cellCount> * input + ref, but the output cell count varies.
            const entries: (PHandle | IntValue)[][] = [];
            let outputCells = [];
            while (merged.length) {
                const cell = merged.pop(); // traversing from the back
                if (cell instanceof PHandle) {
                    if (merged.length < cellCount) {
                        break;
                    }

                    const inputCells = new Array(cellCount).fill(null).map(_ => merged.pop()).reverse();
                    entries.push([...inputCells, cell, ...outputCells.reverse()]);
                    outputCells = [];
                } else {
                    outputCells.push(cell);
                }
            }

            // Validate each map entry:
            const map = entries.reverse().map(v => {
                const inputCells = v.slice(0, cellCount);
                const outputRef = v[cellCount];
                const outputCells = v.slice(cellCount + 1);

                if (inputCells.filter(c => {
                        if (c instanceof IntValue) {
                            return false;
                        }
                        ctx.diags.pushLoc(c.loc, `Input cells must be numbers, is ${c.constructor.name}`, vscode.DiagnosticSeverity.Error);
                        return true;
                    }).length) {
                    return;
                }

                if (!(outputRef instanceof PHandle)) {
                    const diag = ctx.diags.pushLoc(outputRef.loc, `Cell number ${cellCount + 1} should be a node reference`, vscode.DiagnosticSeverity.Error);
                    diag.relatedInformation = [new vscode.DiagnosticRelatedInformation(cells.loc, `#${specifier}-cells is ${cellCount}`)];
                    return;
                }

                const outputNode = ctx.ctx.node(outputRef.val);
                if (!outputNode) {
                    return; // Already generates a warning in the general PHandle check
                }

                const outputCellProp = outputNode.property(`#${specifier}-cells`);
                if (!outputCellProp) {
                    ctx.diags.pushLoc(outputRef.loc, `${outputRef.val} missing #${specifier}-cells property`, vscode.DiagnosticSeverity.Error);
                    return;
                }

                if (outputCellProp.number === undefined) {
                    return; // Already generates a warning in the general #-cells check
                }

                let expectedOutputCells = outputCellProp.number;
                if (isInterrupt) {
                    expectedOutputCells += outputNode.addrCells();
                }

                if (outputCells.length !== expectedOutputCells) {
                    const diag = ctx.diags.pushLoc(outputRef.loc, `Node expects ${countText(expectedOutputCells, 'cell parameter')}, got ${outputCells.length}`, vscode.DiagnosticSeverity.Error);
                    diag.relatedInformation = [new vscode.DiagnosticRelatedInformation(outputCellProp.loc, `${outputCellProp.name} declared here`)];
                    return;
                }


                if (outputCells.filter(c => {
                        if (c instanceof IntValue) {
                            return false;
                        }

                        ctx.diags.pushLoc(c.loc, `Output cells must be numbers, is ${c.constructor.name}`, vscode.DiagnosticSeverity.Error);
                        return true;
                    }).length) {
                    return;
                }

                return { map: v, loc: new vscode.Location(v[0].loc.uri, new vscode.Range(v[0].loc.range.start, v[v.length - 1].loc.range.end)), inputCells: inputCells.map(c => c.val as number), outputNode, outputCells: outputCells.map(c => c.val as number) };
            });

            // Look for duplicates:
            // If the masked inputCells are the same for several entries, it won't be possible to figure out which is which.
            const uniqueMaps: { [enc: string]: { map: (PHandle | IntValue)[], loc: vscode.Location, inputCells: number[], outputNode: Node, outputCells: number[] } } = {};
            map.filter(m => m).forEach(m => {
                const encoded = `${m.inputCells.map((c, i) => '0x' + (c & maskValue[i]).toString(16)).join(' ')}`;
                if (encoded in uniqueMaps) {
                    const diag = ctx.diags.pushLoc(m.loc, `Entry is a duplicate (masked value of the first ${countText(cellCount, 'cell')} must be unique)`);
                    diag.relatedInformation = [
                        new vscode.DiagnosticRelatedInformation(uniqueMaps[encoded].loc, `Duplicate of entry ${uniqueMaps[encoded].toString()}`),
                        new vscode.DiagnosticRelatedInformation(new vscode.Location(m.loc.uri, m.map[0].loc.range.union(m.map[1].loc.range)), `Masked value is ${encoded}`),
                    ];
                    if (mask) {
                        diag.relatedInformation.push(new vscode.DiagnosticRelatedInformation(mask.loc, 'Mask defined here'));
                    }
                } else {
                    uniqueMaps[encoded] = m;
                }
            });

        } else if (prop.name.endsWith('-names')) {
            /* <id>-names entries should map to a <id>s entry that is an array with the same number of elements. */
            const id = prop.name.match(/(.*)-names$/)[1];
            const names = prop.stringArray;
            if (!names) {
                return; /* Generates warning in the property type check */
            }

            const name = id + 's';

            const named = node.property(name);
            if (!named) {
                // Can also be named <id>-0, <id>-1 and so on:
                const indexed = names.map((_, i) => node.property(id + '-' + i));
                const missing = [];
                if (!indexed.some((prop, i) => {
                    if (prop) return true;
                    missing.push(i);
                })) {
                    ctx.diags.pushLoc(prop.loc, `No matching property to name (expected a property named ${name} in ${node.fullName})`);
                } else {
                    missing.forEach(i => ctx.diags.pushLoc(prop.value[i].loc, `No matching property to name (expected a property named ${name}-${i} in ${node.fullName})`));
                }
                return;
            }

            /* The cell count of each entry should be determined by the parent for that property,
             * which can be found in the property <id>-parent. This parent has a property called #<id>-cells,
             * which determines the cell count of each entry. Falls back to 1.
             */
            let cells = 1;
            const parentRef = node.property(id + '-parent')?.pHandle;
            if (parentRef) {
                cells = ctx.ctx.node(parentRef.val)?.cellCount(name);
            }

            if (named.value.length !== cells * prop.value.length) {
                const diag = ctx.diags.pushLoc(prop.loc, `Expected ${countText(named.value.length, 'name')}, found ${prop.value.length}`);
                diag.relatedInformation = [ new vscode.DiagnosticRelatedInformation(named.loc, `Property ${name} has ${countText(named.value.length, 'element')}.`)];
                return;
            }
        } else if (prop.name === 'label' && prop.string) {
            if (prop.string in ctx.labels) {
                const diag = ctx.diags.pushLoc(prop.valueLoc, `Label "${prop.string}" already used by ${ctx.labels[prop.string].uniqueName}.\nLabels must be unique to be unambigously accesible by device_get_binding()`);
                diag.relatedInformation = [new vscode.DiagnosticRelatedInformation(ctx.labels[prop.string].entries[0]?.loc, `${ctx.labels[prop.string].uniqueName} defined here`)];
            } else {
                ctx.labels[prop.string] = prop.entry.node;
            }
        }
    });

    if (node.fullName === 'aliases' || node.fullName === 'chosen') {
        if (node.path === '/aliases/' || node.path === '/chosen/') {
            if (node.children().length > 0) {
                node.entries.forEach(entry => ctx.diags.pushLoc(entry.nameLoc, `Node ${node.name} shouldn't have child nodes`, vscode.DiagnosticSeverity.Error));
            }

            node.entries.forEach(entry => entry.properties.forEach(p => {
                if (p.value.length !== 1) {
                    ctx.diags.pushLoc(p.loc, `All properties in ${node.fullName} must be singluar`, vscode.DiagnosticSeverity.Error);
                    return;
                }

                const val = p.pHandle?.val ?? p.string;
                if (!val) {
                    ctx.diags.pushLoc(p.loc, `Properties in ${node.name} must be references to nodes`, vscode.DiagnosticSeverity.Error);
                } else if (!ctx.ctx.node(val)) {
                    ctx.diags.pushLoc(p.loc, `Unknown reference to ${val.toString()}`, vscode.DiagnosticSeverity.Error);
                }
            }));
        } else {
            node.entries.forEach(entry => ctx.diags.pushLoc(entry.nameLoc, `Node ${node.name} must be under the root node`, vscode.DiagnosticSeverity.Error));
        }
        return;
    }

    if (node.fullName === 'cpus') {
        if (node.path !== '/cpus/') {
            node.entries.forEach(entry => ctx.diags.pushLoc(entry.nameLoc, `Node cpus must be directly under the root node`, vscode.DiagnosticSeverity.Error));
        }
    }

    if (node.address !== undefined && !node.property('reg') && !node.property('ranges')) {
        node.entries.filter(e => !e.ref).forEach(e => {
            ctx.diags.pushLoc(e.nameLoc, `If the node has no reg or ranges property, the @unit-address must be omitted`);
            const action = ctx.diags.pushAction(new vscode.CodeAction(`Remove unit address`, vscode.CodeActionKind.QuickFix));
            action.edit = new vscode.WorkspaceEdit();
            action.edit.replace(e.nameLoc.uri, e.nameLoc.range, node.name);
        });
    }

    // Check overlapping ranges
    const addressCells = node.addrCells();
    const sizeCells = node.sizeCells();
    if (addressCells === 1 && sizeCells === 1) {
        const ranges = new Array<{ n: Node, start: number, size: number }>();
        node.children().forEach(c => {
            const reg = c.property('reg');
            if (c.enabled() && !c.deleted && reg?.array) {
                const range = { n: c, start: reg.array[0], size: reg.array[1] };
                const overlap = ranges.find(r => r.start + r.size > range.start && range.start + range.size > r.start);
                if (overlap) {
                    c.entries.forEach(e => {
                        const diag = ctx.diags.pushLoc(reg.valueLoc, `Address range collides with ${overlap.n.fullName}`);
                        if (overlap.start < range.start) {
                            diag.message += ` (ends at 0x${(overlap.start + overlap.size).toString(16)})`;
                        } else if (overlap.start === range.start) {
                            diag.message += ` (${c.fullName} also starts at 0x${(range.start + range.size).toString(16)})`;
                        } else {
                            diag.message += ` (${c.fullName} ends at 0x${(range.start + range.size).toString(16)})`;
                        }

                        diag.relatedInformation = [new vscode.DiagnosticRelatedInformation(overlap.n.entries[0].nameLoc, `${overlap.n.fullName} declared here`)];
                    });
                }

                ranges.push(range);
            }
        });
    }

    if (node.deleted) {
        node.entries.forEach(entry => {
            const diag = ctx.diags.pushLoc(entry.nameLoc, `Deleted`, vscode.DiagnosticSeverity.Hint);
            diag.relatedInformation = [new vscode.DiagnosticRelatedInformation(node.deleted, 'Deleted here')];
            diag.tags = [vscode.DiagnosticTag.Deprecated];
        });
    }

    if (!node.type) {
        node.entries.forEach(entry => ctx.diags.pushLoc(entry.nameLoc, `Unknown node type`));
        return; // !!! The rest of the block depends on the type being resolved
    }

    // Check overlapping and out-of-bounds GPIO pin assignments
    const pinIdx = node.type.cells('gpio')?.indexOf('pin') ?? -1;
    if (node.property('gpio-controller') && pinIdx >= 0) {
        const firstPin = ctx.gpioControllers.reduce((sum, n) => sum += n.property('ngpios')?.number ?? 32, 0);
        const maxPins = node.property('ngpios')?.number ?? 32;
        const refs = new Array<{ prop: Property, target?: PHandle, cells: IntValue[] }>();
        ctx.ctx.nodeArray().filter(n => n.enabled()).forEach(n => {
            n.properties().forEach(p => {
                if (p.name.endsWith('-pin') && p.number !== undefined) {
                    refs.push({cells: (p.value[0] as ArrayValue).val as IntValue[], prop: p});
                } else {
                    refs.push(...p.entries?.filter(entry => entry.target.is(node)).map(entry => ({ prop: p, ...entry })) ?? []);
                }
            });
        });

        node.pins = new Array(maxPins).fill(undefined);
        refs.forEach(ref => {
            const pin = ref.cells[pinIdx];
            if (!pin) {
                return;
            }

            if (!ref.target) { // raw pin reference, e.g. sck-pin = < 5 >;
                if (pin.val - firstPin >= firstPin && pin.val - firstPin < firstPin + maxPins) {
                    node.pins[pin.val - firstPin] = ref;
                }
            } else if (pin.val >= maxPins) {
                ctx.diags.pushLoc(pin.loc, `Pin ${pin.val} does not exist on ${ref.target?.val ?? node.uniqueName}: Only has ${maxPins} pins.`);
            } else if (node.pins[pin.val]) {
                const diag = ctx.diags.pushLoc(pin.loc, `Pin ${pin.val} of ${ref.target?.val ?? node.uniqueName} already assigned to ${node.pins[pin.val].prop.entry.node.path}${node.pins[pin.val].prop.name}`, vscode.DiagnosticSeverity.Information);
                diag.relatedInformation = [new vscode.DiagnosticRelatedInformation(node.pins[pin.val].prop.loc, "Overlapping assignment")];
            } else {
                node.pins[pin.val] = ref;
            }
        });

        ctx.gpioControllers.push(node);
    }

    // STM32 pinmux:
    props.filter(p => p.name.match(/^pinctrl(-\d+)?/) && p.pHandles).forEach(prop => {
        prop.pHandles.map(handle => ctx.ctx.node(handle.val)).filter(n => n?.property('pinmux')?.number !== undefined).forEach(pinmux => {
            const bitfield = pinmux.property('pinmux').number;
            const port = (bitfield >> 12);
            const pin = (bitfield >> 8) & 0x0f;
            const controller = ctx.gpioControllers?.[port];
            if (!controller) {
                return;
            }

            if (pin > controller.pins?.length) {
                ctx.diags.pushLoc(prop.loc, `No pin ${pin} of ${controller.uniqueName}`, vscode.DiagnosticSeverity.Warning);
            } else if (controller.pins?.[pin]) {
                const diag = ctx.diags.pushLoc(prop.loc, `Pin ${pin} of ${controller.uniqueName} already assigned to ${controller.pins[pin].prop.entry.node.path}${controller.pins[pin].prop.name}`, vscode.DiagnosticSeverity.Information);
                diag.relatedInformation = [new vscode.DiagnosticRelatedInformation(controller.pins[pin].prop.loc, "Overlapping assignment")];
            } else {
                controller.pins[pin] = { prop, cells: [], pinmux };
            }
        });

    });

    if (node.parent?.type?.bus) {
        if (!node.type?.onBus) {
            node.entries.forEach(entry => ctx.diags.pushLoc(entry.nameLoc, `Only ${node.parent.type.bus} nodes accepted in ${node.parent.path}.`, vscode.DiagnosticSeverity.Error));
        } else if (node.type.onBus !== node.parent?.type?.bus) {
            node.entries.forEach(entry => ctx.diags.pushLoc(entry.nameLoc, `Node should only occur on the ${node.type.onBus} bus.`, vscode.DiagnosticSeverity.Error));
        }
    } else if (node.type?.onBus) {
        node.entries.forEach(entry => ctx.diags.pushLoc(entry.nameLoc, `Node should only occur on the ${node.type.onBus} bus.`, vscode.DiagnosticSeverity.Error));
    }

    if (node.parent && node.type.onBus === 'spi') {
        const reg = node.property('reg')?.number;
        const cs = node.parent.property('cs-gpios');
        if (reg === undefined) {
            node.entries.forEach(e => ctx.diags.pushLoc(e.loc, `SPI devices must have a register property on the format < 1 >`, vscode.DiagnosticSeverity.Error));
        } else if (!cs?.pHandleArray) {
            node.parent.entries.forEach(e => ctx.diags.pushLoc(e.nameLoc, `Missing cs-gpios property. Required for nodes on spi bus.`, vscode.DiagnosticSeverity.Error));
        } else if (cs.pHandleArray.length <= reg) {
            node.entries.forEach(e => {
                const diag = ctx.diags.pushLoc(e.nameLoc, `No cs-gpios entry for SPI device ${reg}`, vscode.DiagnosticSeverity.Error);
                diag.relatedInformation = [new vscode.DiagnosticRelatedInformation(cs.loc, `SPI bus cs-gpios property declared here`)];
            });
        }
    }

    node.type.properties.forEach(propType => {
        if (!node.property(propType.name) && propType.required) {
            node.entries.forEach(e => ctx.diags.pushLoc(e.nameLoc, `Property "${propType.name}" is required`, node.enabled() ? vscode.DiagnosticSeverity.Error : vscode.DiagnosticSeverity.Information));
        }
    });

}

function lintEntry(entry: NodeEntry, ctx: LintCtx) {
    const node = entry.node;

    entry.properties.forEach(prop => {
        // type specific checks:

        // Phandle arrays
        prop.value.filter(v => v instanceof ArrayValue).forEach((v: ArrayValue) => {

            const getIndent = () => {
                const additionalIndent = prop.valueLoc.range.start.character - prop.loc.range.start.character;
                const tabsize = (<number>vscode.window.activeTextEditor?.options.tabSize ?? 8);
                if (vscode.window.activeTextEditor?.options.insertSpaces) {
                    return ' '.repeat((prop.entry.depth + 1) * tabsize) + ' '.repeat(additionalIndent);
                }

                return '\t'.repeat(prop.entry.depth + 1) + '\t'.repeat(additionalIndent / tabsize) + ' '.repeat(additionalIndent % tabsize);
            };

            if (prop.name === 'reg') {
                const regs = prop.regs;
                if (regs?.length) {
                    if (regs.length !== prop.value.length) {
                        ctx.diags.pushLoc(prop.valueLoc, 'Can be split into multiple entries', vscode.DiagnosticSeverity.Hint);
                        const action = ctx.diags.pushAction(new vscode.CodeAction(`Split into ${countText(regs.length, 'entry', 'entries')}`, vscode.CodeActionKind.RefactorRewrite));
                        action.edit = new vscode.WorkspaceEdit();
                        action.edit.replace(prop.valueLoc.uri,
                            prop.valueLoc.range,
                            regs.map(e => `< ${[...e.addrs, ...e.sizes].map(c => c.toString(true) + ' ').join('')}>`).join(',\n' + getIndent()));
                    }

                    return;
                }
            }

            // nexus nodes have their own checks:
            const nexusMap = prop.nexusMap;
            if (nexusMap) {
                if (nexusMap.length != prop.value.length) {
                    ctx.diags.pushLoc(prop.valueLoc, 'Can be split into multiple entries', vscode.DiagnosticSeverity.Hint);
                    const action = ctx.diags.pushAction(new vscode.CodeAction(`Split into ${countText(nexusMap.length, 'entry', 'entries')}`, vscode.CodeActionKind.RefactorRewrite));
                    action.edit = new vscode.WorkspaceEdit();
                    action.edit.replace(prop.valueLoc.uri,
                        prop.valueLoc.range,
                        nexusMap.map(e => `< ${e.in.map(c => c.toString(true) + ' ').join('')}${e.target.toString()} ${e.out.map(c => c.toString(true) + ' ').join('')}>`).join(',\n' + getIndent()));
                }

                return;
            }

            const entries = prop.entries;
            if (entries?.length) {
                if (entries.length != prop.value.length) {
                    ctx.diags.pushLoc(prop.valueLoc, 'Can be split into multiple entries', vscode.DiagnosticSeverity.Hint);
                    const action = ctx.diags.pushAction(new vscode.CodeAction(`Split into ${countText(entries.length, 'entry', 'entries')}`, vscode.CodeActionKind.RefactorRewrite));
                    action.edit = new vscode.WorkspaceEdit();
                    action.edit.replace(prop.valueLoc.uri,
                        prop.valueLoc.range,
                        entries.map(e => `< ${e.target.toString()} ${e.cells.map(c => c.toString(true) + ' ').join('')}>`).join(',\n' + getIndent()));
                }

                entries.forEach(e => {
                    const ref = ctx.ctx.node(e.target.val);
                    if (!ref) {
                        ctx.diags.pushLoc(e.target.loc, `Unknown node`);
                        return;
                    }

                    if (e.target.kind !== 'ref' && ref.labels().length) {
                        ctx.diags.pushLoc(e.target.loc, 'Can be converted to label reference', vscode.DiagnosticSeverity.Hint);
                        const action = ctx.diags.pushAction(new vscode.CodeAction('Convert to label reference', vscode.CodeActionKind.RefactorRewrite));
                        action.edit = new vscode.WorkspaceEdit();
                        action.edit.replace(e.target.loc.uri, e.target.loc.range, '&' + ref.labels()[0]);
                    }

                    /* Some nodes define the number of additional cells required when they're being referenced, as a sort of parameter list.
                     * For instance, a PWM controller can have a property #pwm-cells = < 2 >, and when another node wants to reference it in a property called pwms,
                     * it has to follow the reference with two cells of numbers, e.g. like < &my-pwm 1 2 >.
                     */
                    const cells = getPHandleCells(prop.name, ref);
                    if (cells?.number === undefined) {
                        return;
                    }

                    const count = cells.number;
                    if (e.cells.length !== count) {
                        ctx.diags.pushLoc(e.target.loc, `${e.target.toString()} expects ${countText(count, 'parameter cell')}.`, vscode.DiagnosticSeverity.Error);
                        return;
                    }
                });
            }
        });

        prop.value.filter(v => v instanceof PHandle).forEach((v: PHandle) => {
            if ((v instanceof PHandle) && !ctx.ctx.node(v.val)) {
                ctx.diags.pushLoc(v.loc, `Unknown path label`);
            }
        });

        // Some nodes don't adhere to the normal type checking:
        const specialNodes = [
            'chosen', 'aliases', 'zephyr,user'
        ];

        if (specialNodes.includes(node.name)) {
            return;
        }

        // Per-property type check:
        const propType = node.type?.property(prop.name);

        if (!propType) {
            if (node.type?.valid) {
                ctx.diags.pushLoc(prop.loc, `Property not mentioned in "${node.type.name}"`);
            }

            return; // !!! The rest only runs if we find the type
        }

        const actualPropType = prop.type();

        const equivalent: {[name: string]: string[]} = {
            'string-array': ['string'],
            'phandle-array': ['phandles', 'phandle'],
            'phandles': ['phandle'],
            'array': ['int']
        };

        if (actualPropType === 'invalid') {
            ctx.diags.pushLoc(prop.valueLoc, `Invalid property value`, vscode.DiagnosticSeverity.Error);
        } else if (propType.type !== 'compound') {
            if (Array.isArray(propType.type)) {
                if (!propType.type.includes(actualPropType) && !propType.type.find(t => equivalent[t]?.includes(actualPropType))) {
                    ctx.diags.pushLoc(prop.loc, `Property value type must be one of ${propType.type.join(', ')}, was ${actualPropType}`);
                }
            } else if (propType.type && propType.type !== actualPropType && !equivalent[propType.type]?.includes(actualPropType)) {
                ctx.diags.pushLoc(prop.loc, `Property value type must be ${propType.type}, was ${actualPropType}`);
            }
        }

        if (propType.enum) {
            if (prop.value.length > 1) {
                ctx.diags.pushLoc(prop.loc, `Expected non-array type for value with enum`);
            } else if (!propType.enum.includes(prop.value[0].val.toString())) {
                ctx.diags.pushLoc(prop.loc, 'Property value must be one of ' + propType.enum.join(', '));
            }
        }

        if (propType.const !== undefined && propType.const !== (prop.number ?? prop.string)) {
            ctx.diags.pushLoc(prop.loc, `Property value must be ${propType.const}`);
        }
    });

    let redundantEntries = 0;
    entry.properties.forEach(p => {
        const final = node.property(p.name);
        if (p !== final) {
            const diag = ctx.diags.pushLoc(new vscode.Location(p.loc.uri, p.fullRange), 'Overridden by later entry', vscode.DiagnosticSeverity.Hint);
            diag.tags = [vscode.DiagnosticTag.Unnecessary];
            diag.relatedInformation = [new vscode.DiagnosticRelatedInformation(final.loc, 'Active entry defined here')];
            redundantEntries++;
        }
    });

    if (entry.properties.length === 0 && entry.children.length === 0) {
        const diag = ctx.diags.pushLoc(entry.nameLoc, 'Empty node', vscode.DiagnosticSeverity.Hint);
        diag.tags = [vscode.DiagnosticTag.Unnecessary];
    } else if (redundantEntries === entry.properties.length && entry.children.length === 0) {
        const diag = ctx.diags.pushLoc(entry.nameLoc, 'All properties are overridden by later entries', vscode.DiagnosticSeverity.Hint);
        diag.tags = [vscode.DiagnosticTag.Unnecessary];
    }
}

export function lint(ctx: LintCtx) {
    ctx.ctx.entries.forEach(e => lintEntry(e, ctx));
    Object.values(ctx.ctx.nodes).forEach(n => lintNode(n, ctx));
}
