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