> DSH adapter boundary: resolve this resource from the loaded skill's directory resourceBase. Examples are not authority: installation/download/login, private state, Git writes and destructive operations need exact explicit authorization. Use only tools and native roles actually exposed in the current catalog and allowed by the caller; otherwise use a real direct fallback or report the limitation. Translate shell examples to the active runtime.

# Phase 0 + 1: Environment Assessment and Resource Ownership

Before attaching, identify what's running and which resources this task will own. Keep current investigation evidence in conversation or task-owned temporary storage, not product process documents.

---

## Phase 0 — Environment Assessment

Map the ground truth before you attach. Attaching the wrong way wastes the first hour.

### 1. Identify the runtime

Read the actual manifest file, don't guess from extensions:

- Python → `pyproject.toml`, `requirements*.txt`, `setup.py`, `uv.lock`, `.python-version`
- Node → `package.json` (check `scripts`, check `engines`, check `type: module`)
- Rust → `Cargo.toml`, `rust-toolchain*`
- Go → `go.mod`, `go.sum`
- Native / mixed → `Makefile`, `CMakeLists.txt`, the binary itself (`file <path>`)

### 2. Load the matching runtime reference

The moment you know the runtime, open `references/runtimes/<runtime>.md`. The commands in this phase (and every phase after) are runtime-specific. The shape of the answers is the same; the commands are not.

### 3. Gather observable environment state

The shape of the answers you need (commands in the runtime reference):

| Question | Why it matters |
|---|---|
| What binary/interpreter/runtime actually launches the process? | Determines debugger flag plumbing. Wrappers (`tsx`, `poetry run`, `cargo run`, `bun`, supervisor scripts) change how flags propagate. |
| Is there already a debug-relevant port in use, or another instance of the service running? | Either attach to it or kill it deliberately — never silently compete. |
| Are symbols / source maps / debug info present and correct? | This determines whether breakpoints land on the right lines. Compiled-but-not-debug builds, stripped binaries, and incomplete source maps all silently misplace breakpoints. |
| Does the code path require env vars, config files, or auth tokens to reach the bug? | Missing env often produces early-return paths that masquerade as the bug itself. |
| Is there an existing failing test or known repro? | Prefer amplifying an existing repro over inventing one. |
| Are watchers (file watchers, hot reloaders, supervisors) going to restart the process mid-session? | If yes, turn them off before attaching. Restarts drop inspector connections and invalidate breakpoints. |

### 4. Gate check

If any answer is "I'm not sure", you are not ready for Phase 1. Investigate until certain. Guessing here cascades into false-positive hypotheses in Phase 2.

---

## Phase 1: Temporary Resource Ownership

If file-backed debug material is needed, use a unique task-owned directory under the approved OS temporary root and verify its parent before creation. Session-only investigation needs no directory or checklist file. Don't read, modify, delete, or adopt any existing `.debug-journal.md`, and don't change `.git/info/exclude`. No repository hypothesis or experiment journal is required or permitted.

Before creating each artifact or changing temporary state, capture only what's needed for safe cleanup:

| Resource | Ownership and restoration information |
| --- | --- |
| Temporary file or directory | Exact path, task ownership, and exact cleanup target |
| Source instrumentation | Initial relevant hunk and task-owned patch to remove it without discarding other edits |
| Process or debugger session | PID plus start identity, owned session/context, and targeted shutdown action |
| Environment or configuration override | Scope and previous value/state to restore |
| Fixture, port, proxy, or browser profile | Unique identity, ownership check, and safe release action |

Keep this ownership checklist and short-lived hypothesis/evidence state in the agent session; temporary storage is optional when resumption needs it. Synchronize useful findings at delivery or major phase boundaries, not every checklist update. Temporary or disposable artifacts need no repeated stability/hash checks or correct status record at every instant. Store raw reproduction evidence temporarily only as needed; durable tests and docs describe final valid requirements and the current mechanism only. Exact cleanup identities and restoration data must remain available until cleanup succeeds.

Inspect the initial working-tree state so cleanup can distinguish this task's edits from existing user work. Resource ownership doesn't confer permission to kill another process, alter system configuration, or discard a file. Escalate when safe restoration or required authorization is uncertain.
