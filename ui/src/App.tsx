// Frameless window (SPEC §2): flat sidebar+main layout — no dedicated title-bar strip. The
// frameless window's controls (TitleBar) are a fixed cluster floating over the top-right
// corner; the sidebar brand row and each page header carry data-tauri-drag-region="deep", so
// the whole row surface drags the window (Tauri keeps clicks on buttons/inputs interactive).
// The invisible .drag-strip covers the window's top edge — the layout padding above the
// brand row and page headers, the most title-bar-like surface — and drags from there too.
// 232px sidebar — brand, nav (部署/设置, aria-current), footer environment card +
// side-note — and main. Pages stay mounted (mockup behavior) so in-flight install/preview
// state survives nav. Sidebar footer: a bare version line (no card chrome).
import { useCallback, useEffect, useRef, useState } from "react";
import { DeployPage, type EnvStatus } from "./pages/DeployPage";
import { SettingsPage } from "./pages/SettingsPage";
import { ToastProvider } from "./components/Toast";
import TitleBar from "./components/TitleBar";
import { Icon, type IconName } from "./icons";
import { detectEnvironment, getAppVersion, describeIpcError, type EnvironmentInfo } from "./lib/ipc";
import { bundledVersionLabel } from "./pages/deploy/logic";

type PageId = "deploy" | "settings";

const NAV: { id: PageId; label: string; icon: IconName }[] = [
  { id: "deploy", label: "部署", icon: "deploy" },
  { id: "settings", label: "设置", icon: "set" },
];

export default function App() {
  const [page, setPage] = useState<PageId>("deploy");
  /** Deploy page installs its unsaved-changes guard here (notes §5.6): when an
   *  editor is dirty, nav away from 部署 raises the guard dialog instead of
   *  switching; 放弃更改 runs the deferred navigation. */
  const deployNavGuardRef = useRef<((proceed: () => void) => boolean) | null>(null);

  const [env, setEnv] = useState<EnvironmentInfo | null>(null);
  const [envStatus, setEnvStatus] = useState<EnvStatus>("loading");
  const [envError, setEnvError] = useState<string | null>(null);
  const [appVersion, setAppVersion] = useState<string | null>(null);

  const refreshEnv = useCallback(async () => {
    setEnvStatus("loading");
    setEnvError(null);
    try {
      const info = await detectEnvironment();
      setEnv(info);
      setEnvStatus("ready");
    } catch (e) {
      setEnv(null);
      setEnvStatus("error");
      setEnvError(describeIpcError(e).message);
    }
  }, []);

  useEffect(() => {
    void refreshEnv();
  }, [refreshEnv]);

  useEffect(() => {
    void getAppVersion().then(setAppVersion);
  }, []);

  return (
    <ToastProvider>
      <TitleBar />
      <div className="drag-strip" data-tauri-drag-region aria-hidden="true" />
      <div className="app">
        <aside className="sidebar">
          <div className="brand" data-tauri-drag-region="deep">
            <div className="brand-tile">
              <Icon name="mark" />
            </div>
            <div>
              <div className="brand-name">My Workbench</div>
              <div className="brand-sub">部署 · 设置</div>
            </div>
          </div>
          <nav className="nav" aria-label="主导航">
            {NAV.map((item) => (
              <button
                key={item.id}
                type="button"
                className={`nav-item${page === item.id ? " is-active" : ""}`}
                aria-current={page === item.id ? "page" : undefined}
                onClick={() => {
                  if (page === item.id) return;
                  const proceed = () => setPage(item.id);
                  // Leaving 部署 with a dirty editor routes through the guard.
                  if (page === "deploy" && deployNavGuardRef.current && !deployNavGuardRef.current(proceed)) return;
                  proceed();
                }}
              >
                <Icon name={item.icon} />
                {item.label}
              </button>
            ))}
          </nav>
          <div className="side-foot">
            <div className="env-version" title="内置源版本 · 随应用打包">
              {bundledVersionLabel(env, appVersion)}
            </div>
          </div>
        </aside>

        <main className="main">
          <section className={`page${page === "deploy" ? " is-active" : ""}`}>
            <DeployPage
              env={env}
              envStatus={envStatus}
              envError={envError}
              refreshEnv={() => void refreshEnv()}
              appVersion={appVersion}
              navGuardRef={deployNavGuardRef}
            />
          </section>
          <section className={`page${page === "settings" ? " is-active" : ""}`}>
            <SettingsPage
              envSourceVersion={env?.sourceVersion ?? null}
              appVersion={appVersion}
            />
          </section>
        </main>
      </div>
    </ToastProvider>
  );
}
