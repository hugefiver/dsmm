import assert from "node:assert/strict";
import { test } from "node:test";
import { classifyKnownGitWrite, classifyShellDialectViolation, evaluateGitCommand, parseShellCommand } from "../lib/shell-command.js";

test("parseShellCommand emits dequoted words and boundaries", () => {
  const command = "CI=true git \\" + "\n  commit -m 'release note'; git status";
  assert.deepEqual(parseShellCommand(command, "posix"), [
    {
      tokens: [
        { kind: "word", value: "CI=true", quoted: false },
        { kind: "word", value: "git", quoted: false },
        { kind: "word", value: "commit", quoted: false },
        { kind: "word", value: "-m", quoted: false },
        { kind: "word", value: "release note", quoted: true }
      ],
      words: ["CI=true", "git", "commit", "-m", "release note"]
    },
    {
      tokens: [
        { kind: "word", value: "git", quoted: false },
        { kind: "word", value: "status", quoted: false }
      ],
      words: ["git", "status"]
    }
  ]);
});

test("classifyKnownGitWrite identifies known POSIX writes", () => {
  const cases: readonly [string, string][] = [
    ["git commit -m x", "commit"],
    ["git.exe push origin main", "push"],
    ['"/usr/bin/git" rebase main', "rebase"],
    ["env -i CI=true git tag v1", "tag"],
    ["env -C . git tag v1", "tag"],
    ["env -u FOO git tag v1", "tag"],
    ["env -a git git tag v1", "tag"],
    ["env -v git commit -m smoke", "commit"],
    ["env --debug git push origin main", "push"],
    ["env -vv git commit -m smoke", "commit"],
    ["env -ivv git push origin main", "push"],
    ["env -vvC . git tag v1", "tag"],
    ["env -vvC. git clean -fd", "clean"],
    ["env --file=NUL git commit -m smoke", "commit"],
    ["env --ignore-signal=TERM git push origin main", "push"],
    ["env --ignore-signal git commit -m smoke", "commit"],
    ["env --default-signal git push origin main", "push"],
    ["env --block-signal git tag v1", "tag"],
    ["env --list-signal-handling git clean -fd", "clean"],
    ["env --default-signal=TERM git commit -m smoke", "commit"],
    ["env --block-signal=TERM git push origin main", "push"],
    ["env -- - /usr/bin/git commit -m smoke", "commit"],
    ["env -fNUL git commit -m smoke", "commit"],
    ["env -vfNUL git push origin main", "push"],
    ["env -S 'git commit -m smoke'", "commit"],
    ["env -vS 'git push origin main'", "push"],
    ["env env git commit -m smoke", "commit"],
    ["env -i CI=true env -v git push origin main", "push"],
    ["env -S 'env git commit -m smoke'", "commit"],
    ["env - PATH=/bin git commit -m smoke", "commit"],
    ["env - /usr/bin/git push origin main", "push"],
    ["env -C. git commit -m smoke", "commit"],
    ["env -uFOO git push origin main", "push"],
    ["env -agit git commit -m smoke", "commit"],
    ["env FOO-BAR=1 git push origin main", "push"],
    ["env =x git push origin main", "push"],
    ["env -- git commit -m smoke", "commit"],
    ["env -i CI=true -- git push origin main", "push"],
    ["env -- CI=true git commit -m smoke", "commit"],
    ["env -- CI=true NAME=value git tag v1", "tag"],
    ["env -- FOO-BAR=1 BUILD.NUM=2 git commit -m smoke", "commit"],
    ["env -- =x git commit -m smoke", "commit"],
    ["CI=true git -C repo reset --hard HEAD", "reset --hard"],
    ["git \\" + "\n clean -fd", "clean"],
    ["git config user.name Alice", "config"],
    ["git config --global --unset user.name", "config"],
    ["git notes add -m x", "notes add"],
    ["git replace old new", "replace"],
    ["git update-ref refs/heads/x HEAD", "update-ref"],
    ["git symbolic-ref HEAD refs/heads/main", "symbolic-ref"],
    ["git symbolic-ref --delete HEAD", "symbolic-ref"]
  ];

  for (const [command, operation] of cases) {
    assert.equal(classifyKnownGitWrite(command, "posix"), operation, command);
  }
});

