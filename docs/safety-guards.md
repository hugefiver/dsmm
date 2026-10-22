# DSMM Safety Guards

DSMM 0.3.10 targets exactly DSH `0.2.1-rc.2`. Its guards use `tools/pre-execute` for allow, deny and ask decisions, and `tools/post-execute` for accepted-result truncation. They don't use OpenCode hook names or mutate tool arguments. Deployment overrides belong in the `id: dsmm` Loader entry's `config` object, not a settings.yaml namespace.

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
- `[dsmm safety] git write command requires explicit user approval before running: git ...` requests host approval for mutating git operations such as `git add`, `git rm`, `git mv`, `git commit`, `git push`, `git tag`, `git merge`, `git rebase`, `git cherry-pick`, `git revert`, `git reset`, `git clean`, `git stash`, `git checkout`, `git switch`, `git pull`, `git fetch`, `git remote`, `git submodule`, and `git worktree`, including forms with git global options such as `git -C repo commit`. If host approval is unavailable, dsh fails closed.
- `[dsmm safety] git write command is disabled by dsmm settings: git ...` denies those same git write operations when `gitWriteGuard: deny`.
- `[dsmm safety] truncated ... output` marks accepted plain-text tool results that were replaced with a head/tail preview.
- `[dsmm safety] plan file contains a malformed checklist entry: ...` rejects malformed checkbox lines in writes to `docs/superpowers/plans/*.md` and `.omo/plans/*.md`.
- `[dsmm safety] question option label exceeds ... characters: ...` rejects `ask_user_question` option labels longer than `maxLabelChars`.
- `[dsmm safety] todo list must keep at least one in_progress item while unfinished work remains; parallel work follows the host todo policy.` rejects unfinished lists without an active item; DSMM does not reject legitimate parallel active items supported by the host.
- `[dsmm safety] todo content must use "[WHERE] [HOW] to [WHY] - expect [RESULT]": ...` applies only to explicitly selected legacy workflow policy. Risk-based policy preserves the native todo contract.

## Shell and Git coverage

Shell checks inspect the command argument for `bash`, `sh`, `zsh`, `pwsh`, and `powershell`. Command parsing separates `;`, newlines, pipes, and `&&`/`||` continuations; it also honors the dialect's normal line continuation escape. Git write detection recognizes an executable named `git` or `git.exe`, including a path-qualified executable, Git global options such as `git -C repo commit`, and the `env` wrapper with its supported options and POSIX-style assignments. Other aliases, shell functions, and wrappers are deliberately unclassified rather than guessed.

Known write operations are `add`, `am`, `apply`, `branch`, `checkout`, `cherry-pick`, `clean`, `clone`, `commit`, `fetch`, `init`, `merge`, `mv`, `pull`, `push`, `rebase`, `remote`, `reset`, `restore`, `revert`, `rm`, `stash`, `submodule`, `switch`, `tag`, and `worktree`. The guard also classifies mutating `config`, `notes`, `replace`, `update-ref`, and `symbolic-ref` forms, plus `reset --hard` and destructive `stash` actions. With `gitWriteGuard: ask`, each known write returns an ask decision for the host to compose with user approval; with `deny`, it is rejected; with `off`, it is not classified by DSMM. An unrecognized alias or wrapper receives no DSMM git decision.

DSMM's pre-execute handler runs before downstream handlers. Its own deny wins immediately. For its own ask, DSMM calls downstream and returns the ask only when downstream allowed the call; a downstream ask or deny is preserved. This keeps another safety policy's stricter decision intact rather than replacing it with DSMM's request. Structured-value replacements, errors, and blocked post-tool results are not truncated into apparently successful text.

Workflow and role instructions also prefer short shell operations and repository-native tools, prohibit cross-shell destructive path composition, require exact path checks before recursive deletion, and prohibit autonomous Git writes. These instructions complement, not replace, the host sandbox and approval pipeline. Read-only role authority is bound to exact live Agent ownership/admission, not a persona label. Native caller filters remain intact. Agent admission restricts inherited tools and installs monotonic execution guards; own-layer definitions are identity-fenced, including a re-registered `read` impersonating a safe operation. rc.2 has no public hide-own-layer filter: a registration may remain displayed, but forbidden/unadmitted invocation must fail. Native sandbox/approval/observation remain authoritative.

## Plan mutation validation

Plan validation recognizes `docs/superpowers/plans/*.md` and `.omo/plans/*.md` beneath the session cwd. Complete `write` validates **only caller-supplied full content**; valid formatting is not authorization, and a stronger native deny or stale CAS still refuses.

On rc.2, protected `edit` has no proven authorized complete pre-commit document preview. When enabled, this helper returns typed pre-execute denial with `unsupported-full-preview`, after checking public edit argument shape. Use an authorized complete-document write instead. DSMM never reads the target with Node FS, proactively invokes native read, refreshes observation/CAS, parses opaque target identity, accepts caller content as a fake preview, or treats a truncated line view/new-string fragment as the final document. This is a fail-closed unsupported seam, not successful format validation or N/A. Native matching/CAS remain untouched; ordinary non-plan edits remain native. Helper off makes no final-document formatting guarantee and does not lift role/host permissions.

Planner main/child roles return complete Markdown for native `exit_plan_mode` review; `/plan` is collaboration state, not a sandbox or upgrade. An authorized coordinator persists through native write. A failed format check doesn't grant permission to read private targets or bypass native matching/CAS.
