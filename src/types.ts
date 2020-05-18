import * as yaml from 'js-yaml';
import * as glob from 'glob';
import * as vscode from 'vscode';
import { readFileSync, fstat } from 'fs';
import { Node, Property } from './parser';
import { Diagnostic, DiagnosticSeverity } from 'vscode';

export type PropertyTypeString = 'string' | 'int' | 'boolean' | 'array' | 'compound' | 'phandle' | 'string-array' | 'phandle-array' | 'uint8-array';

export interface PropertyType {
    name: string;
    required: boolean;
    enum?: string[];
    const?: string | number;
    default?: any;
    type: PropertyTypeString | PropertyTypeString[];
    description?: string;
    constraint?: string;
    isLoaded?: boolean;
}

export interface NodeType {
    name: string;
    loaded: boolean;
    compatible?: string;
    properties: PropertyType[];
    filename: string;
    title?: string;
    include?: string | string[];
    description?: string;
    'child-bus'?: string;
    'parent-bus'?: string;
    'child-binding'?: NodeType;
};


const standardProperties: PropertyType[] = [
    {
        name: '#address-cells',
        required: false,
        type: 'int',
        description: `The #address-cells property defines the number of u32 cells used to encode the address field in a child node’s reg property.\n\nThe #address-cells and #size-cells properties are not inherited from ancestors in the devicetree. They shall be explicitly defined.\n\nA DTSpec-compliant boot program shall supply #address-cells and #size-cells on all nodes that have children. If missing, a client program should assume a default value of 2 for #address-cells, and a value of 1 for #size-cells`,
    },
    {
        name: '#size-cells',
        required: false,
        type: 'int',
        description: `The #size-cells property defines the number of u32 cells used to encode the size field in a child node’s reg property.\n\nThe #address-cells and #size-cells properties are not inherited from ancestors in the devicetree. They shall be explicitly defined.\n\nA DTSpec-compliant boot program shall supply #address-cells and #size-cells on all nodes that have children. If missing, a client program should assume a default value of 2 for #address-cells, and a value of 1 for #size-cells`,
    },
    {
        name: 'model',
        required: false,
        type: 'string',
        description: `The model property value is a string that specifies the manufacturer’s model number of the device. The recommended format is: "manufacturer,model", where manufacturer is a string describing the name of the manufacturer (such as a stock ticker symbol), and model specifies the model number.`,
    },
    {
        name: 'compatible',
        required: false,
        type: 'string-array',
        description: `The compatible property value consists of one or more strings that define the specific programming model for the device. This list of strings should be used by a client program for device driver selection. The property value consists of a concatenated list of null terminated strings, from most specific to most general. They allow a device to express its compatibility with a family of similar devices, potentially allowing a single device driver to match against several devices.\n\nThe recommended format is "manufacturer,model", where manufacturer is a string describing the name of the manufacturer (such as a stock ticker symbol), and model the model number.`,
        isLoaded: true, // This is a lie, but it forces the property to show as a completion item
    },
    {
        name: 'phandle',
        type: 'int',
        required: false,
        description: `The phandle property specifies a numerical identifier for a node that is unique within the devicetree. The phandle property value is used by other nodes that need to refer to the node associated with the property.`
    },
    {
        name: 'status',
        type: 'string',
        required: false,
        enum: ['okay', 'disabled', 'reserved', 'fail', 'fail-sss'],
        description: 'The status property indicates the operational status of a device.',
        isLoaded: true, // This is a lie, but it forces the property to show as a completion item
    },
    {
        name: 'clock-frequency',
        type: 'int',
        required: false,
        description: 'Specifies the frequency of a clock in Hz.'
    },
    {
        name: 'reg-shift',
        type: 'int',
        required: false,
        description: 'The reg-shift property provides a mechanism to represent devices that are identical in most\n' +
        'respects except for the number of bytes between registers. The reg-shift property specifies in bytes\n' +
        'how far the discrete device registers are separated from each other. The individual register location\n' +
        'is calculated by using following formula: “registers address” << reg-shift. If unspecified, the default\n' +
        'value is 0.\n' +
        'For example, in a system where 16540 UART registers are located at addresses 0x0, 0x4, 0x8, 0xC,\n' +
        '0x10, 0x14, 0x18, and 0x1C, a reg-shift = <2> property would be used to specify register\n' +
        'locations.`\n',
    },
    {
        name: 'label',
        type: 'string',
        required: false,
        description: 'The label property defines a human readable string describing a device. The binding for a given device specifies the exact meaning of the property for that device.'
    },
    {
        name: 'reg',
        type: 'array',
        required: false,
        description: 'The reg property describes the address of the device’s resources within the address space defined by its parent\n' +
        'bus. Most commonly this means the offsets and lengths of memory-mapped IO register blocks, but may have\n' +
        'a different meaning on some bus types. Addresses in the address space defined by the root node are CPU real\n' +
        'addresses.\n' +
        '\n' +
        'The value is a <prop-encoded-array>, composed of an arbitrary number of pairs of address and length,\n' +
        '<address length>. The number of <u32> cells required to specify the address and length are bus-specific\n' +
        'and are specified by the #address-cells and #size-cells properties in the parent of the device node. If the parent\n' +
        'node specifies a value of 0 for #size-cells, the length field in the value of reg shall be omitted.\n',
    }
];

