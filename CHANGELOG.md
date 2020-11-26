# v2.2.0 DeviceTree in other languages

This release introduces DeviceTree aware language support in C and YAML bindings files, to improve the overall DeviceTree user experience. It also includes improvements to the Context explorer overview tree and some major improvements to the interpretation of some DeviceTree syntax corner cases.

### C and YAML language support

The DeviceTree extension now includes a schema for YAML bindings files that works as input to the RedHat YAML extension. It provides auto completion for field names, validates the values of each field and shows basic hover information for the various fields in the bindings files.

Rudimentary C file support introduces DeviceTree aware completion for the various node and property ID macros, such as `DT_NODELABEL()`. The completion items are always based on the most recently viewed DeviceTree context, so if you switch between different overlay files a lot, make sure you pay attention to the suggestion documentation, which will show which context provided the value.

### Preprocessor rewrite

The preprocessor macro expansion mechanism has been rewritten to fix invalid behavior for macro argument concatenation. This also improves the overall performance, as tokens are only parsed once and looked up in a hashmap of defines, as opposed to the old regex generation.

This rewrite fixes all known issues with complex pinmux macros and other concatenation based macro expressions. It also fixes printing of macros which span over multiple values or includes whole nodes. While these macros would occasionally generate invalid syntax in the preview file before, they should now be printed with their expanded values whenever they hide multiple phandle cells or property values.

### Overview tree improvements

The Context explorer overview tree has been enhanced with new colorful icons. This release adds ADC, DAC, Board and Clock sections, and now lists important bus properties, such as clock speed and flow control. Additionally, the GPIO pins view now fetches pins from nexus node maps as well as STM and Atmel pinmux configuration entries. A range of minor improvements have also been made to the overview tree:
- Account for nodes with multiple interrupts
- Show SPI chip select
- Support partition-less flash instances
- List every ADC channel for ADC users
- Show type name in tooltip

### Other noteworthy changes:

New lint checks:
- Check Flash node fixed partitions range
- Check whether nexus entries have matches
- Treat phandle as an acceptable phandles

Improvements to the DeviceTree parser:
- Accept C `UL` integer suffixes
- Recognize raw * and / in property values as an unbraced expression and generate a warning
- Single character arithmetic support in expressions

Bug fixes:
- GPIO pins:
  - If a property referencing a GPIO pin was overwritten, both the existing and the overwritten value would show up in the GPIO overview. This has been fixed.
  - Pin assignments from the board file would linger in the overview if the overlay file changed after the initial parse run.
- Lint: Value names array length should match the number of top level entries in the matching property.
- Preprocessor: Accept any filename character in includes, except spaces
- Fix glitchy behavior for invalid interrupt and flash partition values in the overview tree
- Correct all type cells lookup usage for signature, lint and hover

General improvements:
- The compiled output view supports all read-only language features
- Completion: Fix ampersand expansion for references
- Hover: Split long macros over multiple lines
- Show macro replacement for single integer values, not just expressions
- NewApp command: Default to folder containing open file
- Context names: Omit folder name for root level contexts
- Override status enum, so snippet doesn't expand to deprecated "ok" value
- Show nodelabels in compiled output
- Show entry names in signature completion
- Show line about required properties in completion items
- Edit in overlay command: Only show when the context has an overlay file
- Copy C identifier command: Return phandle macro for node references, not the node being pointed to.
- Permit commands from non-file schema resources, to accomodate remote development.

# v2.1.0 Context explorer overview tree

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

# v2.0.0 Multiple file support

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

# v1.1.1 Minor Enhancements

- Allow CPU child nodes
- Search for bindings in zephyr and nrf subdirectories
- Let property requiredness be an or-operation in type inheritance
- Parse delete-property and diagnose both delete commands
- Format statements, not nodes
- Add completion for delete commands
- Silence extension in non-workspace contexts
- Lint checks for addresses, ranges and status
- Support binary operations in expressions

# v1.1.0 Update for Zephyr 2.2

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