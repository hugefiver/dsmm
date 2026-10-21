import { useId, useSyncExternalStore } from "react";
import { Button, Input } from "@deepseek-ai/dsh-client-ui-primitives";
import { parseNativeCommands } from "../permission-settings.js";
import type { NativeCommandEntry, NativeCommandRule } from "../permission-settings.js";
import type { PermissionLocaleKey } from "./permission-locales.js";
import type { DeploymentController } from "./deployment-controller.js";

type Text = (key: PermissionLocaleKey) => string;
const ENTRIES_PATH = "permissionControl.nativeCommands.entries";

export function validNativeEntries(entries: readonly NativeCommandRule[]): boolean {
  try { parseNativeCommands({ entries }); return true; } catch { return false; }
}

export function emptyNativeEntry(): NativeCommandRule {
  return "";
}

function validNativeRule(rule: unknown): boolean {
  try { parseNativeCommands({ entries: [rule] }); return true; } catch { return false; }
}

function LegacyEntry({ entry, index, disabled, remove, t }: {
  entry: NativeCommandEntry; index: number; disabled: boolean; remove(): void; t: Text;
}) {
  return <div className="dsmm-field dsmm-command-entry dsmm-legacy-entry">
    <div className="dsmm-actions">
      <div className="dsmm-command-summary">
        <span className="dsmm-legacy-badge">{t("legacyEntry")}</span>
        <code>{entry.match.commandPattern || entry.id}</code>
      </div>
      <Button type="button" variant="outline" disabled={disabled} onClick={remove}>
        {t("removeEntry")} {index + 1}
      </Button>
    </div>
    <details className="dsmm-legacy-details">
      <summary>{t("legacyDetails")}: {entry.id}</summary>
      <dl className="dsmm-kv">
        <dt>{t("tool")}</dt><dd>{entry.match.tool}</dd>
        <dt>{t("cwd")}</dt><dd>{entry.match.workingDirectory || "(any)"}</dd>
        <dt>{t("mode")}</dt><dd>{t(`action:${entry.mode}` as PermissionLocaleKey) || entry.mode}</dd>
        <dt>{t("sandboxMode")}</dt><dd>{entry.sandboxMode}</dd>
      </dl>
    </details>
  </div>;
}

function StringEntry({ value, index, controller, disabled, change, remove, t }: {
  value: string; index: number; controller: DeploymentController; disabled: boolean;
  change(value: string): void; remove(): void; t: Text;
}) {
  const id = useId(), row = `${ENTRIES_PATH}.${index}`;
  const state = useSyncExternalStore(controller.subscribe, controller.getSnapshot);
  const raw = state.raw[row];
  const text = raw?.text ?? value;
  const bad = raw?.invalid === true || (raw === undefined && !validNativeRule(value));
  return <div className="dsmm-field dsmm-command-entry">
    <label htmlFor={`${id}-pattern`}>{t("pattern")}</label>
    <div className="dsmm-actions">
      <Input
        className="dsmm-input"
        id={`${id}-pattern`}
        value={text}
        maxLength={32768}
        disabled={disabled}
        required
        aria-invalid={bad}
        aria-describedby={bad ? `${id}-error` : undefined}
        spellCheck={false}
        autoComplete="off"
        onChange={event => {
          const next = event.currentTarget.value;
          const valid = validNativeRule(next);
          controller.setRaw(row, next, !valid);
          change(next);
        }}
      />
      <Button type="button" variant="outline" disabled={disabled} onClick={remove}>
        {t("removeEntry")} {index + 1}
      </Button>
    </div>
    {bad && <p id={`${id}-error`} className="dsmm-hint">{t("invalidPattern")}</p>}
  </div>;
}

export function NativeCommandEntries({ value, inherited, controller, disabled, onChange, setInvalid, t }: {
  value: readonly NativeCommandRule[] | undefined; inherited: readonly NativeCommandRule[]; controller: DeploymentController; disabled: boolean;
  onChange(value: readonly NativeCommandRule[] | undefined): void; setInvalid(path: string, bad: boolean): void; t: Text;
}) {
  const entries = value ?? inherited, name = ENTRIES_PATH;
  const state = useSyncExternalStore(controller.subscribe, controller.getSnapshot);
  const invalidRows = state.invalidFields.filter(path => path === name || path.startsWith(`${name}.`));
  const valid = validNativeEntries(entries) && invalidRows.length === 0;
  const change = (next: readonly NativeCommandRule[] | undefined) => {
    setInvalid(name, !validNativeEntries(next ?? inherited));
    onChange(next);
  };
  const remove = (index: number) => {
    const drafts = Object.entries(state.raw).flatMap(([path, draft]) => {
      if (!path.startsWith(`${name}.`)) return [];
      const remainder = path.slice(name.length + 1);
      const dotIndex = remainder.indexOf(".");
      const row = dotIndex === -1 ? remainder : remainder.slice(0, dotIndex);
      const subPath = dotIndex === -1 ? "" : remainder.slice(dotIndex);
      const position = Number(row);
      if (!Number.isInteger(position) || position === index) return [];
      return [{ path: `${name}.${position > index ? position - 1 : position}${subPath}`, draft }];
    });
    controller.clearRaw(name);
    for (const draft of drafts) controller.setRaw(draft.path, draft.draft.text, draft.draft.invalid);
    change(entries.filter((_, position) => position !== index));
  };
  const add = () => {
    const nextIndex = entries.length;
    controller.setRaw(`${name}.${nextIndex}`, "", true);
    change([...entries, ""]);
  };
  const isGlobal = controller.layer === "global";
  const unsetLabel = isGlobal ? (t("useDefaults") || "Use defaults") : (t("restoreInheritance") || "Restore inheritance");

  return <details className="dsmm-deployment-group">
    <summary>{t("nativeCommands")} <code>{name}</code></summary>
    <div className="dsmm-structured">
      <p className="dsmm-hint">{t("nativeCommandsHint")}</p>
      {!valid && <p className="dsmm-issue" role="alert">{t("invalidEntry")}</p>}
      {entries.length === 0 && <p>{t("noEntries")}</p>}
      {entries.map((entry, index) => typeof entry === "string" ? (
        <StringEntry
          key={index}
          value={entry}
          index={index}
          controller={controller}
          disabled={disabled}
          t={t}
          change={next => change(entries.map((row, position) => position === index ? next : row))}
          remove={() => remove(index)}
        />
      ) : (
        <LegacyEntry
          key={index}
          entry={entry}
          index={index}
          disabled={disabled}
          t={t}
          remove={() => remove(index)}
        />
      ))}
      <div className="dsmm-actions">
        <Button type="button" variant="outline" disabled={disabled || entries.length >= 1024} onClick={add}>
          {t("addEntry")}
        </Button>
        <Button
          type="button"
          variant="outline"
          data-dsmm-unset={name}
          disabled={disabled || (value === undefined && invalidRows.length === 0)}
          onClick={() => { controller.clearRaw(name); change(undefined); }}
        >
          {unsetLabel}
        </Button>
      </div>
    </div>
  </details>;
}