const interruptNode: PropertyType[] = [
    {
        name: 'interrupts',
        type: 'array',
        description: `The interrupts property of a device node defines the interrupt or interrupts that are generated by the device. The value of the interrupts property consists of an arbitrary number of interrupt specifiers. The format of an interrupt specifier is defined by the binding of the interrupt domain root. interrupts is overridden by the interrupts-extended property and normally only one or the other should be used.`,
        required: false,
    },
    {
        name: 'interrupt-parent',
        type: 'phandle',
        description: `Because the hierarchy of the nodes in the interrupt tree might not match the devicetree, the interrupt-parent property is available to make the definition of an interrupt parent explicit. The value is the phandle to the interrupt parent. If this property is missing from a device, its interrupt parent is assumed to be its devicetree parent.`,
        required: true,
    },
    {
        name: 'interrupts-extended',
        type: 'compound',
        description: `The interrupts-extended property lists the interrupt(s) generated by a device. interrupts-extended should be used instead of interrupts when a device is connected to multiple interrupt controllers as it encodes a parent phandle with each interrupt specifier.`,
        required: false,
    },
];

const interruptController: PropertyType[] = [
    {
        name: 'interrupt-controller',
        type: 'boolean',
        description: `The presence of an interrupt-controller property defines a node as an interrupt controller node.`,
        required: true
    },
    {
        name: '#interrupt-cells',
        type: 'int',
        description: `The #interrupt-cells property defines the number of cells required to encode an interrupt specifier for an
        interrupt domain`,
        required: false,
    },
];

