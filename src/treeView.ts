/*
 * Copyright (c) 2020 Trond Snekvik
 *
 * SPDX-License-Identifier: MIT
 */
import * as vscode from 'vscode';
import * as path from 'path';
import { DTSCtx, DTSFile, Node, Parser, PHandle, Property} from './dts';
import { countText } from './util';

function iconPath(name: string) {
    return {
        dark: __dirname + `/../icons/dark/${name}.svg`,
        light: __dirname + `/../icons/light/${name}.svg`,
    };
}

class TreeInfoItem {
    ctx: DTSCtx;
    name: string;
    icon?: string;
    parent?: TreeInfoItem;
    path?: string;
    description?: string;
    tooltip?: string;
    private _children: TreeInfoItem[];

    constructor(ctx: DTSCtx, name: string, icon?: string, description?: string) {
        this.ctx = ctx;
        this.name = name;
        this.icon = icon;
        this.description = description;
        this._children = [];
    }

    get children(): ReadonlyArray<TreeInfoItem> {
        return this._children;
    }

    get id(): string {
        if (this.parent) {
            return `${this.parent.id}.${this.name}(${this.description ?? ''})`;
        }
        return this.name;
    }

    addChild(child: TreeInfoItem) {
        child.parent = this;
        this._children.push(child);
    }
}

type NestedInclude = { uri: vscode.Uri, file: DTSFile };
type DTSTreeItem = DTSCtx | DTSFile | NestedInclude | TreeInfoItem;

