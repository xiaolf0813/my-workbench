// Frameless-window controls (SPEC §2, §3.18): an integrated floating cluster fixed
// to the window's top-right corner, rendered OVER the page header area. There is no
// dedicated title-bar strip — the controls consume no layout height and sit directly
// on the page surface. Dragging does not live here: the sidebar brand row and the
// three page-header containers carry data-tauri-drag-region="deep" (SPEC §2), so the
// whole row surface drags the window while buttons and inputs stay interactive.
//
// Degradation (SPEC §3.18): without Tauri IPC (plain `vite dev` in a browser) the
// component renders NOTHING — no dead controls, clean tab order. Window APIs are
// imported directly from @tauri-apps/api/window.
import { useEffect, useState } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { isTauriAvailable } from "../lib/ipc";

/** Hairline window glyphs on the sprite's 24-grid (icons.tsx conventions);
 *  geometry synced 1:1 with the mockup sprite (i-wmin/i-wmax/i-wrestore/i-wclose). */
function MinimizeGlyph() {
  return (
    <svg className="ic" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <line x1="5.5" y1="12" x2="18.5" y2="12" />
    </svg>
  );
}

function MaximizeGlyph() {
  return (
    <svg className="ic" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <rect x="6.3" y="6.3" width="11.4" height="11.4" rx="2.4" />
    </svg>
  );
}

function RestoreGlyph() {
  return (
    <svg className="ic" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <path d="M8.6 8.6V5.9h9.5v9.5h-2.7" />
      <rect x="5.9" y="8.6" width="9.5" height="9.5" rx="2" />
    </svg>
  );
}

function CloseGlyph() {
  return (
    <svg className="ic" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <path d="m6.8 6.8 10.4 10.4M17.2 6.8 6.8 17.2" />
    </svg>
  );
}

export default function TitleBar() {
  const [maximized, setMaximized] = useState(false);

  useEffect(() => {
    if (!isTauriAvailable()) return;
    const win = getCurrentWindow();
    let disposed = false;
    let unlisten: (() => void) | null = null;
    // Initial state, then re-check on every resize (maximize/restore both resize).
    void win
      .isMaximized()
      .then((m) => {
        if (!disposed) setMaximized(m);
      })
      .catch(() => undefined);
    void win
      .onResized(() => {
        void win
          .isMaximized()
          .then((m) => {
            if (!disposed) setMaximized(m);
          })
          .catch(() => undefined);
      })
      .then((u) => {
        if (disposed) u();
        else unlisten = u;
      })
      .catch(() => undefined);
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, []);

  const tauri = isTauriAvailable();

  // Controls are rendered only under Tauri; the guards inside the handlers keep
  // a permission denial or lost backend from ever crashing the UI.
  if (!tauri) return null;

  const onMinimize = () => {
    if (!isTauriAvailable()) return;
    void getCurrentWindow().minimize().catch(() => undefined);
  };
  const onToggleMaximize = () => {
    if (!isTauriAvailable()) return;
    void getCurrentWindow().toggleMaximize().catch(() => undefined);
  };
  const onClose = () => {
    if (!isTauriAvailable()) return;
    void getCurrentWindow().close().catch(() => undefined);
  };

  return (
    <div className="win-ctl">
      <button type="button" className="win-btn" aria-label="最小化" onClick={onMinimize}>
        <MinimizeGlyph />
      </button>
      <button
        type="button"
        className="win-btn"
        aria-label={maximized ? "还原" : "最大化"}
        onClick={onToggleMaximize}
      >
        {maximized ? <RestoreGlyph /> : <MaximizeGlyph />}
      </button>
      <button type="button" className="win-btn win-close" aria-label="关闭" onClick={onClose}>
        <CloseGlyph />
      </button>
    </div>
  );
}