test("classifyKnownGitWrite leaves POSIX reads and unknown operations unclassified", () => {
  const commands = [
    "git status",
    "git log",
    "git diff",
    "git show",
    "git rev-parse HEAD",
    "git config --get user.name",
    "git config user.name",
    "git publish",
    "printf '%s' 'git commit -m x'",
    "env -- git status",
    "env -- CI=true git status",
    "env FOO-BAR=1 git status",
    "env -- FOO-BAR=1 git status",
    "env =x git status",
    "env -- =x git status",
    "env -- -i git commit -m smoke",
    "env -X=1 git commit -m smoke",
    "env -C. git status",
    "env -uFOO git status",
    "env -agit git status",
    "env -v git status",
    "env --debug git --version",
    "env -vv git status",
    "env -ivv git --version",
    "env -vvC . git status",
    "env -vvC. git --version",
    "env --file=NUL git status",
    "env --ignore-signal=TERM git --version",
    "env --ignore-signal git status",
    "env --default-signal git --version",
    "env --block-signal git status",
    "env --list-signal-handling git --version",
    "env --default-signal=TERM git status",
    "env --block-signal=TERM git --version",
    "env -- - /usr/bin/git --version",
    "env -fNUL git status",
    "env -vfNUL git --version",
    "env --file git commit -m smoke",
    "env -S 'git status'",
    "env -S 'git status; git commit -m smoke'",
    "env env git status",
    "env -i CI=true env git --version",
    "env -S 'env git status'",
    "env - PATH=/bin git status",
    "env - /usr/bin/git --version",
    "FOO-BAR=1 git commit -m smoke",
    "printf '%s' 'env -- git commit -m x'",
    "git symbolic-ref HEAD",
    "git notes list",
    "git replace"
  ];

  for (const command of commands) {
    assert.equal(classifyKnownGitWrite(command, "posix"), undefined, command);
  }
});

test("classifyKnownGitWrite continues after recognized Git queries", () => {
  const cases: readonly [string, string][] = [
    ["git config user.name; git commit -m x", "commit"],
    ["git notes list\ngit tag v1", "tag"],
    ["git symbolic-ref HEAD && git clean -fd", "clean"],
    ["git status & git push origin main", "push"]
  ];

  for (const [command, operation] of cases) {
    assert.equal(classifyKnownGitWrite(command, "posix"), operation, command);
  }
});

test("classifyKnownGitWrite identifies known PowerShell writes", () => {
  const cases: readonly [string, string][] = [
    ['& "C:\\Program Files\\Git\\cmd\\git.exe" push origin main', "push"],
    ["GIT.EXE -C repo tag v1", "tag"],
    ["ENV.EXE -i CI=true -- GIT.EXE push origin main", "push"],
    ["ENV.EXE FOO-BAR=1 GIT.EXE push origin main", "push"],
    ["ENV.EXE -C. GIT.EXE push origin main", "push"],
    ['env - "C:\\Program Files\\Git\\cmd\\git.exe" commit -m smoke', "commit"],
    ["git `\n commit -m x", "commit"],
    ["Write-Output ok\ngit update-ref refs/heads/x HEAD", "update-ref"]
  ];

  for (const [command, operation] of cases) {
    assert.equal(classifyKnownGitWrite(command, "powershell"), operation, command);
  }
});

