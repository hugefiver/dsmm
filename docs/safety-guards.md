# DSMM Safety Guards

DSMM 0.3.16 targets exactly DSH `0.2.1-rc.2`. Its guards use `tools/pre-execute` for allow, deny and ask decisions, and `tools/post-execute` for accepted-result truncation. They don't use OpenCode hook names or mutate tool arguments. Deployment overrides belong in the `id: dsmm` Loader entry's `config` object, not a settings.yaml namespace.

## Scope

The default scope is `deepwork-or-dsmm-agent`: helpers apply when the agent is in Deepwork or uses a DSMM preset. `guards.scope: always` extends the helpers; `off` disables these optional helpers, **not** mandatory role identity/read-only/delegation fences or native permissions. Common workflow off likewise grants no new authority.

## Settings

```yaml
- id: dsmm
  name: '@dsmm/dsmm'
  config:
    # Retain other existing DSMM values when editing the native entry.
    guards:
      scope: deepwork-or-dsmm-agent
      shellCommandSafety: true
      gitWriteGuard: ask
      gitWriteScope: all-writes
      toolOutputTruncation:
        enabled: true
        maxInlineBytes: 12000
      planFormatValidation: true
      questionLabelHelper:
        enabled: true
        maxLabelChars: 30
      todoDisciplineHelper: true
```

## Failure messages

All DSMM guard messages begin with `[dsmm safety]`.

- `[dsmm safety] PowerShell command appears to use POSIX shell syntax (...)` rejects clear POSIX-only syntax such as `export` in `pwsh`.
- `[dsmm safety] PowerShell command uses POSIX null redirection (...)` rejects `/dev/null` in `pwsh`.
- `[dsmm safety] PowerShell command uses POSIX \`source\` (...)` rejects `source` in `pwsh`.
- `[dsmm safety] bash command appears to use PowerShell syntax (...)` rejects `$env:` in `bash`.
- Git approval requests identify the applicable automatic Git actions. With `gitWriteGuard: ask`, uncovered DSMM rules require host approval; unavailable approval fails closed. Valid live-Agent rule approvals may satisfy later matching DSMM asks.
- Git denial messages reject actions within `gitWriteScope` when `gitWriteGuard: deny`; approval memory cannot override deny.
- `[dsmm safety] truncated ... output` marks accepted plain-text tool results that were replaced with a head/tail preview.
- `[dsmm safety] plan file contains a malformed checklist entry: ...` rejects malformed checkbox lines in writes to `docs/superpowers/plans/*.md` and `.omo/plans/*.md`.
- `[dsmm safety] question option label exceeds ... characters: ...` rejects `ask_user_question` option labels longer than `maxLabelChars`.
- `[dsmm safety] todo list must keep at least one in_progress item while unfinished work remains; parallel work follows the host todo policy.` rejects unfinished lists without an active item; DSMM does not reject legitimate parallel active items supported by the host.
- `[dsmm safety] todo content must use "[WHERE] [HOW] to [WHY] - expect [RESULT]": ...` applies only to explicitly selected legacy workflow policy. Risk-based policy preserves the native todo contract.

## Shell and Git coverage

Shell checks inspect the command argument for `bash`, `sh`, `zsh`, `pwsh`, and `powershell`. Command parsing separates `;`, newlines, pipes, and `&&`/`||` continuations; it also honors the dialect's normal line continuation escape. Git write detection recognizes an executable named `git` or `git.exe`, including a path-qualified executable, Git global options such as `git -C repo commit`, and the `env` wrapper with its supported options and POSIX-style assignments. Other aliases, shell functions, and wrappers are deliberately unclassified rather than guessed.

`guards.gitWriteScope` is independent of `guards.gitWriteGuard`:

| Scope | Automatic Git coverage |
| --- | --- |
| `all-writes` (default) | All recognized writes, including ordinary add, commit, push, fetch, pull, merge and branch/tag creation. Recognized query forms, such as `branch --show-current`, `remote -v`, `stash list`, `tag --list` and `worktree list`, do not count as writes. |
| `high-risk` | The closed set of force/delete/mirror pushes, hard reset, non-dry-run clean, destructive/forced branch and tag changes, commit amend, rebase rewriting, stash drop/clear, worktree remove/prune, checkout/switch discard and forced replacement, worktree restore, and recognized reference/history modification actions. Ordinary writes are outside this automatic scope. |

For either scope, `ask` requires approval of the covered rules, `deny` rejects covered actions, and `off` contributes no automatic Git decision. `high-risk` only narrows automatic Git protection: explicit shell ask/deny and object-form native command asks still apply. Guard activation, shell dialect safety, readonly ceilings and existing standing Full access/simple-command priority are unchanged. This is not a general dangerous-command detector. Unrecognized aliases/wrappers receive no automatic Git decision; uncertain syntax cannot create a reusable broad approval. All command segments are considered, so an ordinary write before a high-risk action cannot hide the latter.

With `permissionControl.nativeCommands.enabled`, fully recognized linear scripts are eligible for one-call native `danger-full-access` when **each component has no applicable existing DSMM constraint or matches a string whitelist entry**. At least one whitelist hit is not required. For example, with `git commit` whitelisted, `echo before; git commit -m owned; echo after` qualifies under Git `ask` or `deny`, unless another uncovered constraint applies. Replacing commit with an uncovered controlled push retains the original policy path. With no applicable rules, even an unknown static program qualifies; this does not certify safety. Git scope `off`, inactive guard scope and writes outside `high-risk` contribute no Git constraint, while existing exact-shell, outside-read and legacy constraints still count.

