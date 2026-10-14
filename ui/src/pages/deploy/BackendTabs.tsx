// Backend tab bar (SPEC §3.19): one pill per target, mono machine names,
// selected = filled accent. `role=tablist/tab`, `aria-selected`, `aria-controls`,
// Left/Right arrow navigation; each tab's aria-label/title carries the
// deployment status — `{target}（已部署）` / `{target}（未部署）`. No dot inside
// the pills: the selected target's state renders as dot + word at the bar's
// right end (DeployPage renders that sibling `.dep-status` line).
import { useRef, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { TARGET_ORDER, type Target } from "../../lib/ipc";

export type TabDeploymentStatus = "deployed" | "notDeployed" | "loading" | "error";

interface BackendTabsProps {
  value: Target;
  statusOf: (t: Target) => TabDeploymentStatus;
  /** Selection is guarded upstream (unsaved-changes guard may veto). */
  onSelect: (t: Target) => void;
}

function tabLabel(t: Target, status: TabDeploymentStatus): string {
  if (status === "deployed") return `${t}（已部署）`;
  if (status === "notDeployed") return `${t}（未部署）`;
  return t; // unknown yet (loading / read failure) — no status claim
}

export function BackendTabs({ value, statusOf, onSelect }: BackendTabsProps) {
  const listRef = useRef<HTMLDivElement | null>(null);

  const onKey = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    if (e.key !== "ArrowRight" && e.key !== "ArrowLeft") return;
    e.preventDefault();
    const i = TARGET_ORDER.indexOf(value);
    const next = TARGET_ORDER[(i + (e.key === "ArrowRight" ? 1 : TARGET_ORDER.length - 1)) % TARGET_ORDER.length];
    if (next === value) return;
    onSelect(next);
    // The pill for `next` renders after the state update lands.
    requestAnimationFrame(() => {
      listRef.current?.querySelector<HTMLElement>(`[data-t="${next}"]`)?.focus();
    });
  };

  return (
    <div className="tabs" role="tablist" aria-label="部署目标" ref={listRef} onKeyDown={onKey}>
      {TARGET_ORDER.map((t) => {
        const on = t === value;
        const status = statusOf(t);
        const label = tabLabel(t, status);
        return (
          <button
            key={t}
            type="button"
            data-t={t}
            className={`tb${on ? " is-on" : ""}`}
            role="tab"
            aria-selected={on}
            aria-controls="depMain"
            aria-label={label}
            title={label}
            tabIndex={on ? 0 : -1}
            onClick={() => onSelect(t)}
          >
            {t}
          </button>
        );
      })}
    </div>
  );
}