test("Git queries in mixed command families and the PowerShell discovery command are read-only", () => {
  const queries = [
    "git branch", "git branch --show-current", "git branch --list 'release*'",
    "git branch -avv", "git branch -r", "git branch --list --format='%(refname)' --sort=-committerdate",
    "git branch --contains main", "git branch --no-merged", "git branch --points-at HEAD",
    "git remote", "git remote -v", "git remote --verbose", "git remote show -n origin", "git remote get-url --push --all origin",
    "git stash list", "git stash list -n 2 --format=%s", "git stash show --stat stash@{0}",
    "git tag", "git tag -l 'v*' --format='%(refname)'", "git tag --verify v1", "git tag -v v1", "git tag -n10 -l",
    "git worktree list --porcelain", "git submodule", "git submodule status --recursive", "git submodule summary --summary-limit 2",
    "git config --file --unset --get user.name", "git config --show-origin user.name", "git config get user.name", "git config list",
    "git notes --ref=review list", "git replace --list", "git symbolic-ref -m --delete HEAD",
    "git reflog show", "git reflog exists HEAD",
    "git --help commit", "git --version", "git -c core.pager=--force --help",
    "git commit -h", "git rebase --show-current-patch",
    "Get-Location; git status --short; git branch --show-current; git remote -v; git log -8 --oneline; git status -sb; Get-Command go,make,golangci-lint -ErrorAction SilentlyContinue | Select-Object Name,Source; go version"
  ];
  for (const command of queries) {
    assert.deepEqual(evaluateGitCommand(command, "powershell"), [], command);
    assert.equal(classifyKnownGitWrite(command, "powershell"), undefined, command);
  }
});

