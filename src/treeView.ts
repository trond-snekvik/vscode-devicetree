import * as vscode from 'vscode';
import * as path from 'path';
import { DTSCtx, DTSFile, Node, Parser, Property} from './dts';

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
    }

    getChildren(element?: DTSTreeItem): vscode.ProviderResult<DTSTreeItem[]> {
        if (!element) {
            return this.parser.contexts;
        }

        if (element instanceof DTSCtx) {
            const details = new TreeInfoItem(element, 'Overview');
            const nodes = element.nodeArray();
            const gpio = new TreeInfoItem(element, 'GPIO', 'gpio');
            nodes.filter(n => n.pins).forEach((n, _, all) => {
                const controller = new TreeInfoItem(element, n.uniqueName);
                n.pins.forEach((p, i) => {
                    if (p) {
                        const pin = new TreeInfoItem(element, `Pin ${i.toString()}`);
                        pin.path = p.prop.path;
                        pin.tooltip = p.prop.entry.node.path + p.prop.name;
                        pin.description = `${p.prop.entry.node.uniqueName} • ${p.prop.name}`;
                        controller.addChild(pin);
                    }
                });

                controller.path = n.path;
                controller.description = n.pins.length + ' pins';
                if (!controller.children.length) {
                    controller.description += ' - Nothing connected';
                } else if (controller.children.length < n.pins.length) {
                    const unconnected = new TreeInfoItem(element, '');
                    unconnected.description = `${n.pins.length - controller.children.length} unused pins`;
                    controller.addChild(unconnected);
                }

                gpio.addChild(controller);
            });

            if (gpio.children.length) {
                details.addChild(gpio);
            }

            const flash = new TreeInfoItem(element, 'Flash', 'flash');
            const sizeString = size => {
                const spec = [
                    { size: 1024 * 1024, name: 'MB' },
                    { size: 1024, name: 'kB' },
                    { size: 1, name: 'B' },
                ].find(spec => size > spec.size);

                if (size % spec.size) {
                    return (size / spec.size).toFixed(3) + ' ' + spec.name;
                }

                return (size / spec.size).toString() + ' ' + spec.name;
            };


            nodes
                .filter(n => n.parent && (n.type?.name === 'fixed-partitions' || n.type.includes('fixed-partitions')))
                .forEach((n, _, all) => {
                    let parent = flash;
                    if (all.length > 1) {
                        parent = new TreeInfoItem(element, n.parent.uniqueName);
                        flash.addChild(parent);
                    }

                    const regs = n.parent.regs();
                    const capacity = regs?.[0]?.sizes[0]?.val;
                    if (capacity !== undefined) {
                        parent.description = sizeString(capacity);
                    }

                    parent.path = n.parent.path;

                    let offset = 0;
                    n.children().filter(c => c.regs()?.[0]?.addrs.length === 1).sort((a, b) => (a.regs()[0].addrs[0]?.val ?? 0) - (b.regs()[0].addrs[0]?.val ?? 0)).forEach(c => {
                        const reg = c.regs();
                        const start = reg[0].addrs[0].val;
                        const size = reg[0].sizes?.[0]?.val ?? 0;
                        if (start > offset) {
                            parent.addChild(new TreeInfoItem(element, `Free space @ 0x${offset.toString(16)}`, undefined, sizeString(start - offset)));
                        }

                        const partition = new TreeInfoItem(element, c.property('label')?.value?.[0]?.val as string ?? c.uniqueName);
                        partition.description = sizeString(size);
                        if (start < offset) {
                            partition.description += ` - ${sizeString(offset - start)} overlap!`;
                        }
                        partition.tooltip = `0x${start.toString(16)} - 0x${(start + size - 1).toString(16)}`;
                        partition.path = c.path;

                        const startItem = new TreeInfoItem(element, 'Start', undefined, reg[0].addrs[0].toString(true));
                        partition.addChild(startItem);

                        if (size) {
                            const sizeItem = new TreeInfoItem(element, 'Size', undefined, reg[0].sizes[0].toString(true));
                            partition.addChild(sizeItem);
                        }

                        parent.addChild(partition);
                        offset = start + size;
                    });

                    if (capacity !== undefined && offset !== capacity) {
                        parent.addChild(new TreeInfoItem(element, `Free space @ 0x${offset.toString(16)}`, undefined, sizeString(capacity - offset)));
                    }
                });

            if (flash.children.length) {
                details.addChild(flash);
            }

            const interrupts = new TreeInfoItem(element, 'Interrupts', 'interrupts');
            const controllers = nodes.filter(n => n.property('interrupt-controller'));
            const controllerItems = controllers.map(n => ({ item: new TreeInfoItem(element, n.uniqueName), children: new Array<{ node: Node, interrupts: Property }>() }));
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
                    const irq = new TreeInfoItem(element, child.node.uniqueName);
                    irq.path = child.node.path;
                    irq.tooltip = child.node.path;

                    const cellValues = child.interrupts.array;
                    const prioIdx = cells.indexOf('priority');
                    if (cellValues && prioIdx >= 0) {
                        irq.description = 'Priority: ' + cellValues[prioIdx].toString();
                    }

                    cells?.forEach((cell, i) => irq.addChild(new TreeInfoItem(element, cell.replace(/^\w/, letter => letter.toUpperCase()) + ':', undefined, cellValues[i]?.toString() ?? 'N/A')));
                    controller.item.addChild(irq);
                });

                controller.item.path = controllers[i].path;

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

            const buses = new TreeInfoItem(element, 'Buses', 'bus');
            nodes.filter(node => node.type?.bus).forEach(node => {
                const bus = new TreeInfoItem(element, node.uniqueName);
                if (!bus.name.toLowerCase().includes(node.type.bus.toLowerCase())) {
                    bus.description = node.type.bus;
                }

                bus.path = node.path;
                bus.tooltip = node.path;
                node.children().forEach(child => {
                    const busEntry = new TreeInfoItem(element, child.localUniqueName);
                    busEntry.path = child.path;
                    busEntry.tooltip = child.path;
                    if (child.address !== undefined) {
                        busEntry.description = `@ 0x${child.address.toString(16)}`;

                        // SPI nodes have chip selects
                        if (node.type.bus === 'spi') {
                            const csGpios = node.property('cs-gpios');
                            const cs = csGpios?.entries?.[child.address];
                            if (cs) {
                                const csEntry = new TreeInfoItem(element, `Chip select`);
                                csEntry.description = `${cs.target.toString(true)} ${cs.cells.map(c => c.toString(true)).join(' ')}`;
                                csEntry.path = csGpios.path;
                                busEntry.addChild(csEntry);
                            }
                        }
                    }

                    bus.addChild(busEntry);

                });

                if (!bus.children.length) {
                    bus.description = (bus.description ? bus.description + ' ' : '') + '• Nothing connected';
                }

                buses.addChild(bus);
            });

            if (buses.children.length) {
                details.addChild(buses);
            }

            /////////////////////////////
            if (details.children.length) {
                return [details, ...element.files];
            }

            return element.files;
        }

        if (element instanceof DTSFile) {
            return this.treeFileChildren(element, element.uri);
        }

        if (element instanceof TreeInfoItem) {
            return Array.from(element.children);
        }

        // Nested include:
        return this.treeFileChildren(element.file, element.uri);
    }

    getParent(element: DTSTreeItem): vscode.ProviderResult<DTSCtx> {
        if (element instanceof DTSCtx) {
            return;
        }
        if (element instanceof DTSFile) {
            return element.ctx;
        }

    }
}

