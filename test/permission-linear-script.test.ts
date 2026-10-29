import assert from "node:assert/strict";
import { test } from "node:test";
import { parseLinearScript } from "../src/permission-linear-script.ts";

test("linear scripts preserve raw ranges and literal words across separators and dialects", () => {
  for (const dialect of ["posix", "powershell"] as const) {
    const command = '\r\n  echo "a;|&&" \'\' 中文 \t;\r\nother one &&\n third || fourth | fifth;\n';
    const parts = parseLinearScript(command, dialect)!;
    assert.deepEqual(parts.map(part => part.words), [["echo", "a;|&&", "", "中文"], ["other", "one"], ["third"], ["fourth"], ["fifth"]]);
    assert.deepEqual(parts.map(part => part.command), ['echo "a;|&&" \'\' 中文', "other one", "third", "fourth", "fifth"]);
    for (const part of parts) assert.equal(command.slice(part.start, part.end), part.command);
    assert.ok(Object.isFrozen(parts)); assert.ok(parts.every(Object.isFrozen));
  }
  assert.deepEqual(parseLinearScript('echo a"b"; other', "posix")?.[0].words, ["echo", "ab"]);
  assert.equal(parseLinearScript('echo a"b"; other', "powershell"), undefined);
  assert.deepEqual(parseLinearScript("echo 'it''s'; other", "powershell")?.[0].words, ["echo", "it's"]);
});

test("only supported unquoted continuations affect the parsing view, not the raw component", () => {
  for (const [dialect, escape] of [["posix", "\\\n"], ["powershell", "`\n"], ["powershell", "`\r\n"]] as const) {
    const prefix = dialect === "posix" ? `git com${escape}mit` : `git ${escape}commit`;
    const command = `${prefix} -m owned; echo done`;
    const parts = parseLinearScript(command, dialect)!;
    assert.deepEqual(parts[0].words, ["git", "commit", "-m", "owned"]);
    assert.equal(parts[0].command, `${prefix} -m owned`);
    assert.deepEqual(parseLinearScript(`echo ${escape}one`, dialect)?.[0].words, ["echo", "one"]);
  }
  assert.equal(parseLinearScript("echo one\\\r\nother", "posix"), undefined);
  assert.equal(parseLinearScript("echo 'one\\\ntwo'; other", "posix"), undefined);
  assert.equal(parseLinearScript("echo 'one`\ntwo'; other", "powershell"), undefined);
  for (const newline of ["\n", "\r\n"]) {
    assert.equal(parseLinearScript(`git com\`${newline}mit; echo done`, "powershell"), undefined);
    assert.equal(parseLinearScript(`echo ok\`${newline}git push`, "powershell"), undefined);
  }
});

test("unsupported or incomplete scripts fail completely instead of returning an accepted prefix", () => {
  const rejected = ["", " \t\r\n", "echo one", "echo one;; other", "echo one; ; other", "echo one &&", "echo one |\n", "|| other", "echo one\n| other",
    "echo one & other", "echo one > out; other", "echo one < in; other", "echo one # comment\nother", "echo one; if true; then other; fi",
    "echo one; (other)", "echo one; { other; }", "echo one; fn() { other; }", "echo one; echo $HOME", 'echo one; echo "$HOME"',
    "echo one; echo $(other)", "echo one; echo *.ts", "echo one; echo [ab]", "echo one; echo `other`", "echo one; echo --% x",
    "echo one; echo 'open", "echo one; echo \u2018quoted\u2019", "echo one; X=value other", "echo one; X=value", "echo one; . script",
    "echo one; $env:X = 'value'", "echo one; echo @'\nhere\n'@", "echo one; echo <<EOF\nbody\nEOF", "\u00a0\necho one", "echo one;\u0000"];
  for (const dialect of ["posix", "powershell"] as const) for (const command of rejected)
    assert.equal(parseLinearScript(command, dialect), undefined, JSON.stringify({ dialect, command }));
  assert.equal(parseLinearScript("echo a\\ b; other", "posix"), undefined);
  assert.equal(parseLinearScript("echo a` b; other", "powershell"), undefined);
  assert.equal(parseLinearScript("echo one; & other", "powershell"), undefined);
  for (const dialect of ["posix", "powershell"] as const) {
    assert.deepEqual(parseLinearScript("env X=value git push; node -e 'code'; bash -c 'git push'", dialect)?.map(part => part.words[0]), ["env", "node", "bash"]);
  }
});