test("Git writes have distinct stable action identities and the closed high-risk set", () => {
  const cases: readonly [string, string, "write" | "high-risk"][] = [
    ["branch topic", "branch.create", "write"], ["branch -c topic copy", "branch.copy", "write"],
    ["branch -m topic renamed", "branch.rename", "write"], ["branch -u origin/main topic", "branch.set-upstream", "write"],
    ["branch --unset-upstream topic", "branch.unset-upstream", "write"], ["branch --edit-description topic", "branch.edit-description", "write"],
    ["branch -d topic", "branch.delete", "high-risk"], ["branch -D topic", "branch.force-delete", "high-risk"],
    ["branch -fd topic", "branch.force-delete", "high-risk"], ["branch -f topic HEAD", "branch.force-update", "high-risk"],
    ["branch -C topic copy", "branch.force-copy", "high-risk"], ["branch -fc topic copy", "branch.force-copy", "high-risk"],
    ["branch -M topic renamed", "branch.force-rename", "high-risk"], ["branch --move --force topic renamed", "branch.force-rename", "high-risk"],
    ["remote add origin url", "remote.add", "write"], ["remote rename origin upstream", "remote.rename", "write"],
    ["remote rm origin", "remote.remove", "write"], ["remote set-head origin -a", "remote.set-head", "write"],
    ["remote set-branches origin main", "remote.set-branches", "write"], ["remote set-url origin url", "remote.set-url", "write"],
    ["remote update", "remote.update", "write"], ["remote prune origin", "remote.prune", "write"],
    ["stash", "stash.push", "write"], ["stash push -m note", "stash.push", "write"], ["stash save note", "stash.save", "write"],
    ["stash apply", "stash.apply", "write"], ["stash pop", "stash.pop", "write"], ["stash branch topic", "stash.branch", "write"],
    ["stash create", "stash.create", "write"], ["stash store HEAD", "stash.store", "write"],
    ["stash drop", "stash.drop", "high-risk"], ["stash clear", "stash.clear", "high-risk"],
    ["tag v1", "tag.create", "write"], ["tag -d v1", "tag.delete", "high-risk"], ["tag -f v1", "tag.force-update", "high-risk"],
    ["worktree add ../topic", "worktree.add", "write"], ["worktree move a b", "worktree.move", "write"],
    ["worktree lock a", "worktree.lock", "write"], ["worktree unlock a", "worktree.unlock", "write"],
    ["worktree repair a", "worktree.repair", "write"], ["worktree remove a", "worktree.remove", "high-risk"], ["worktree prune", "worktree.prune", "high-risk"],
    ["submodule add url", "submodule.add", "write"], ["submodule init", "submodule.init", "write"],
    ["submodule deinit a", "submodule.deinit", "write"], ["submodule update --init", "submodule.update", "write"],
    ["submodule sync", "submodule.sync", "write"], ["submodule set-branch -b main a", "submodule.set-branch", "write"],
    ["submodule set-url a url", "submodule.set-url", "write"],
    ["commit -m x", "commit.create", "write"], ["commit --amend -m x", "commit.amend", "high-risk"],
    ["push origin main", "push.update", "write"], ["push -f origin main", "push.force", "high-risk"],
    ["push --force-with-lease=main:HEAD origin main", "push.force-with-lease", "high-risk"],
    ["push --force-if-includes origin main", "push.force-if-includes", "high-risk"],
    ["push origin +main", "push.force", "high-risk"], ["push --repo=origin +main", "push.force", "high-risk"],
    ["push -d origin main", "push.delete", "high-risk"], ["push origin :main", "push.delete", "high-risk"],
    ["push --mirror origin", "push.mirror", "high-risk"],
    ["reset --hard HEAD", "reset.hard", "high-risk"], ["reset --soft HEAD~1", "reset.update", "write"],
    ["reset --mixed HEAD", "reset.update", "write"], ["reset --keep HEAD", "reset.update", "write"],
    ["clean -ffdx", "clean.remove", "high-risk"], ["clean -i", "clean.remove", "high-risk"],
    ["rebase main", "rebase.start", "high-risk"], ["rebase --continue", "rebase.continue", "high-risk"],
    ["rebase --skip", "rebase.skip", "high-risk"], ["rebase --abort", "rebase.abort", "high-risk"],
    ["rebase --quit", "rebase.quit", "high-risk"], ["rebase --edit-todo", "rebase.edit-todo", "high-risk"],
    ["checkout --detach HEAD", "checkout.switch", "write"], ["checkout -b topic", "checkout.create", "write"],
    ["checkout -B topic", "checkout.discard", "high-risk"], ["checkout --force main", "checkout.discard", "high-risk"],
    ["checkout -- file", "checkout.discard", "high-risk"], ["checkout HEAD file", "checkout.discard", "high-risk"],
    ["switch main", "switch.switch", "write"], ["switch -c topic", "switch.create", "write"],
    ["switch -C topic", "switch.discard", "high-risk"], ["switch --discard-changes main", "switch.discard", "high-risk"],
    ["restore --staged file", "restore.staged", "write"], ["restore file", "restore.worktree", "high-risk"],
    ["restore -SW file", "restore.worktree", "high-risk"],
    ["config --add user.name Alice", "config.add", "write"], ["config user.name Alice", "config.set", "write"],
    ["config --unset user.name", "config.unset", "write"], ["config --unset-all user.name", "config.unset-all", "write"],
    ["notes add -m x", "notes.add", "write"], ["notes remove HEAD", "notes.remove", "write"],
    ["replace old new", "replace.create", "high-risk"], ["replace -d old", "replace.delete", "high-risk"],
    ["replace -e old", "replace.edit", "high-risk"], ["replace --graft old parent", "replace.graft", "high-risk"],
    ["update-ref refs/heads/x HEAD", "update-ref.write", "high-risk"], ["update-ref -d refs/heads/x", "update-ref.delete", "high-risk"],
    ["symbolic-ref HEAD refs/heads/main", "symbolic-ref.write", "high-risk"], ["symbolic-ref --delete HEAD", "symbolic-ref.delete", "high-risk"],
    ["reflog delete HEAD@{0}", "reflog.delete", "high-risk"], ["reflog expire --all", "reflog.expire", "high-risk"],
    ["reflog drop refs/heads/x", "reflog.drop", "high-risk"], ["filter-branch --force -- --all", "filter-branch.rewrite", "high-risk"],
    ["add .", "add.write", "write"], ["fetch origin", "fetch.write", "write"], ["pull origin main", "pull.write", "write"],
    ["merge topic", "merge.start", "write"]
  ];
  for (const [command, action, risk] of cases) {
    const items = evaluateGitCommand(`git ${command}`, "posix");
    assert.equal(items.length, 1, command);
    assert.equal(items[0]?.action, action, command);
    assert.equal(items[0]?.ruleId, `git.${action}`, command);
    assert.equal(items[0]?.risk, risk, command);
  }
});

