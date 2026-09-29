// Switch — 34×20 pill, 16px knob, accent when on; role="switch" + aria-checked
// (SPEC §3.5). The mini variant used in the log bar is styled via the
// `.mini-sw .sw` descendant rules from the mockup.
interface SwitchProps {
  checked: boolean;
  onChange: (next: boolean) => void;
  label: string;
  disabled?: boolean;
}

export function Switch({ checked, onChange, label, disabled }: SwitchProps) {
  return (
    <button
      type="button"
      className="sw"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      onClick={() => onChange(!checked)}
    />
  );
}
