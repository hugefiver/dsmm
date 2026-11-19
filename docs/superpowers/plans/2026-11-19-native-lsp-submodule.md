# Native LSP submodule

Expose a disabled-by-default `dsmm-lsp` entry in the DSMM bundle, backed by the package subpath `@dsmm/dsmm/lsp`. The DSH Plugins switch controls this entry. Honor the Host's applied or restart-required result. A disabled, pending or failed entry must not cause Core to start a second bridge.

The module uses the existing trusted Host MCP client, configured executable and `lsp.*` connection parameters. Keep Deepwork admission and readonly ceilings intact. Only tools registered by the module count towards readiness and may be withdrawn on disposal. Independently configured MCP integrations remain independent. Do not install executables or edit an operator's Host configuration.

Old compositions without the bundle entry retain the explicit startup `lsp.enabled` behavior. In compositions with the entry, its native switch is authoritative: users of an old enabled configuration enable the entry once after upgrading, and need not re-enter connection settings. An explicit native disable must persist across restart.

Exercise native module enable, disable and reactivation, verify a tool actually executes, and check independent tool ownership, reported state and readonly restrictions. Run real language-server operations where an executable and Host anchor are available.
