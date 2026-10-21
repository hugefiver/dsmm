> DSH adapter boundary: resolve this resource from the loaded skill's directory resourceBase. Examples are not authority: installation/download/login, private state, Git writes and destructive operations need exact explicit authorization. Use only tools and native roles actually exposed in the current catalog and allowed by the caller; otherwise use a real direct fallback or report the limitation. Translate shell examples to the active runtime.

# DAP Client (`dap.mjs`) — Drive the Debugger's Protocol, Not Its Text

**Design modeled on the `debug` tool of oh-my-pi (https://github.com/can1357/oh-my-pi, branch omp2).** Their harness proved the useful shape: one structured debug surface with bounded output, stop snapshots, and classified errors. This script brings the same discipline to any shell without registering a tool or adding a dependency.

Debuggers that speak the Debug Adapter Protocol (DAP) expose a machine-readable JSON protocol. Driving DAP beats screen-scraping a PTY for the same reason an API beats OCR: structured stops, variables, and errors. **If an already-available debugger speaks DAP, use this script instead of parsing `gdb` or `pdb` text.**

The script is at `references/scripts/dap.mjs`. It is zero dependency and runs with Node; Bun is compatible when it is already available.

---

## When to use which interface

| Situation | Use |
|---|---|
| Source-level debugging of Python, Go, Node, or native code with breakpoints, stepping, and variables | `dap.mjs` |
| Browser-served JS, or anything already in Chrome | Scripted CDP — see `references/runtimes/node.md` |
| Stripped binary, no source, no symbols | Ghidra (static) plus the matching live-debugging reference |
| The debugger has no DAP mode | pwndbg, with the output-budget rule from `references/methodology/00-setup.md` |

---

## Start the REPL

`dap.mjs` is a persistent REPL: it reads one command per line on stdin and writes bounded text on stdout. Keep it running for the debug session, send it commands through its stdin, and watch its stdout for `STOP:` rather than polling.

PowerShell / Node:

```powershell
$dapScript = Join-Path $skillResourceBase "references\scripts\dap.mjs" # resourceBase from native skill load
node $dapScript
```

If Bun is already installed and selected for the session, the equivalent is `bun $dapScript`. The client uses its current runtime to launch `.mjs`, `.cjs`, and `.js` adapter scripts; Bun also accepts `.ts` adapter scripts. Native Node execution does not assume a TypeScript loader.

Do not install, download, or globally add an adapter to use this client. Supply an adapter executable or script that is already present in the project, toolchain, or user-approved environment. If no suitable adapter is available, report that boundary and use the runtime reference's supported non-DAP method.

### Commands

| Command | Effect |
|---|---|
| `launch <adapter> <program> [args...]` | Spawn an already-available stdio adapter executable or `.mjs`/`.cjs`/`.js` script, then launch the program; adapter and program are required |
| `attach <host:port>` | Connect to an already-listening adapter over TCP and attach |
| `break <file>:<line>` / `rmbreak <file>:<line>` | Set or remove a source breakpoint |
| `continue` / `step` / `next` / `stepin` / `stepout` / `pause` | Execution control; each prints a `STOP:` snapshot when the debuggee next stops |
| `stack [limit]` | TSV backtrace, bounded |
| `scopes` | Scopes of the top frame with their `variablesReference` values |
| `vars <ref>` | Variables below a `variablesReference` from `scopes`; references are session-scoped |
| `eval <expr>` | Evaluate in the top frame |
| `threads` / `sessions` | Thread list / session state |
| `terminate` / `quit` | End the debuggee / exit the REPL |

`<host:port>` means a host with a numeric port only. A Windows path such as `C:\workspace\adapter.mjs` is an adapter path, not a TCP endpoint. Wrap adapter, program, and breakpoint paths containing spaces in either single or double quotes; backslashes are literal and the REPL never evaluates a shell command. An unmatched quote or missing `launch` adapter/program returns `ERR: invalid-args`.

### Output contract

- Tabular results are TSV with a header row.
- Hard caps are `MAX_ROWS = 100` and `MAX_OUTPUT_BYTES = 32 KB`. Overflow prints `TRUNCATED: rows dropped=N bytes dropped=M`; output is never silently cut.
- Every adapter-derived stdout value, including `STOP:` frame/reason/path fields and `EVAL` results, is UTF-8 byte-bounded to 32 KB. A clipped line emits `TRUNCATED: bytes dropped=N` immediately after it.
- After every continue or step, stdout emits `STOP: stopped reason=<why> threadId=<id> <frame> at <file>:<line>:<col>`. A debuggee exit emits `EXIT: terminated`.
- Errors are one classified line: `ERR: invalid-args | no-session | adapter-failed | unverified-breakpoint | timeout | terminated | adapter-error`.
- Every request has a 15-second timeout (override only with `DAP_TIMEOUT_MS`); a timeout does not close an otherwise usable session.
- A rejected or timed-out launch, configuration, or attach handshake never reports `READY`; the client cleans up that failed setup so a later launch or attach can retry.
- Set `DAP_DEBUG=1` only when protocol traffic itself is needed; it writes capped raw-message previews to stderr.

### Adapter behavior handled by the client

- **debugpy** requires `console: "internalConsole"` in the launch request and can withhold `initialized` for unknown `adapterID` values. The client sends the recognized ID when the adapter path identifies debugpy and launches before awaiting the event.
- **lldb-dap** can report a false launch response after starting successfully, and can report `threadId: 0` at entry. The client treats process and stopped events as the signal.

---

## Existing-adapter example

With an existing project-local adapter script, quote any path that contains spaces:

```text
launch "C:\workspace path\tools\project-dap-adapter.mjs" "C:\workspace path\src\program.js"
break "C:\workspace path\src\program.js:12"
continue
STOP: stopped reason=breakpoint threadId=1 main at C:\workspace path\src\program.js:12:1
stack
scopes
vars 6
eval total
terminate
quit
```

Cleanup is part of the session: terminate the owned debuggee, then quit the REPL. `quit` destroys a socket transport or kills an adapter process started by this client. List wrapper scripts in the task-owned temporary resource checklist and remove only exact owned paths according to Phase 9.