test("Git syntax consumes option values, preserves case, and respects --", () => {
  const cases: readonly [string, string][] = [
    ["git commit -m --amend", "commit.create"], ["git commit -am--amend", "commit.create"],
    ["git commit --message=--amend", "commit.create"], ["git commit -C --amend", "commit.create"],
    ["git commit -c --amend", "commit.create"], ["git commit --squash --amend", "commit.create"],
    ["git commit -- --amend", "commit.create"], ["git commit -m 'use --force'", "commit.create"],
    ["git reset -- --hard", "reset.update"], ["git push origin -- --force", "push.update"],
    ["git push -o --force origin main", "push.update"], ["git push --receive-pack=--force origin main", "push.update"],
    ["git branch -c old new", "branch.copy"], ["git branch -C old new", "branch.force-copy"],
    ["git branch -m old new", "branch.rename"], ["git branch -M old new", "branch.force-rename"],
    ["git branch --list --delete topic", "branch.delete"], ["git tag --list --delete v1", "tag.delete"],
    ["git tag -m --force v1", "tag.create"], ["git clean -e --dry-run -f", "clean.remove"],
    ["git restore --source --staged file", "restore.worktree"],
    ["git notes --ref --force add -m x", "notes.add"], ["git symbolic-ref -m --delete HEAD refs/heads/main", "symbolic-ref.write"]
  ];
  for (const [command, action] of cases) assert.equal(evaluateGitCommand(command, "posix")[0]?.action, action, command);
  assert.deepEqual(evaluateGitCommand("GIT.EXE branch --show-current", "powershell"), []);
  assert.deepEqual(evaluateGitCommand("git COMMIT -m x", "powershell"), []);
  assert.deepEqual(evaluateGitCommand("GIT commit -m x", "posix"), []);
  assert.equal(evaluateGitCommand("git commit --AMEND", "powershell")[0]?.risk, "write");
  assert.equal(evaluateGitCommand("git commit --AMEND", "powershell")[0]?.reusable, false);
  assert.deepEqual(evaluateGitCommand("git branch --list --format --delete topic", "posix"), []);
  assert.deepEqual(evaluateGitCommand("git branch --contains --delete topic", "posix"), []);
  assert.equal(evaluateGitCommand("git switch -b topic", "posix")[0]?.reusable, false);
  assert.equal(evaluateGitCommand("git checkout -C topic", "posix")[0]?.reusable, false);
});

test("only supported help and dry-run forms suppress writes", () => {
  for (const command of [
    "git clean -nfdx", "git clean --dry-run", "git commit --dry-run --amend", "git push -nf origin main",
    "git worktree prune --dry-run", "git remote prune -n origin", "git notes prune --dry-run",
    "git reflog expire --dry-run --all", "git reflog delete -n HEAD@{0}", "git add --dry-run .",
    "git rm -n file", "git mv -n a b", "git fetch --dry-run", "git pull --dry-run", "git apply --check patch",
    "git commit --help", "git branch -h", "git filter-branch -h"
  ]) assert.deepEqual(evaluateGitCommand(command, "posix"), [], command);
  for (const command of ["git reset --dry-run --hard", "git branch --dry-run -D topic", "git fetch -n", "git apply --stat --apply patch", "git rebase -n main",
    "git clean -n --no-dry-run -f", "git push --dry-run --no-dry-run --force origin main", "git commit --dry-run --no-dry-run -m x"
  ]) {
    assert.ok(evaluateGitCommand(command, "posix").length > 0, command);
  }
  assert.deepEqual(evaluateGitCommand("git clean --no-dry-run -nf", "posix"), []);
  assert.equal(evaluateGitCommand("git push -f --no-force origin main", "posix")[0]?.action, "push.update");
  assert.equal(evaluateGitCommand("git push --force-with-lease --no-force-with-lease origin main", "posix")[0]?.action, "push.update");
  assert.equal(evaluateGitCommand("git push --no-force -f origin main", "posix")[0]?.action, "push.force");
});

