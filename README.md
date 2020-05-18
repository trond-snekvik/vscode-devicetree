# Devicetree for the Zephyr project RTOS

Language and syntax support for DeviceTree, made specifically for the [Zephyr project RTOS](https://zephyrproject.org/). Other DeviceTree projects should also work, but are likely to experience missing types and issues with non-standard extensions, such as C preprocessor tokens.

## Features

- Syntax highlighting
- Code completion
- Syntax validation
- Type checking
- Hover
- Go to definition
- Suggested properties

![Code completion](https://raw.githubusercontent.com/trond-snekvik/vscode-devicetree/master/doc/completion.png)

## Installation

To install, download the latest devicetree-X.X.X.vsix package from the GitHub releases tab. Open Visual Studio Code and run the "Install from VSIX..." command, either through the command palette (Ctrl+Shift+P) or by opening the extensions panel, and pressing the `...` menu in the top corner. Locate the VSIX package, press "Install" and reload Visual Studio Code once prompted.

## Extension Settings

The input paths for the DeviceTree extension can be configured:

* `devicetree.autoincludes`: An array of dts file patterns resolving to file to parse before the currently open file. This path is relative to the current file, and defaults to `./build/**/*.dts`, which is the default location of Zephyr RTOS DeviceTree output, relative to the application's CMakeLists.txt location. To get proper completion in the Zephyr project override files for your application, run CMake for your application at least once before opening the override file.
* `devicetree.bindings`: Array of directories in which the DTS binding files are located. Binding files are yaml-files in the format specified by the [Zephyr DeviceTree binding guide](https://docs.zephyrproject.org/latest/guides/dts/index.html#devicetree-bindings). Relative paths are resolved from the root of every open workspace. Defaults to `["./dts/bindings", "zephyr/dts/bindings", "nrf/dts/bindings"]`.

## Parsing order

The extension will parse the included files first, then the main file. When opening the first dts file, this becomes the active main file. Changing focus to a different file will make this the new main file, unless it's part of the inclusions for the previously focused file. The intent is to operate with a base set of include files that the active file (typically an overlay file) includes.

## Known Issues

C preprocessor defines and statements are not supported, meaning raw dts and dtsi files won't be processed correctly. Use the preprocessed build output files instead.