export class DTSTreeView implements
    vscode.TreeDataProvider<DTSTreeItem> {
    parser: Parser;
    treeView: vscode.TreeView<DTSTreeItem>;
    private treeDataChange: vscode.EventEmitter<void | DTSCtx>;
    onDidChangeTreeData: vscode.Event<void | DTSCtx>;

    constructor(parser: Parser) {
        this.parser = parser;

        this.treeDataChange = new vscode.EventEmitter<void | DTSCtx>();
        this.onDidChangeTreeData = this.treeDataChange.event;

        this.parser.onChange(ctx => this.treeDataChange.fire());
        this.parser.onDelete(ctx => this.treeDataChange.fire());

        this.treeView = vscode.window.createTreeView('trond-snekvik.devicetree.ctx', {showCollapseAll: true, canSelectMany: false, treeDataProvider: this});

        vscode.window.onDidChangeActiveTextEditor(e => {
            if (!e || !this.treeView.visible || !e.document) {
                return;
            }

            const file = this.parser.file(e.document.uri);
            if (file) {
                this.treeView.reveal(file);
            }
        });
    }

    update() {
        this.treeDataChange.fire();
    }


    private treeFileChildren(file: DTSFile, uri: vscode.Uri) {
        return file.includes
            .filter(i => i.loc.uri.toString() === uri.toString())
            .map(i => (<NestedInclude>{ uri: i.dst, file }));
    }

    getTreeItem(element: DTSTreeItem): vscode.TreeItem | Thenable<vscode.TreeItem> {
        try {
            if (element instanceof DTSCtx) {
                let file: DTSFile;
                if (element.overlays.length) {
                    file = element.overlays[element.overlays.length - 1];
                } else {
                    file = element.boardFile;
                }

                if (!file) {
                    return;
                }

                const item = new vscode.TreeItem(element.name,
                    this.parser.currCtx === element ? vscode.TreeItemCollapsibleState.Expanded : vscode.TreeItemCollapsibleState.Collapsed);
                item.contextValue = 'devicetree.ctx';
                item.tooltip = 'DeviceTree Context';
                item.id = ['devicetree', 'ctx', element.name, 'file', file.uri.fsPath.replace(/[/\\]/g, '.')].join('.');
                item.iconPath = iconPath('devicetree-inner');
                return item;
            }

            if (element instanceof DTSFile) {
                const item = new vscode.TreeItem(path.basename(element.uri.fsPath));
                if (element.includes.length) {
                    item.collapsibleState = vscode.TreeItemCollapsibleState.Collapsed;
                }
                item.resourceUri = element.uri;
                item.command = { command: 'vscode.open', title: 'Open file', arguments: [element.uri] };
                item.id === ['devicetree', 'file', element.ctx.name, element.uri.fsPath.replace(/[/\\]/g, '.')].join('.');
                if (element.ctx.boardFile === element) {
                    item.iconPath = iconPath('circuit-board');
                    item.tooltip = 'Board file';
                    item.contextValue = 'devicetree.board';
                } else {
                    if (element.ctx.overlays.indexOf(element) === element.ctx.overlays.length - 1) {
                        item.iconPath = iconPath('overlay');
                        item.contextValue = 'devicetree.overlay';
                    } else {
                        item.iconPath = iconPath('shield');
                        item.contextValue = 'devicetree.shield';
                    }
                    item.tooltip = 'Overlay';
                }
                return item;
            }

            if (element instanceof TreeInfoItem) {
                const item = new vscode.TreeItem(element.name, element.children.length ? vscode.TreeItemCollapsibleState.Collapsed : vscode.TreeItemCollapsibleState.None);
                item.description = element.description;
                item.id = ['devicetree', 'ctx', element.ctx.name, 'item', element.id].join('.');
                if (element.icon) {
                    item.iconPath = iconPath(element.icon);
                }

                if (element.tooltip) {
                    item.tooltip = element.tooltip;
                }

                if (element.path) {
                    item.command = {
                        command: 'devicetree.goto',
                        title: 'Show',
                        arguments: [element.path, element.ctx.files.pop().uri]
                    };
                }

                return item;
            }

            // Nested include
            const item = new vscode.TreeItem(path.basename(element.uri.fsPath));
            item.resourceUri = element.uri;
            if (this.treeFileChildren(element.file, element.uri).length) {
                item.collapsibleState = vscode.TreeItemCollapsibleState.Collapsed;
            }
            item.iconPath = vscode.ThemeIcon.File;
            item.description = '- include';
            item.command = { command: 'vscode.open', title: 'Open file', arguments: [element.uri] };
            return item;
        } catch (e) {
            console.log(e);
        }
    }

    getChildren(element?: DTSTreeItem): vscode.ProviderResult<DTSTreeItem[]> {
        try {
            if (!element) {
                return this.parser.contexts;
            }

            if (element instanceof DTSCtx) {
                return this.getOverviewTree(element);
            }

            if (element instanceof DTSFile) {
                return this.treeFileChildren(element, element.uri);
            }

            if (element instanceof TreeInfoItem) {
                return Array.from(element.children);
            }

            // Nested include:
            return this.treeFileChildren(element.file, element.uri);
        } catch (e) {
            console.log(e);
            return [];
        }
    }

    private getOverviewTree(ctx: DTSCtx): vscode.ProviderResult<DTSTreeItem[]> {
        const details = new TreeInfoItem(ctx, 'Overview');
        const nodes = ctx.nodeArray();
        const gpio = new TreeInfoItem(ctx, 'GPIO', 'gpio');
        nodes.filter(n => n.pins).forEach((n, _, all) => {
            const controller = new TreeInfoItem(ctx, n.uniqueName);
            n.pins.forEach((p, i) => {
                if (p) {
                    const pin = new TreeInfoItem(ctx, `Pin ${i.toString()}`);
                    pin.path = p.prop.path;
                    pin.tooltip = p.prop.entry.node.type?.description;
                    if (p.pinmux) {
                        const name = p.pinmux.name
                            .replace((p.prop.entry.node.labels()[0] ?? p.prop.entry.node.name) + '_', '')
                            .replace(/_?p[a-zA-Z]\d+$/, '');
                        pin.description = `${p.prop.entry.node.uniqueName} • ${name}`;
                    } else {
                        pin.description = `${p.prop.entry.node.uniqueName} • ${p.prop.name}`;
                    }
                    controller.addChild(pin);
                }
            });

            controller.path = n.path;
            controller.description = n.pins.length + ' pins';
            controller.tooltip = n.type?.description;
            if (!controller.children.length) {
                controller.description += ' • Nothing connected';
            } else if (controller.children.length < n.pins.length) {
                controller.description += ` • ${controller.children.length} in use`;
                const unconnected = new TreeInfoItem(ctx, '');
                unconnected.description = `${n.pins.length - controller.children.length} unused pins`;
                controller.addChild(unconnected);
            }

            gpio.addChild(controller);
        });

        if (gpio.children.length) {
            details.addChild(gpio);
        }

        const flash = new TreeInfoItem(ctx, 'Flash', 'flash');
        const sizeString = size => {
            const spec = [
                { size: 1024 * 1024 * 1024, name: 'GB' },
                { size: 1024 * 1024, name: 'MB' },
                { size: 1024, name: 'kB' },
                { size: 1, name: 'B' },
            ].find(spec => size >= spec.size);

            if (size % spec.size) {
                return (size / spec.size).toFixed(3) + ' ' + spec.name;
            }

            return (size / spec.size).toString() + ' ' + spec.name;
        };

        nodes
            .filter(n => n.parent && n.type.is('fixed-partitions'))
            .forEach((n, _, all) => {
                let parent = flash;
                if (all.length > 1) {
                    parent = new TreeInfoItem(ctx, n.parent.uniqueName);
                    flash.addChild(parent);
                }

                const regs = n.parent.regs();
                const capacity = regs?.[0]?.sizes[0]?.val;
                if (capacity !== undefined) {
                    parent.description = sizeString(capacity);
                }

                parent.path = n.parent.path;
                parent.tooltip = n.type?.description;

                let offset = 0;
                n.children().filter(c => c.regs()?.[0]?.addrs.length === 1).sort((a, b) => (a.regs()[0].addrs[0]?.val ?? 0) - (b.regs()[0].addrs[0]?.val ?? 0)).forEach(c => {
                    const reg = c.regs();
                    const start = reg[0].addrs[0].val;
                    const size = reg[0].sizes?.[0]?.val ?? 0;
                    if (start > offset) {
                        parent.addChild(new TreeInfoItem(ctx, `Free space @ 0x${offset.toString(16)}`, undefined, sizeString(start - offset)));
                    }

                    const partition = new TreeInfoItem(ctx, c.property('label')?.value?.[0]?.val as string ?? c.uniqueName);
                    partition.description = sizeString(size);
                    if (start < offset) {
                        partition.description += ` - ${sizeString(offset - start)} overlap!`;
                    }
                    partition.tooltip = `0x${start.toString(16)} - 0x${(start + size - 1).toString(16)}`;
                    partition.path = c.path;

                    partition.addChild(new TreeInfoItem(ctx, 'Start', undefined, reg[0].addrs[0].toString(true)));

                    if (size) {
                        partition.addChild(new TreeInfoItem(ctx, 'Size', undefined, sizeString(reg[0].sizes[0].val)));
                    }

                    parent.addChild(partition);
                    offset = start + size;
                });

                if (capacity !== undefined && offset !== capacity) {
                    parent.addChild(new TreeInfoItem(ctx, `Free space @ 0x${offset.toString(16)}`, undefined, sizeString(capacity - offset)));
                }
            });

        // Some devices don't have partitions defined. For these, show simple flash entries:
        if (!flash.children.length) {
            nodes.filter(n => n.type?.is('soc-nv-flash')).forEach((n, _, all) => {
                let parent = flash;
                if (all.length > 1) {
                    parent = new TreeInfoItem(ctx, n.uniqueName);
                    flash.addChild(parent);
                }

                parent.path = n.path;

                n.regs()?.filter(reg => reg.addrs.length === 1 && reg.sizes.length === 1).forEach((reg, i, areas) => {
                    let area = parent;
                    if (areas.length > 1) {
                        area = new TreeInfoItem(ctx, `Area ${i+1}`);
                        parent.addChild(area);
                    }

                    area.description = sizeString(reg.sizes[0].val);

                    area.addChild(new TreeInfoItem(ctx, 'Start', undefined, reg.addrs[0].toString(true)));
                    area.addChild(new TreeInfoItem(ctx, 'Size', undefined, sizeString(reg.sizes[0].val)));
                });
            });
        }

        if (flash.children.length) {
            details.addChild(flash);
        }

        const interrupts = new TreeInfoItem(ctx, 'Interrupts', 'interrupts');
        const controllers = nodes.filter(n => n.property('interrupt-controller'));
        const controllerItems = controllers.map(n => ({ item: new TreeInfoItem(ctx, n.uniqueName), children: new Array<{ node: Node, interrupts: Property }>() }));
        nodes.filter(n => n.property('interrupts')).forEach(n => {
            const interrupts = n.property('interrupts');
            let node = n;
            let interruptParent: Property;
            while (node && !(interruptParent = node.property('interrupt-parent'))) {
                node = node.parent;
            }

            if (!interruptParent?.pHandle) {
                return;
            }

            const ctrlIdx = controllers.findIndex(c => interruptParent.pHandle?.is(c));
            if (ctrlIdx < 0) {
                return;
            }

            controllerItems[ctrlIdx].children.push({ node: n, interrupts });
        });

        controllerItems.filter(c => c.children.length).forEach((controller, i) => {
            const cells = controllers[i]?.type.cells('interrupt') as string[];
            controller.children.sort((a, b) => a.interrupts.array?.[0] - b.interrupts.array?.[0]).forEach(child => {
                const childIrqs = child.interrupts.arrays;
                const irqNames = child.node.property('interrupt-names')?.stringArray;
                childIrqs?.forEach((cellValues, i, all) => {
                    const irq = new TreeInfoItem(ctx, child.node.uniqueName);
                    irq.path = child.node.path;
                    irq.tooltip = child.node.type?.description;

                    // Some nodes have more than one interrupt:
                    if (all.length > 1) {
                        irq.name += ` (${irqNames?.[i] ?? i})`;
                    }

                    const prioIdx = cells.indexOf('priority');
                    if (cellValues?.length > prioIdx) {
                        irq.description = 'Priority: ' + cellValues[prioIdx]?.toString();
                    }

                    cells?.forEach((cell, i) => irq.addChild(new TreeInfoItem(ctx, cell.replace(/^\w/, letter => letter.toUpperCase()) + ':', undefined, cellValues?.[i]?.toString() ?? 'N/A')));
                    controller.item.addChild(irq);
                });
            });

            controller.item.path = controllers[i].path;
            controller.item.tooltip = controllers[i].type?.description;

            if (controllers.length > 1) {
                interrupts.addChild(controller.item);
            } else {
                // Skip second depth if there's just one interrupt controller
                controller.item.description = controller.item.name;
                controller.item.name = interrupts.name;
                controller.item.icon = interrupts.icon;
                details.addChild(controller.item);
            }
        });

        if (interrupts.children.length) {
            details.addChild(interrupts);
        }

        const buses = new TreeInfoItem(ctx, 'Buses', 'bus');
        nodes.filter(node => node.type?.bus).forEach(node => {
            const bus = new TreeInfoItem(ctx, node.uniqueName, undefined, '');
            if (!bus.name.toLowerCase().includes(node.type.bus.toLowerCase())) {
                bus.description = node.type.bus + ' ';
            }

            bus.path = node.path;
            bus.tooltip = node.type?.description;

            const busProps = [/.*-speed$/, /.*-pin$/, /^clock-frequency$/, /^hw-flow-control$/, /^dma-channels$/];
            node.uniqueProperties().filter(prop => prop.value.length > 0 && busProps.some(regex => prop.name.match(regex))).forEach(prop => {
                const infoItem = new TreeInfoItem(ctx, prop.name.replace(/-/g, ' ') + ':', undefined, prop.value.map(v => v.toString(true)).join(', '));
                infoItem.path = prop.path;
                bus.addChild(infoItem);
            });

            const nodesItem = new TreeInfoItem(ctx, 'Nodes');

            node.children().forEach(child => {
                const busEntry = new TreeInfoItem(ctx, child.localUniqueName);
                busEntry.path = child.path;
                busEntry.tooltip = child.type?.description;

                if (child.address !== undefined) {
                    busEntry.description = `@ 0x${child.address.toString(16)}`;

                    // SPI nodes have chip selects
                    if (node.type.bus === 'spi') {
                        const csGpios = node.property('cs-gpios');
                        const cs = csGpios?.entries?.[child.address];
                        if (cs) {
                            const csEntry = new TreeInfoItem(ctx, `Chip select`);
                            csEntry.description = `${cs.target.toString(true)} ${cs.cells.map(c => c.toString(true)).join(' ')}`;
                            csEntry.path = csGpios.path;
                            busEntry.addChild(csEntry);
                        }
                    }
                }

                nodesItem.addChild(busEntry);
            });

            if (nodesItem.children.length) {
                bus.description += `• ${countText(nodesItem.children.length, 'node')}`;
            } else {
                nodesItem.description = '• Nothing connected';
            }

            bus.addChild(nodesItem);
            buses.addChild(bus);
        });

        if (buses.children.length) {
            details.addChild(buses);
        }

        const adcs = new TreeInfoItem(ctx, 'ADCs', 'adc');
        nodes.filter(node => node.type?.is('adc-controller')).forEach(node => {
            const adc = new TreeInfoItem(ctx, node.uniqueName);
            adc.path = node.path;
            adc.tooltip = node.type?.description;
            nodes
            .filter(n => n.property('io-channels')?.entries?.some(entry => (entry.target instanceof PHandle) && entry.target.is(node)))
            .flatMap(usr => {
                const names = usr.property('io-channel-names')?.stringArray ?? [];
                return usr.property('io-channels').entries.filter(c => c.target.is(node)).map((channel, i, all) => ({node: usr, idx: channel.cells[0]?.val ?? -1, name: names[i] ?? ((all.length > 1) && i.toString())}));
            })
            .sort((a, b) => a.idx - b.idx)
            .forEach(channel => {
                const entry = new TreeInfoItem(ctx, `Channel ${channel.idx}`, undefined, channel.node.uniqueName + (channel.name ? ` • ${channel.name}` : ''));
                entry.path = channel.node.path;
                adc.addChild(entry);
            });

            if (!adc.children.length) {
                adc.addChild(new TreeInfoItem(ctx, '', undefined, 'No channels in use.'));
            }

            adcs.addChild(adc);
        });

        if (adcs.children.length === 1) {
            adcs.children[0].icon = adcs.icon;
            adcs.children[0].description = adcs.children[0].name;
            adcs.children[0].name = adcs.name;
            details.addChild(adcs.children[0]);
        } else if (adcs.children.length) {
            details.addChild(adcs);
        }

        const dacs = new TreeInfoItem(ctx, 'DACs', 'dac');
        nodes.filter(node => node.type?.is('dac-controller')).forEach(node => {
            const dac = new TreeInfoItem(ctx, node.uniqueName);
            dac.path = node.path;
            dac.tooltip = node.type?.description;
            nodes
            .filter(n => n.property('io-channels')?.entries?.some(entry => (entry.target instanceof PHandle) && entry.target.is(node)))
            .flatMap(usr => {
                const names = usr.property('io-channel-names')?.stringArray ?? [];
                return usr.property('io-channels').entries.filter(c => c.target.is(node)).map((channel, i, all) => ({node: usr, idx: channel.cells[0]?.val ?? -1, name: names[i] ?? ((all.length > 1) && i.toString())}));
            })
            .sort((a, b) => a.idx - b.idx)
            .forEach(channel => {
                const entry = new TreeInfoItem(ctx, `Channel ${channel.idx}`, undefined, channel.node.uniqueName + (channel.name ? ` • ${channel.name}` : ''));
                entry.path = channel.node.path;
                dac.addChild(entry);
            });

            if (!dac.children.length) {
                dac.addChild(new TreeInfoItem(ctx, '', undefined, 'No channels in use.'));
            }

            dacs.addChild(dac);
        });

        if (dacs.children.length === 1) {
            dacs.children[0].icon = dacs.icon;
            dacs.children[0].description = dacs.children[0].name;
            dacs.children[0].name = dacs.name;
            details.addChild(dacs.children[0]);
        } else if (dacs.children.length) {
            details.addChild(dacs);
        }

        const clocks = new TreeInfoItem(ctx, 'Clocks', 'clock');
        nodes.filter(node => node.type?.is('clock-controller')).forEach(node => {
            const clock = new TreeInfoItem(ctx, node.uniqueName);
            clock.path = node.path;
            clock.tooltip = node.type?.description;
            const cells = node.type?.cells('clock');
            nodes.forEach(user => {
                const clockProp = user.property('clocks');
                const entries = clockProp?.entries?.filter(e => e.target.is(node));
                entries?.forEach(e => {
                    const userEntry = new TreeInfoItem(ctx, user.uniqueName);
                    userEntry.path = user.path;
                    userEntry.tooltip = user.type?.description;
                    cells?.forEach((c, i) => {
                        if (i < e.cells.length) {
                            userEntry.addChild(new TreeInfoItem(ctx, c, undefined, e.cells[i].toString(true)));
                        }
                    });
                    clock.addChild(userEntry);
                });
            });

            if (!clock.children.length) {
                clock.addChild(new TreeInfoItem(ctx, '', undefined, 'No users'));
            }

            clocks.addChild(clock);
        });

        if (clocks.children.length === 1) {
            clocks.children[0].icon = clocks.icon;
            clocks.children[0].description = clocks.children[0].name;
            clocks.children[0].name = clocks.name;
            details.addChild(clocks.children[0]);
        } else if (clocks.children.length) {
            details.addChild(clocks);
        }

        /////////////////////////////
        if (details.children.length) {
            return [details, ...ctx.files];
        }

        return ctx.files;
    }

    getParent(element: DTSTreeItem): vscode.ProviderResult<DTSCtx> {
        if (element instanceof DTSCtx) {
            return;
        }

    }
}