The finite authorization grammar supports static literal components joined by `;`, LF/CRLF, `&&`, `||` or `|`, including all branches and pipeline stages, plus unquoted POSIX backslash + LF continuations and token-boundary PowerShell backtick + LF/CRLF continuations. POSIX backslash + CRLF and PowerShell token-internal escaped newlines are unsupported. Quoted separators stay literal. It does not parse full shell syntax: assignments, control flow, groups, expansion, globbing, comments, redirects, here-docs/strings, background execution and unsupported quoting/escapes fall back unchanged. Static interpreter code is not recursively parsed, and a wrapper needs its own string match when controlled. See [native permissions](native-permissions.md#configuration-drawer-and-command-rules) for the complete contract.

String matches override corresponding DSMM constraints, including deny, but never native/third-party deny, native `never`, read-only/tool ceilings or cancellation. A component exact rule uses its original raw text, actual shell executable and cwd; an exact or outside-read constraint on the original whole script requires **all components** to match string entries. Classification effects such as local write/destructive/unknown are not new risk rules. Successful qualification executes the original script once with existing invocation identity checks; it neither changes standing permissions nor creates cross-call approval memory. Unsupported or incompletely evaluated scripts receive no new grant or extra script-specific denial.

The existing schema-driven **Plugins → DSMM bundle config → Permissions** fields expose both options in Global and current DSH profile scopes. Unset uses defaults in Global and restores inheritance in the profile; a named profile can also override `guards.gitWriteScope`. Sparse saves do not pin omitted values. Read-only configuration stays non-writable. Saved settings follow existing new-session admission; they do not apply a live overlay.

## Command-rule approval memory

DSMM remembers approved automatic Git actions, exact explicit shell ask rules and matched object-form native command ask rules only for the **exact live Agent object**. A Git action approval can cover parameter changes within the same action and proven tool/dialect/cwd/static Git context; approving branch creation does not approve branch deletion or a later force push. Explicit shell rules retain their exact command/cwd matching. Each applicable DSMM ask must be satisfied independently. Uncertain context may still require approval on every call.

Only the complete native approval-service result can establish memory. Denial, cancellation, unavailable approval and audit failure do not. Rule/source changes invalidate future memory; Agent disposal, session replacement or controller retirement ends it. Settings may be captured by children, but approvals are not inherited by children or siblings, persisted, restored or shared by session ID. Reducing repeated manual intervention is a behavior and risk change, not unchanged overall risk.

Memory satisfies only DSMM's rule contribution. It neither reuses a native once/sandbox target nor changes standing sandbox permissions. Native escalation, independent downstream or third-party asks/denials, cancellation and native `approval.policy=never` remain authoritative; later calls may still show approval prompts. An already pending native request retains its single-call contract when a rule source changes, without granting memory for the new source. Structured-value replacements, errors, and blocked post-tool results are not truncated into apparently successful text.

Generic Git checks bind approval to the actual invocation and registration and recheck at the existing guard boundary. They retain the Host's mutable in-process middleware trust boundary; they do not guarantee isolation from plugins replacing execution after that guard. Managed Shell retains its existing controlled final-entry checks. Neither path supplies OS isolation or a guarantee that every tool will run without prompts.

Workflow and role instructions also prefer short shell operations and repository-native tools, prohibit cross-shell destructive path composition, require exact path checks before recursive deletion, and prohibit autonomous Git writes. These instructions complement, not replace, the host sandbox and approval pipeline. Read-only role authority is bound to exact live Agent ownership/admission, not a persona label. Native caller filters remain intact. Agent admission restricts inherited tools and installs monotonic execution guards; own-layer definitions are identity-fenced, including a re-registered `read` impersonating a safe operation. rc.2 has no public hide-own-layer filter: a registration may remain displayed, but forbidden/unadmitted invocation must fail. Native sandbox/approval/observation remain authoritative.

## Plan mutation validation

Plan validation recognizes `docs/superpowers/plans/*.md` and `.omo/plans/*.md` beneath the session cwd. Complete `write` validates **only caller-supplied full content**; valid formatting is not authorization, and a stronger native deny or stale CAS still refuses.

On rc.2, protected `edit` has no proven authorized complete pre-commit document preview. When enabled, this helper returns typed pre-execute denial with `unsupported-full-preview`, after checking public edit argument shape. Use an authorized complete-document write instead. DSMM never reads the target with Node FS, proactively invokes native read, refreshes observation/CAS, parses opaque target identity, accepts caller content as a fake preview, or treats a truncated line view/new-string fragment as the final document. This is a fail-closed unsupported seam, not successful format validation or N/A. Native matching/CAS remain untouched; ordinary non-plan edits remain native. Helper off makes no final-document formatting guarantee and does not lift role/host permissions.

Planner main/child roles return complete Markdown for native `exit_plan_mode` review; `/plan` is collaboration state, not a sandbox or upgrade. An authorized coordinator persists through native write. A failed format check doesn't grant permission to read private targets or bypass native matching/CAS.
