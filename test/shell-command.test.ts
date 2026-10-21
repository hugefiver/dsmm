import assert from "node:assert/strict";
import { test } from "node:test";
import { classifyKnownGitWrite, classifyShellDialectViolation, parseShellCommand } from "../lib/shell-command.js";

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
