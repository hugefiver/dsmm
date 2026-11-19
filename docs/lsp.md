# DSMM LSP boundary

In **Plugins → DSMM**, enable the `dsmm-lsp` entry (`@dsmm/dsmm/lsp`) to start the external LSP bridge. It is off by default. Follow the Host's toggle result: an applied change takes effect in the running Host; a restart-required change takes effect after restart. Turning the entry off withdraws its tools and stays off across restart. The startup Deepwork module and each calling Agent's admission still apply.

The bundle's native entry is the sole switch. On upgrading from a composition with `lsp.enabled: true`, enable `dsmm-lsp` once; the existing connection settings are reused. In an older composition with no LSP entry, Core still mounts the bridge when Deepwork and `lsp.enabled` are both enabled at startup. Neither path edits Host configuration, installs a server, or takes over DSH's own LSP or an independent MCP.

The integration uses the `ocmm-lsp` executable published by the `ocmm` npm package. DSMM does not contain the LSP source, Rust/native build, platform-package matrix, or LSP release workflow, and does not declare `ocmm` as a package dependency. The operator must separately provide the published `ocmm` package and its matching optional `ocmm-lsp-*` platform package in the Host execution environment; installs that omit optional dependencies cannot provide the native binary. No source checkout or parent-repository `dist/` path is a supported fallback.

## Native MCP configuration

The [manual patch](../patches/ocmm-lsp-mcp.example.cordis.patch.yml) is available for independently managed native MCP composition. Use a distinct `serverName` for each active client. Independent composition remains the operator's responsibility, including npm package availability, executable resolution, namespace uniqueness and native lifecycle ownership.

For the DSMM bridge, put connection parameters in `lsp` in the [global deployment configuration or native Core override](settings-status.md#deployment-layers-and-native-editors). The bridge reads the Core startup capture; restart after changing connection settings. `cwd` and `env` select the child process's working directory and environment. The defaults are:

- `serverName: dsmm_lsp`
- `command: ocmm-lsp`
- `args: ["mcp"]`, equivalent to running `ocmm-lsp mcp`
- `transport: stdio`
- `failOnStartupError: true`
- `toolCallTimeoutMs: 60000`

`ocmm-lsp` above is the npm package's declared executable. An explicit absolute command override may be used by the Host, but DSMM does not discover a sibling checkout, compile the binary, or publish an alternative LSP artifact.

## Tool interface

With `serverName: dsmm_lsp`, an active bridge exposes the tools supplied by the external server. The `ocmm-lsp` interface uses these names:

- `mcp__dsmm_lsp__status`
- `mcp__dsmm_lsp__diagnostics`
- `mcp__dsmm_lsp__goto_definition`
- `mcp__dsmm_lsp__find_references`
- `mcp__dsmm_lsp__find_symbol_related`
- `mcp__dsmm_lsp__symbols`
- `mcp__dsmm_lsp__prepare_rename`
- `mcp__dsmm_lsp__rename`
- `mcp__dsmm_lsp__format`

`format` applies the language server's document edits to the source file atomically. The debug adapter protocol (DAP) remains a separate debugging surface and is not an MCP tool.

DSMM's read-only role restrictions deny rename and format. The `lspRuntime` status interface reports `disabled`, `ready` or `unavailable`, bounded diagnostic codes and tool names, without executable paths, arguments or environment values. Only this bridge's live registrations count toward `ready`. Disabling it withdraws its tools from both the Host and resident Agents' isolated preset registries. Independent tools, even with a matching name prefix, remain under their original owner. Missing Host anchors, native MCP packages or registered tools prevent a ready state. With `failOnStartupError: true`, an unsuccessful mount fails the owning entry. Tool discovery alone doesn't prove language-server availability or a successful symbol query.

Supported Host versions are listed in [compatibility](compatibility.md). DSH's own definition/references/implementation/hover surface remains separate from the external diagnostics, rename and format interface. Operators must provide and verify the executable and language server, such as `gopls` for Go; DSMM doesn't install or repair that environment.