function typeNameFromFilename(filename: string) {
    return filename.replace(/.*\//, '').replace('.yaml', '');
}

function mergeProperties(base: PropertyType[], inherited: PropertyType[]): PropertyType[] {
    if (!inherited) {
        return base;
    }

    return [
        ...inherited.filter(p => !base.find(bp => bp.name === p.name)),
        ...base.map(p => {
            var i = inherited.find(i => i.name === p.name);
            return { ...i, ...p, required: i?.required || p?.required};
        }),
    ];
};

function filterDuplicateProps(props: PropertyType[]): PropertyType[] {
    var uniqueProps = props.filter((p, i) => props.findIndex(pp => p.name === pp.name) === i);

    return uniqueProps.map(p => {
        props.filter(pp => pp.name === p.name).forEach(pp => {
            p = {...p, ...pp};
        });
        return p;
    })
}

export class TypeLoader {
    types: {[name: string]: NodeType} = {
        '/': {
            name: '/',
            filename: '',
            loaded: true,
            description: 'The devicetree has a single root node of which all other device nodes are descendants. The full path to the root node is /.',
            properties: [
                ...standardProperties,
                {
                    ...standardProperties.find(p => p.name === '#address-cells'),
                    required: true,
                    description: 'Specifies the number of <u32> cells to represent the address in the reg property in children of root',
                },
                {
                    ...standardProperties.find(p => p.name === '#size-cells'),
                    required: true,
                    description: 'Specifies the number of <u32> cells to represent the size in the reg property in children of root.',
                },
                {
                    ...standardProperties.find(p => p.name === 'model'),
                    required: true,
                    description: 'Specifies a string that uniquely identifies the model of the system board. The recommended format is `“manufacturer,model-number”.`',
                },
                {
                    ...standardProperties.find(p => p.name === 'compatible'),
                    required: true,
                    description: 'Specifies a list of platform architectures with which this platform is compatible. This property can be used by operating systems in selecting platform specific code. The recommended form of the property value is:\n"manufacturer,model"\nFor example:\ncompatible = "fsl,mpc8572ds"',
                },
            ],
            title: 'Root node'
        },
        'simple-bus': {
            name: 'simple-bus',
            filename: '',
            loaded: true,
            title: 'Internal I/O bus',
            description: 'System-on-a-chip processors may have an internal I/O bus that cannot be probed for devices. The devices on the bus can be accessed directly without additional configuration required. This type of bus is represented as a node with a compatible value of “simple-bus”.',
            properties: [
                ...standardProperties,
                {
                    ...standardProperties.find(p => p.name === 'compatible'),
                    required: true,
                },
                {
                    name: 'ranges',
                    type: ['boolean', 'array'],
                    description: 'The ranges property provides a means of defining a mapping or translation between the address space of the\n' +
                    'bus (the child address space) and the address space of the bus node’s parent (the parent address space).\n' +
                    'The format of the value of the ranges property is an arbitrary number of triplets of (child-bus-address,\n' +
                    'parentbus-address, length)\n' +
                    '\n' +
                    '- The child-bus-address is a physical address within the child bus’ address space. The number of cells to\n' +
                    'represent the address is bus dependent and can be determined from the #address-cells of this node (the\n' +
                    'node in which the ranges property appears).\n' +
                    '- The parent-bus-address is a physical address within the parent bus’ address space. The number of cells\n' +
                    'to represent the parent address is bus dependent and can be determined from the #address-cells property\n' +
                    'of the node that defines the parent’s address space.\n' +
                    '- The length specifies the size of the range in the child’s address space. The number of cells to represent\n' +
                    'the size can be determined from the #size-cells of this node (the node in which the ranges property\n' +
                    'appears).\n' +
                    '\n' +
                    'If the property is defined with an <empty> value, it specifies that the parent and child address space is\n' +
                    'identical, and no address translation is required.\n' +
                    'If the property is not present in a bus node, it is assumed that no mapping exists between children of the node\n' +
                    'and the parent address space.\n',
                    required: true
                }
            ]
        },
        '/cpus/': {
            name: '/cpus/',
            filename: '',
            title: '/cpus',
            loaded: true,
            description: `A /cpus node is required for all devicetrees. It does not represent a real device in the system, but acts as a container for child cpu nodes which represent the systems CPUs.`,
            properties: [
                ...standardProperties,
                {
                    ...standardProperties.find(p => p.name === '#address-cells'),
                    required: true,
                },
                {
                    ...standardProperties.find(p => p.name === '#size-cells'),
                    required: true,
                }
            ]
        },
        '/cpus/cpu': {
            name: '/cpus/cpu',
            filename: '',
            title: 'CPU instance',
            loaded: true,
            description: 'A cpu node represents a hardware execution block that is sufficiently independent that it is capable of running an operating\n' +
            'system without interfering with other CPUs possibly running other operating systems.\n' +
            'Hardware threads that share an MMU would generally be represented under one cpu node. If other more complex CPU\n' +
            'topographies are designed, the binding for the CPU must describe the topography (e.g. threads that don’t share an MMU).\n' +
            'CPUs and threads are numbered through a unified number-space that should match as closely as possible the interrupt\n' +
            'controller’s numbering of CPUs/threads.\n' +
            '\n' +
            'Properties that have identical values across cpu nodes may be placed in the /cpus node instead. A client program must\n' +
            'first examine a specific cpu node, but if an expected property is not found then it should look at the parent /cpus node.\n' +
            'This results in a less verbose representation of properties which are identical across all CPUs.\n' +
            'The node name for every CPU node should be cpu.`\n',
            properties: [
                ...standardProperties,
                {
                    name: 'device_type',
                    type: 'string',
                    const: 'cpu',
                    description: `Value shall be "cpu"`,
                    required: true,
                },
                {
                    name: 'reg',
                    type: ['int', 'array'],
                    description: `The value of reg is a <prop-encoded-array> that defines a unique CPU/thread id for the CPU/threads represented by the CPU node. If a CPU supports more than one thread (i.e. multiple streams of execution) the reg property is an array with 1 element per thread. The #address-cells on the /cpus node specifies how many cells each element of the array takes. Software can determine the number of threads by dividing the size of reg by the parent node’s #address-cells. If a CPU/thread can be the target of an external interrupt the reg property value must be a unique CPU/thread id that is addressable by the interrupt controller. If a CPU/thread cannot be the target of an external interrupt, then reg must be unique and out of bounds of the range addressed by the interrupt controller. If a CPU/thread’s PIR (pending interrupt register) is modifiable, a client program should modify PIR to match the reg property value. If PIR cannot be modified and the PIR value is distinct from the interrupt controller number space, the CPUs binding may define a binding-specific representation of PIR values if desired.`,
                    required: true
                }
            ]
        },
        '/chosen/': {
            name: '/chosen/',
            title: '/Chosen node',
            filename: '',
            loaded: true,
            description: `The /chosen node does not represent a real device in the system but describes parameters chosen or specified by the system firmware at run time. It shall be a child of the root node`,
            properties: [
                {
                    name: 'zephyr,flash',
                    type: 'phandle',
                    required: false,
                    description: 'Generates symbol CONFIG_FLASH'
                },
                {
                    name: 'zephyr,sram',
                    type: 'phandle',
                    required: false,
                    description: 'Generates symbol CONFIG_SRAM_SIZE/CONFIG_SRAM_BASE_ADDRESS (via DT_SRAM_SIZE/DT_SRAM_BASE_ADDRESS)'
                },
                {
                    name: 'zephyr,ccm',
                    type: 'phandle',
                    required: false,
                    description: 'Generates symbol DT_CCM'
                },
                {
                    name: 'zephyr,console',
                    type: 'phandle',
                    required: false,
                    description: 'Generates symbol DT_UART_CONSOLE_ON_DEV_NAME'
                },
                {
                    name: 'zephyr,shell-uart',
                    type: 'phandle',
                    required: false,
                    description: 'Generates symbol DT_UART_SHELL_ON_DEV_NAME'
                },
                {
                    name: 'zephyr,bt-uart',
                    type: 'phandle',
                    required: false,
                    description: 'Generates symbol DT_BT_UART_ON_DEV_NAME'
                },
                {
                    name: 'zephyr,uart-pipe',
                    type: 'phandle',
                    required: false,
                    description: 'Generates symbol DT_UART_PIPE_ON_DEV_NAME'
                },
                {
                    name: 'zephyr,bt-mon-uart',
                    type: 'phandle',
                    required: false,
                    description: 'Generates symbol DT_BT_MONITOR_ON_DEV_NAME'
                },
                {
                    name: 'zephyr,uart-mcumgr',
                    type: 'phandle',
                    required: false,
                    description: 'Generates symbol DT_UART_MCUMGR_ON_DEV_NAME'
                },
            ]
        },
        '/aliases/': {
            name: '/aliases/',
            filename: '',
            loaded: true,
            title: 'Aliases',
            description: `A devicetree may have an aliases node (/aliases) that defines one or more alias properties. The alias node shall be at the root of the devicetree and have the node name /aliases. Each property of the /aliases node defines an alias. The property name specifies the alias name. The property value specifies the full path to a node in the devicetree. For example, the property serial0 = "/simple-bus@fe000000/ serial@llc500" defines the alias serial0. Alias names shall be a lowercase text strings of 1 to 31 characters from the following set of characters.\n\nAn alias value is a device path and is encoded as a string. The value represents the full path to a node, but the path does not need to refer to a leaf node. A client program may use an alias property name to refer to a full device path as all or part of its string value. A client program, when considering a string as a device path, shall detect and use the alias.`,
            properties: []
        }
    };
    folders: string[] = []

    addFolder(folder: string) {
        this.folders.push(folder);
        var files = glob.sync('**/*.yaml', { cwd: folder });
        files.forEach(f => {
            var name = typeNameFromFilename(f);
            if (!(name in this.types)) {
                this.types[name] = { name: name, properties: [ ...standardProperties ], loaded: false, filename: folder + '/' + f };
            }
        });
    }

    get(name: string, nodeName?: string, load=true): NodeType | undefined {
        // Try the name of the type, the node name and the node name singular:
        var typeName = [name, nodeName, (nodeName || 'undefined').replace(/s$/,'')].find(n => n && n in this.types);
        if (!typeName) {
            return undefined;
        }

        if (load && !this.types[typeName]?.loaded) {
            this.types[typeName] = this.loadYAML(typeName);
        }

        return this.types[typeName];
    }

    YAMLtoNode(tree: any, baseType?: NodeType): NodeType {
        var loadedProperties: PropertyType[] = (('properties' in tree) ? Object.keys(tree['properties']).map(name => {
            return <PropertyType>{name: name, ...tree['properties'][name], isLoaded: true};
        }) : []);

        var type = <NodeType>{ ...baseType, ...tree, properties: loadedProperties };
        if (baseType) {
            type.properties = mergeProperties(type.properties, baseType.properties);
        }

        if ('include' in tree) {
            if (typeof type.include === 'string') {
                var include = this.get(typeNameFromFilename(tree.include));
                if (include) {
                    type.properties = mergeProperties(type.properties, include.properties);
                    // load all included tree entries that aren't in the child:
                    var entries = Object.keys(include).filter(e => e !== 'properties' && !(e in type));
                    entries.forEach(e => type[e] = include[e]);
                }
            } else {
                type.include.forEach(i => {
                    var include = this.get(typeNameFromFilename(i));
                    if (include) {
                        type.properties = mergeProperties(type.properties, include.properties);
                    }
                });
            }
        }

        if ('child-binding' in tree) {
            type['child-binding'] = this.YAMLtoNode(tree['child-binding']);
        }

        type.loaded = true;

        return type;
    }

    loadYAML(name: string): NodeType | null {
        var type = this.types[name];
        if (!type) {
            return null;
        }

        var contents = readFileSync(type.filename, 'utf-8');
        try {
            var tree = yaml.load(contents);
            // var tree = yaml.parse(contents, {mapAsMap: true});
            return this.YAMLtoNode(tree, type);
        } catch (e) {
            vscode.window.showWarningMessage(`Invalid type file "${name}.yaml": ${e}`);
        }
    }


    nodeType(node: Node, parentType?: NodeType, diags: Diagnostic[]=[]): NodeType {
        var props = node.properties();

        var getBaseType = () => {
            var pathBasedType = this.get(node.path);
            if (pathBasedType) {
                return pathBasedType;
            }

            if (node.path.match(/\/cpus\/cpu.*/)) {
                return this.get('/cpus/cpu');
            }

            const compatible = props.find(p => p.name === 'compatible');
            if (compatible) {
                if (typeof compatible.value.value === 'string') {
                    return this.get(compatible.value.value, node.name);
                }

                if (Array.isArray(compatible.value.value)) {
                    if (typeof compatible.value.value[0] === 'string') {
                        var n: NodeType;
                        (compatible.value.value as string[]).find(v => {
                            n = this.get(v, node.name);
                            return n;
                        });
                        return n;
                    }
                    diags.push(new Diagnostic(compatible.range.toRange(), `Property compatible must be an array of strings`, DiagnosticSeverity.Warning));
                } else {
                    diags.push(new Diagnostic(compatible.range.toRange(), `Property compatible must be a string or an array of strings`, DiagnosticSeverity.Warning));
                }
                diags.push(new Diagnostic(compatible.range.toRange(), `Unknown type ${compatible.value.raw}`, DiagnosticSeverity.Warning));
                return;
            }

            if (parentType && parentType['child-binding']) {
                return parentType['child-binding'];
            }
            diags.push(...node.entries.map(e => new Diagnostic(e.nameRange.toRange(), `Missing "compatible" property`, DiagnosticSeverity.Warning)));
        };

        var type = getBaseType();

        if (!type) {
            type = { name: '<unknown>', filename: '', loaded: true, properties: [ ...standardProperties ] };
        }

        if (props.find(p => p.name === 'interrupt-controller')) {
            type.properties = mergeProperties(type.properties, interruptController);
        }

        if (props.find(p => p.name === 'interrupt-parent')) {
            type.properties = mergeProperties(type.properties, interruptNode);
        }

        type.properties = filterDuplicateProps(type.properties);

        return type;
    }
}
