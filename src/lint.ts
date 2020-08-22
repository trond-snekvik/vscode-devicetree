import * as vscode from 'vscode';
import { Parser, getCells, getPHandleCells, NodeEntry, Node, ArrayValue, IntValue, PHandle, StringValue, BoolValue, BytestringValue, DTSCtx } from './dts';
import * as types from './types';
import { DiagnosticsSet } from './diags';

export type LintCtx = { ctx: DTSCtx, types: types.TypeLoader, diags: DiagnosticsSet };

function lintNode(node: Node, ctx: LintCtx) {
    const props = node.uniqueProperties();

    props.forEach(prop => {
        // special properties:
        if (prop.name === 'reg') {
            const cells = getCells(prop.name, node.parent);

            if (cells && cells.length > 0) {
                const v = prop.value[0];
                if (!prop.array) {
                    const diag = ctx.diags.pushLoc(prop.loc, 'reg property must be a number array (e.g. < 1 2 3 >)', vscode.DiagnosticSeverity.Error);
                    if (v instanceof ArrayValue) {
                        diag.relatedInformation = v.val.filter(e => !(e instanceof IntValue)).map(e => new vscode.DiagnosticRelatedInformation(e.loc, `${e.toString()} is a ${v.constructor.name}`));
                    }
                } else if (prop.array.length !== cells.length) {
                    ctx.diags.pushLoc(prop.loc, `reg property must be on format < ${cells.join(' ')} >`, vscode.DiagnosticSeverity.Error);
                } else if (cells[0] === 'addr' && Number.isInteger(node.address) && node.address !== v.val[0].val) {
                    ctx.diags.pushLoc(v.val[0].loc, `Node address does not match address cell (expected 0x${node.address.toString(16)})`);
                }
            } else {
                ctx.diags.pushLoc(prop.loc, `Unable to fetch addr and size count`, vscode.DiagnosticSeverity.Error);
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

            if (!cells || !(cells.value.length === 1 && (cells.value[0] as ArrayValue).isNumber())) {
                ctx.diags.pushLoc(prop.loc, `Nexus nodes need cells specifier (Node is missing #${specifier}-cells property)`, vscode.DiagnosticSeverity.Error);
                return;
            }

            const cellCount = cells.value[0].val[0].val as number;
            if (mask && mask.array?.length !== cellCount) {
                ctx.diags.pushLoc(mask.loc, `Nexus mask must be an array of ${cellCount} masks (e.g. < ${new Array(cellCount).fill('0xffffffff').join(' ')} >)`, vscode.DiagnosticSeverity.Error);
                return;
            }

            if (passThru && mask.array?.length !== cellCount) {
                ctx.diags.pushLoc(passThru.loc, `Nexus pass thru mask must be an array of ${cellCount} masks (e.g. < ${new Array(cellCount).fill('0xffffffff').join(' ')} >)`, vscode.DiagnosticSeverity.Error);
                return;
            }

            const maskValue = mask ? (mask.value[0] as ArrayValue).val.map((v: IntValue) => v.val) : new Array<number>(cellCount).fill(0xffffffff);

            // Validate each map entry:
            const map = prop.value.map(v => {
                if (!(v instanceof ArrayValue)) {
                    ctx.diags.pushLoc(v.loc, `Nexus map values must be PHandle arrays`, vscode.DiagnosticSeverity.Error);
                    return;
                }

                const inputCells = v.val.slice(0, cellCount);
                const outputRef = v.val[cellCount];
                const outputCells = v.val.slice(cellCount + 1);
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

                if (outputCells.length !== outputCellProp.number) {
                    const diag = ctx.diags.pushLoc(outputRef.loc, `Node expects ${outputCellProp.number}, was ${outputCells.length}`, vscode.DiagnosticSeverity.Error);
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

                return { map: v, inputCells: inputCells.map(c => c.val as number), outputNode, outputCells: outputCells.map(c => c.val as number) };

            });

            // Look for duplicates:
            // If the masked inputCells are the same for several entries, it won't be possible to figure out which is which.
            const uniqueMaps: {[enc: string]: ArrayValue } = {};
            map.filter(m => m).forEach(m => {
                const encoded = `${m.inputCells.map((c, i) => '0x' + (c & maskValue[i]).toString(16)).join(' ')}`;
                if (encoded in uniqueMaps) {
                    const diag = ctx.diags.pushLoc(m.map.loc, `Entry is a duplicate (masked value of the first ${cellCount} cells must be unique)`);
                    diag.relatedInformation = [
                        new vscode.DiagnosticRelatedInformation(uniqueMaps[encoded].loc, `Duplicate of entry ${uniqueMaps[encoded].toString()}`),
                        new vscode.DiagnosticRelatedInformation(new vscode.Location(m.map.loc.uri, m.map.val[0].loc.range.union(m.map.val[1].loc.range)), `Masked value is ${encoded}`),
                    ];
                    if (mask) {
                        diag.relatedInformation.push(new vscode.DiagnosticRelatedInformation(mask.loc, 'Mask defined here'));
                    }
                } else {
                    uniqueMaps[encoded] = m.map;
                }
            });

        } else if (prop.name.endsWith('-names')) {
            /* <id>-names entries should map to a <id>s entry that is an array with the same number of elements. */
            const id = prop.name.match(/(.*)-names$/)[1];
            if (!prop.stringArray) {
                return; /* Generates warning in the property type check */
            }

            const name = id + 's';

            const named = node.property(name);
            if (!named) {
                ctx.diags.pushLoc(prop.loc, `No matching property to name (expected a property named ${name} in ${node.fullName})`);
                return;
            }

            if (named.value.length !== prop.value.length) {
                const diag = ctx.diags.pushLoc(prop.loc, `Expected ${named.value.length} names, found ${prop.value.length}`);
                diag.relatedInformation = [ new vscode.DiagnosticRelatedInformation(named.loc, `Property ${name} has ${named.value.length} elements.`)];
                return;
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

    // Check overlapping ranges
    const addressCells = node.property('#address-cells')?.number ?? 2;
    const sizeCells = node.property('#size-cells')?.number ?? 1;
    if (addressCells === 1 && sizeCells === 1) {
        const ranges = new Array<{ n: Node, start: number, size: number }>();
        node.children().forEach(c => {
            const reg = c.property('reg');
            if (c.enabled() && reg?.array) {
                const range = { n: c, start: reg.array[0], size: reg.array[1] };
                const overlap = ranges.find(r => r.start + r.size > range.start && range.start + range.size > r.start);
                if (overlap) {
                    c.entries.forEach(e => {
                        const diag = ctx.diags.pushLoc(e.nameLoc, `Range overlaps with ${overlap.n.fullName}`);
                        if (overlap.start < range.start) {
                            diag.message += ` (ends at 0x${(overlap.start + overlap.size).toString(16)})`;
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

    if (!node.type) {
        node.entries.forEach(entry => ctx.diags.pushLoc(entry.nameLoc, `Unknown node type`));
        return; // !!! The rest of the block depends on the type being resolved
    }

    if (node.parent?.type?.['bus']) {
        if (!node.type?.['on-bus']) {
            node.entries.forEach(entry => ctx.diags.pushLoc(entry.nameLoc, `Only ${node.parent.type['bus']} nodes accepted in ${node.parent.path}.`, vscode.DiagnosticSeverity.Error));
        } else if (node.type['on-bus'] !== node.parent?.type?.['bus']) {
            node.entries.forEach(entry => ctx.diags.pushLoc(entry.nameLoc, `Node should only occur on the ${node.type['on-bus']} bus.`, vscode.DiagnosticSeverity.Error));
        }
    } else if (node.type?.['on-bus']) {
        node.entries.forEach(entry => ctx.diags.pushLoc(entry.nameLoc, `Node should only occur on the ${node.type['on-bus']} bus.`, vscode.DiagnosticSeverity.Error));
    }

    if (node.parent && node.type["on-bus"] === 'spi') {
        const reg = node.property('reg')?.number;
        const cs = node.parent.property('cs-gpios');
        if (reg === undefined) {
            node.entries.forEach(e => ctx.diags.pushLoc(e.loc, `SPI devices must have a register property on the format < 1 >`, vscode.DiagnosticSeverity.Error));
        } else if (!cs?.pHandleArray) {
            node.parent.entries.forEach(e => ctx.diags.pushLoc(e.nameLoc, `Missing cs-gpios property. Required for nodes on spi bus.`, vscode.DiagnosticSeverity.Error));
        } else if (cs.pHandleArray.length <= reg) {
            node.entries.forEach(e => {
                const diag = ctx.diags.pushLoc(e.loc, `No cs-gpios entry for SPI device ${reg}`, vscode.DiagnosticSeverity.Error);
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
        prop.value.filter(v => v instanceof ArrayValue).forEach((v: ArrayValue) => {
            v.val.forEach((e, i) => {
                if (!(e instanceof PHandle)) {
                    return;
                }

                const ref = ctx.ctx.node(e.val);
                if (!ref) {
                    ctx.diags.pushLoc(e.loc, `Unknown label`);
                } else {
                    /* Some nodes define the number of additional cells required when they're being referenced, as a sort of parameter list.
                     * For instance, a PWM controller can have a property #pwm-cells = < 2 >, and when another node wants to reference it in a property called pwms,
                     * it has to follow the reference with two cells of numbers, e.g. like < &my-pwm 1 2 >.
                     */
                    const cells = getPHandleCells(prop.name, ref);
                    if (cells && cells.value.length === 1 && (cells.value[0] instanceof ArrayValue) && ((<ArrayValue>cells.value[0]).isNumber())) {
                        const count = cells.value[0].val[0] as number;
                        if (v.length < i + count) {
                            ctx.diags.pushLoc(e.loc, `${e.toString()} must be followed by ${count} cells`);
                        } else {
                            const nonNums = v.val.slice(i + 1, i + 1 + count).filter(e => !(e instanceof IntValue));
                            if (nonNums.length > 0) {
                                const diag = ctx.diags.pushLoc(e.loc, `${e.toString()} requires ${count} numeric cells when referenced`);
                                diag.relatedInformation = nonNums.map(n => new vscode.DiagnosticRelatedInformation(n.loc, `${n.toString()} is ${n.constructor.name}, expected number.`));
                            }
                        }
                    }

                }
            });
        });

        prop.value.filter(v => v instanceof PHandle).forEach((v: PHandle) => {
            if ((v instanceof PHandle) && !ctx.ctx.node(v.val)) {
                ctx.diags.pushLoc(v.loc, `Unknown path label`);
            }
        });

        // Some nodes don't adhere to the normal type checking:
        const specialNodes = [
            'chosen', 'aliases'
        ];

        if (specialNodes.includes(node.name)) {
            return;
        }

        // Per-property type check:
        const propType = node.type?.properties.find(p => p.name === prop.name);
        if (node.type && !propType) {
            ctx.diags.pushLoc(prop.loc, `Property not mentioned in "${node.type.name}"`);
            return; // !!! The rest only runs if we find the type
        }

        const actualPropType = prop.type();

        const equivalent = {
            'string-array': 'string',
            'phandle-array': 'phandles',
            'array': 'int'
        };

        if (propType.type !== 'compound') {
            if (Array.isArray(propType.type)) {
                if (!propType.type.includes(actualPropType) && !propType.type.map(t => equivalent[t]).includes(actualPropType)) {
                    ctx.diags.pushLoc(prop.loc, `Property value type must be one of ${propType.type.join(', ')}, was ${actualPropType}`);
                }
            } else if (propType.type !== actualPropType && equivalent[propType.type] !== actualPropType) {
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
            const diag = ctx.diags.pushLoc(p.loc, 'Overridden by later entry', vscode.DiagnosticSeverity.Hint);
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
