import { useEffect, useRef, useState } from "react";
import { Button, IconChevronDownOutlineRegular, Input } from "@deepseek-ai/dsh-client-ui-primitives";

export interface EditableChoiceOption { id: string; name: string }
export interface EditableChoiceProps {
  id: string;
  label: string;
  value: string;
  options: readonly EditableChoiceOption[];
  disabled: boolean;
  placeholder?: string;
  onChange(value: string): void;
  onSelect?(value: string): void;
}

/** Suggestions are advisory; the one input always retains the exact typed value. */
export function EditableChoice({ id, label, value, options, disabled, placeholder, onChange, onSelect }: EditableChoiceProps) {
  const input = useRef<HTMLInputElement>(null);
  const [open, setOpen] = useState(false);
  const [activeId, setActiveId] = useState<string | null>(null);
  const distinct = new Map(options.map(option => [option.id, option]));
  if (value !== "" && !distinct.has(value)) distinct.set(value, { id: value, name: value });
  const choices = [...distinct.values()];
  const activeIndex = choices.findIndex(option => option.id === activeId);
  const visible = open && !disabled && choices.length > 0;
  const close = () => { setOpen(false); setActiveId(null); };
  const choose = (next: string) => { if (next !== value) (onSelect ?? onChange)(next); close(); };
  useEffect(() => { if (disabled) close(); }, [disabled]);
  useEffect(() => {
    if (activeId !== null && activeIndex < 0) setActiveId(null);
  }, [activeId, activeIndex]);
  useEffect(() => {
    if (visible && activeIndex >= 0) document.getElementById(`${id}-choice-${activeIndex}`)?.scrollIntoView({ block: "nearest" });
  }, [id, visible, activeIndex]);
  return <div className="dsmm-choice">
    <Input ref={input} id={id} className="dsmm-input" role="combobox" aria-autocomplete="list" aria-expanded={visible}
      aria-controls={visible ? `${id}-choices` : undefined} aria-activedescendant={visible && activeIndex >= 0 ? `${id}-choice-${activeIndex}` : undefined}
      value={value} disabled={disabled} placeholder={placeholder} autoComplete="off" onBlur={close}
      onChange={event => { onChange(event.currentTarget.value); setOpen(true); setActiveId(null); }} onKeyDown={event => {
        if (event.nativeEvent.isComposing) return;
        if ((event.key === "ArrowDown" || event.key === "ArrowUp") && choices.length > 0) {
          event.preventDefault(); event.stopPropagation(); setOpen(true);
          const next = event.key === "ArrowDown" ? !visible || activeIndex < 0 ? 0 : (activeIndex + 1) % choices.length
            : !visible || activeIndex < 0 ? choices.length - 1 : (activeIndex - 1 + choices.length) % choices.length;
          setActiveId(choices[next]!.id);
        } else if (visible && (event.key === "Escape" || event.key === "Enter")) {
          event.preventDefault(); event.stopPropagation();
          if (event.key === "Enter" && activeIndex >= 0) choose(choices[activeIndex]!.id); else close();
        }
      }} />
    <Button type="button" size="sm" variant="toolbar" tabIndex={-1} className="dsmm-choice-toggle" aria-label={label} aria-haspopup="listbox" aria-expanded={visible}
      disabled={disabled || choices.length === 0} icon={<IconChevronDownOutlineRegular />} onMouseDown={event => event.preventDefault()}
      onClick={() => { input.current?.focus(); setOpen(!visible); setActiveId(null); }} />
    {visible && <ul className="dsmm-choice-list" id={`${id}-choices`} role="listbox" aria-label={label}>
      {choices.map((option, index) => <li id={`${id}-choice-${index}`} key={option.id} role="option" data-value={option.id} aria-selected={option.id === activeId}
        onMouseDown={event => event.preventDefault()} onClick={() => choose(option.id)}>{option.name === option.id ? option.id : `${option.name} (${option.id})`}</li>)}
    </ul>}
  </div>;
}