test("compound evaluation retains every action and force semantic, deduplicating only matching contexts", () => {
  assert.deepEqual(evaluateGitCommand("git add .; git reset --hard HEAD", "powershell").map(({ ruleId, risk }) => [ruleId, risk]), [
    ["git.add.write", "write"], ["git.reset.hard", "high-risk"]
  ]);
  assert.deepEqual(evaluateGitCommand("git commit -m x; git push --force origin main", "powershell").map((item) => item.ruleId), ["git.commit.create", "git.push.force"]);
  assert.deepEqual(evaluateGitCommand("git push --force --force-with-lease --force-if-includes --mirror --delete origin main", "posix").map((item) => item.action), [
    "push.force", "push.force-with-lease", "push.force-if-includes", "push.delete", "push.mirror"
  ]);
  const actions = evaluateGitCommand("git -C a commit -m x; git -C a commit -m y; git -C b commit -m z; git -C a commit --amend", "powershell");
  assert.equal(actions.length, 3);
  assert.deepEqual(actions.map((item) => [item.ruleId, item.context.globalOptions]), [
    ["git.commit.create", ["-C", "a"]], ["git.commit.create", ["-C", "b"]], ["git.commit.amend", ["-C", "a"]]
  ]);
});

test("static context supports parameter reuse but cannot authorize unknown or dynamic syntax", () => {
  const first = evaluateGitCommand("CI=true env -C repo git -C src --git-dir=.git --work-tree=. commit -m first", "posix")[0];
  const next = evaluateGitCommand("CI=true env -C repo git -C src --git-dir=.git --work-tree=. commit -m second", "posix")[0];
  assert.equal(first?.reusable, true);
  assert.deepEqual(first, next);
  assert.deepEqual(first?.context, { executable: "git", globalOptions: ["-C", "src", "--git-dir=.git", "--work-tree=."], environment: ["CI=true", "env", "-C", "repo"] });
  for (const command of [
    "git branch --future-option", "git remote future", "git stash future", "git tag --future-option", "git worktree future", "git submodule future",
    "git -C $repo commit -m x", "git -C re* commit -m x", "git commit -m \"$message\"", "git --unknown commit -m x",
    "git --config-env=core.worktree=DIR commit -m x", "env -S 'git commit -m x'", "env --file=NUL git commit -m x",
    "cd other; git commit -m x", "git commit -m x > out", "git update-ref --stdin", "git checkout topic",
    "git submodule foreach 'git status'", "git rebase -x 'echo ok' main", "git filter-branch --tree-filter 'echo ok'",
    "git push --receive-pack=backend origin main", "git config --file settings user.name Alice", "git config --global user.name Alice"
  ]) {
    const actions = evaluateGitCommand(command, "posix");
    assert.ok(actions.length > 0, command);
    assert.ok(actions.every((item) => !item.reusable), command);
  }
  assert.equal(evaluateGitCommand("git branch topic", "posix")[0]?.reusable, true);
  assert.equal(evaluateGitCommand("git branch -D topic", "posix")[0]?.reusable, true);
  assert.equal(evaluateGitCommand("git add .; git reset --hard HEAD", "powershell")[1]?.reusable, true);
  assert.equal(evaluateGitCommand("$env:GIT_DIR = 'other'; git commit -m x", "powershell")[0]?.reusable, false);
});

test("unmodeled POSIX tilde and escape semantics cannot yield reusable Git context", () => {
  for (const command of [
    "git -C ~ commit -m x", 'git -C "~" commit -m y',
    String.raw`git -C "a\q" commit -m x`, String.raw`git -C a\q commit -m x`
  ]) {
    const [action] = evaluateGitCommand(command, "posix");
    assert.equal(action?.ruleId, "git.commit.create", command);
    assert.equal(action?.risk, "write", command);
    assert.equal(action?.reusable, false, command);
  }
  assert.equal(evaluateGitCommand('git -C "aq" commit -m y', "posix")[0]?.reusable, true);
  assert.equal(evaluateGitCommand(String.raw`git -C "a\q" commit -m x`, "powershell")[0]?.reusable, true);
});

