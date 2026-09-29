// Dialog shell — 520px default (640 for diff), radius 12, shadow-3,
// backdrop blur-fade + panel rise; Esc and backdrop click close; focus moves
// in on open and returns to the invoker on close (SPEC §3.13).
import { useEffect, useRef, type ReactNode } from "react";
import { Icon, type IconName } from "../icons";

export type DialogIconKind = "info" | "warn" | "err";

interface DialogProps {
  open: boolean;
  onClose: () => void;
  title: string;
  icon: IconName;
  iconKind?: DialogIconKind;
  /** px width override (e.g. 640 for the drift diff dialog). */
  width?: number;
  children: ReactNode;
  footer?: ReactNode;
}

export function Dialog({ open, onClose, title, icon, iconKind = "info", width, children, footer }: DialogProps) {
  const panelRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!open) return;
    const prev = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const timer = window.setTimeout(() => {
      const first = panelRef.current?.querySelector<HTMLElement>("input, select, textarea, button");
      first?.focus();
    }, 30);
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => {
      window.clearTimeout(timer);
      document.removeEventListener("keydown", onKey);
      prev?.focus();
    };
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div
      className="oback is-open"
      role="dialog"
      aria-modal="true"
      aria-label={title}
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="dlg" style={width ? { width } : undefined} ref={panelRef}>
        <div className="dlg-h">
          <div className={`dlg-ic ${iconKind}`}>
            <Icon name={icon} />
          </div>
          <div className="dlg-t">{title}</div>
          <button type="button" className="icon-btn dlg-x" onClick={onClose} aria-label="关闭">
            <Icon name="x" />
          </button>
        </div>
        <div className="dlg-b">{children}</div>
        {footer ? <div className="dlg-f">{footer}</div> : null}
      </div>
    </div>
  );
}
