# Context explorer overview tree

Adds overview tree to the context explorer, providing a summary of gpio ports, interrupts, flash partitions and buses.

Additional changes:
- Use "DeviceTree" name throughout
- Add right click menu command for editing nodes and properties in overlay file
- Warn about expressions in property values without parenthesis
- Activate when commands fire to prevent "missing implementation" warning
- Include raw PHandles when looking for references
- Mark macros with detail text in completion list
- Rename "Copy C identifier to clipboard" to just "Copy C identifier"
- Go to definition now includes node names and properties
- Bug fixes:
  - Check #address-cells and #size-cells in semantic parent, not literal parent
  - Fix crash in code completion on root-level entries
  - Ensure all types from included bindings are loaded, regardless of discovery order
  - Fix bug where overlay files would be dropped erronously
  - Wait for Zephyr board lookup to complete before activating, preventing unexpected "missing board" warning
  - Now prioritizing spec defined standard properties below inherited properties
- Lint:
  - Check for missing reg property when node has address
  - Warn about duplicate labels
- Syntax:
  - Allow preprocessor entries in node contents
  - Treat path separators as part of cursor word

# Multiple file support

This is a major rewrite of the Devicetree extension.
The primary change is the new support for the C preprocessor, which enables support for multiple files and contexts.
All language features are now supported in board files, as well as overlay files, and the extension no longer depends on a compiled dts output file to work.

Highlights:
- Preprocessor now evaluated, including defines and includes
- Board files and overlay files are combined into one context, no need for compiled dts file
- About a dozen new lint checks
- Context aware auto completion
- Board context explorer in sidebar
- Integration with West
- Full bindings support

# Minor Enhancements

- Allow CPU child nodes
- Search for bindings in zephyr and nrf subdirectories
- Let property requiredness be an or-operation in type inheritance
- Parse delete-property and diagnose both delete commands
- Format statements, not nodes
- Add completion for delete commands
- Silence extension in non-workspace contexts
- Lint checks for addresses, ranges and status
- Support binary operations in expressions

# Update for Zephyr 2.2

- Allows phandles without enclosing <> brackets.
- Default include is *.dts, not *.dts_compiled
- phandle arrays fetch parameter names from handle type
- Include all dependencies, resolving build errors on windows

# Version 1.0.0

The first release of the DeviceTree extension includes support for:
- Syntax highlighting
- Code completion
- Type checking (Zephyr only)
- Syntax validation
- Go to definition

The first version is made specifically for the [Zephyr project RTOS](https://www.zephyrproject.org/).