test("PowerShell doubled single quotes preserve distinct reusable Git targets", () => {
  const actions = evaluateGitCommand("git -C 'a''b' commit -m x; git -C ab commit -m y", "powershell");
  assert.equal(actions.length, 2);
  assert.deepEqual(actions.map(({ ruleId, risk, reusable, context }) => ({ ruleId, risk, reusable, options: context.globalOptions })), [
    { ruleId: "git.commit.create", risk: "write", reusable: true, options: ["-C", "a'b"] },
    { ruleId: "git.commit.create", risk: "write", reusable: true, options: ["-C", "ab"] }
  ]);
  assert.deepEqual(parseShellCommand("git -C 'a''b' commit -m x", "posix")[0]?.words, ["git", "-C", "ab", "commit", "-m", "x"]);
});

test("checkout distinguishes path sources from an empty -- boundary", () => {
  const cases: readonly [string, string, "write" | "high-risk"][] = [
    ["--pathspec-from-file=paths.txt", "checkout.discard", "high-risk"],
    ["HEAD --pathspec-from-file=paths.txt", "checkout.discard", "high-risk"],
    ["--pathspec-from-file paths.txt --pathspec-file-nul", "checkout.discard", "high-risk"],
    ["HEAD --pathspec-from-file paths.txt --", "checkout.discard", "high-risk"],
    ["main --", "checkout.switch", "write"],
    ["-b topic --", "checkout.create", "write"],
    ["main -- file.txt", "checkout.discard", "high-risk"],
    ["-- file.txt", "checkout.discard", "high-risk"],
    ["main", "checkout.unknown", "write"]
  ];
  for (const [args, action, risk] of cases) {
    const command = `git checkout ${args}`;
    const [item] = evaluateGitCommand(command, "posix");
    assert.equal(item?.ruleId, `git.${action}`, command);
    assert.equal(item?.risk, risk, command);
  }
  assert.equal(evaluateGitCommand("git checkout main --", "posix")[0]?.reusable, false);
  assert.equal(evaluateGitCommand("git checkout main", "posix")[0]?.reusable, false);
});

test("switch force and discard-changes aliases honor the last boolean setting", () => {
  for (const options of ["--discard-changes --no-force", "-f --no-discard-changes", "--force --no-discard-changes", "--no-force --discard-changes --no-discard-changes"]) {
    const [action] = evaluateGitCommand(`git switch ${options} main`, "posix");
    assert.equal(action?.ruleId, "git.switch.switch", options);
    assert.equal(action?.risk, "write", options);
    assert.equal(action?.reusable, true, options);
  }
  for (const options of ["--no-force --discard-changes", "--no-discard-changes -f", "--discard-changes --no-force -qf"]) {
    const [action] = evaluateGitCommand(`git switch ${options} main`, "posix");
    assert.equal(action?.ruleId, "git.switch.discard", options);
    assert.equal(action?.risk, "high-risk", options);
    assert.equal(action?.reusable, true, options);
  }
});

test("classifyShellDialectViolation recognizes only executable syntax", () => {
  const cases: readonly [string, "posix" | "powershell", string | undefined][] = [
    ["  ExPoRt CI=true; pnpm test", "powershell", "powershell-export"],
    ["Write-Output ok\nSoUrCe ./env.ps1", "powershell", "powershell-source"],
    ["pnpm test > /dev/null", "powershell", "powershell-dev-null"],
    ["$env:CI = 'true'; pnpm test", "posix", "posix-powershell-env"],
    ["Write-Output 'export CI=true source ./env > /dev/null'", "powershell", undefined],
    ["printf '%s' '$env:CI = true'", "posix", undefined]
  ];

  for (const [command, dialect, violation] of cases) {
    assert.equal(classifyShellDialectViolation(command, dialect), violation, command);
  }
});
