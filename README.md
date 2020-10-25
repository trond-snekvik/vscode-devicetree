# DeviceTree for the Zephyr Project

DeviceTree language support for the [Zephyr project](https://zephyrproject.org/) in VS Code.

This extension is an independent community contribution, and is not part of the Zephyr Project.

## Features

- Syntax highlighting
- Syntax validation
- Code completion
  - Valid properties
  - Valid nodes
  - Existing child nodes
  - Node types
  - Phandle cell names
  - Preprocessor defines
- Type checking
- Hover
- Go to definition
- Go to type definition
- Show references
- Breadcrumbs navigation
- Workspace symbols
- Preview compiled DeviceTree output
- Copy C identifier to clipboard
- Show GPIO pin assignments
- Manage DeviceTree contexts
- Format selection
- Linting language rules
  - Redundant properties
  - Required properties
  - Reference validity
  - Phandle cell formats
  - Node specific rules
  - Bus matching
  - SPI chip select entries
  - Nexus node map validity
  - Address collisions
  - Name property matches
  - GPIO pin collisions
  - Duplicate labels

![Code completion](doc/completion.png)

### Copy C identifiers

While selecting a node, property or value in a DeviceTree file, right click and select "DeviceTree: Copy C identifier to clipboard" to copy the matching C identifier.

![Copy identifier](doc/copy.png)

If the selected symbol has a corresponding C macro, like `DT_PROP(DT_NODELABEL(adc), label)`, it will be copied to the clipboard for usage in C files. A message shows up on the status bar if there was anything to copy.

![Copied identifier](doc/copied.png)

### Manage DeviceTree contexts

If you work with more than one application or board, you'll have multiple sets of DeviceTree contexts - one for each of your builds. Every time you open a new DeviceTree file, the extension will add a DeviceTree context (unless this file is already part of an existing context). Each context corresponds to a single compiled DeviceTree file that goes into a build, and consists of a board file and a list of overlay files.

The DeviceTree contexts show up in the explorer sidebar:

![DeviceTree Contexts](doc/contexts.png)

The DeviceTree contexts can be saved in a context file by pressing the Save button on the DeviceTree context explorer. This allows you to restore the contexts the next time you open the folder. The location of the context file can be changed by setting the "devicetree.ctxFile" configuration entry in the VS Code settings.

It's possible to add shield files to the same context by pressing "DeviceTree: Add Shield..." on the context in the DeviceTree context explorer. Shield files will be processed ahead of the overlay file.

## Installation

The extension can be installed from the Visual Studio Extension marketplace.

It's also possible to download specific releases from the GitHub repository by picking a devicetree-X.X.X.vsix package from the GitHub releases tab. Open Visual Studio Code and run the "Install from VSIX..." command, either through the command palette (Ctrl+Shift+P) or by opening the extensions panel, and pressing the ... menu in the top corner. Locate the VSIX package, press "Install" and reload Visual Studio Code once prompted.
