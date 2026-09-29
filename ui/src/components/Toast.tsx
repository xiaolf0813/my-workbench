// Toast stack — bottom-right, 3.8s auto-dismiss, max 3, newest at bottom
// (SPEC §3.14). Container is aria-live="polite".
import { createContext, useCallback, useContext, useRef, useState, type ReactNode } from "react";
import { Icon, type IconName } from "../icons";

export type ToastKind = "ok" | "err" | "warn" | "info";

interface ToastItem {
  id: number;
  kind: ToastKind;
  title: string;
  sub?: string;
}

export interface ToastInput {
  kind: ToastKind;
  title: string;
  sub?: string;
}

const ToastContext = createContext<(t: ToastInput) => void>(() => undefined);

export function useToast() {
  return useContext(ToastContext);
}

const KIND_ICON: Record<ToastKind, IconName> = { ok: "checkc", err: "xc", warn: "warn", info: "info" };

export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<ToastItem[]>([]);
  const nextId = useRef(1);

  const push = useCallback((t: ToastInput) => {
    const id = nextId.current++;
    setItems((prev) => [...prev, { id, ...t }].slice(-3));
    window.setTimeout(() => {
      setItems((prev) => prev.filter((x) => x.id !== id));
    }, 3800);
  }, []);

  return (
    <ToastContext.Provider value={push}>
      {children}
      <div className="toasts" aria-live="polite">
        {items.map((t) => (
          <div key={t.id} className={`toast ${t.kind}`}>
            <Icon name={KIND_ICON[t.kind]} />
            <div>
              {t.title}
              {t.sub ? <span className="tsub">{t.sub}</span> : null}
            </div>
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}
