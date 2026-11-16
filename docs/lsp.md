# DSMM LSP boundary

DSMM-managed external LSP is opt-in. When Deepwork is enabled in startup configuration and `lsp.enabled: true`, DSMM mounts the Host's native MCP client through its trusted installation anchor. The default is disabled. Saving desired settings does not remount a running integration or change existing Agent admission; restart the Host to apply startup LSP configuration. Enabling Deepwork alone does not enable LSP. DSMM's settings UI hides LSP controls.

The default `cordis.patch.yml` doesn't add a separate MCP client row. DSMM leaves DSH's own LSP services and independently configured MCP servers under their native owners. DSMM doesn't download servers or native binaries.

The integration uses the `ocmm-lsp` executable published by the `ocmm` npm package. DSMM does not contain the LSP source, Rust/native build, platform-package matrix, or LSP release workflow, and does not declare `ocmm` as a package dependency. The operator must separately provide the published `ocmm` package and its matching optional `ocmm-lsp-*` platform package in the Host execution environment; installs that omit optional dependencies cannot provide the native binary. No source checkout or parent-repository `dist/` path is a supported fallback.

## Native MCP configuration

The [manual patch](../patches/ocmm-lsp-mcp.example.cordis.patch.yml) is available for independently managed native MCP composition. Use either DSMM startup mounting or an independent row for a given server namespace. Independent composition remains the operator's responsibility, including npm package availability, executable resolution, namespace uniqueness and native lifecycle ownership.

Both paths use these defaults:

- `serverName: dsmm_lsp`
- `command: ocmm-lsp`
- `args: ["mcp"]`, equivalent to running `ocmm-lsp mcp`
- `transport: stdio`
- `failOnStartupError: true`
- `toolCallTimeoutMs: 60000`

`ocmm-lsp` above is the npm package's declared executable. An explicit absolute command override may be used by the Host, but DSMM does not discover a sibling checkout, compile the binary, or publish an alternative LSP artifact.

## Tool interface

With `serverName: dsmm_lsp`, a successful startup mount exposes the tools supplied by the external server. The `ocmm-lsp` interface uses these names:

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

DSMM's read-only role restrictions deny rename and format. The `lspRuntime` status interface reports `disabled`, `ready` or `unavailable`, bounded diagnostic codes and tool names, without executable paths, arguments or environment values. Missing Host anchors, native MCP packages or registered tools prevent a ready state; `failOnStartupError: true` makes startup failure fatal. Tool discovery alone doesn't prove language-server availability or a successful symbol query.

Supported Host versions are listed in [compatibility](compatibility.md). DSH's own definition/references/implementation/hover surface remains separate from the external diagnostics, rename and format interface. Operators must provide and verify the executable and language server, such as `gopls` for Go; DSMM doesn't install or repair that environment.
