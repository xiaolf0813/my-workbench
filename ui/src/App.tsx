// App shell (SPEC §2): flat sidebar+main layout — no dedicated title-bar strip. The
// frameless window's controls (TitleBar) are a fixed cluster floating over the top-right
// corner; the sidebar brand row and each page header carry data-tauri-drag-region, so
// their empty background areas drag the window. 232px sidebar — brand, nav (部署/技能/
// 设置, aria-current), footer environment card + side-note — and main. Pages stay
// mounted (mockup behavior) so in-flight install/preview state survives nav.
import { useCallback, useEffect, useState } from "react";
import { DeployPage, type EnvStatus } from "./pages/DeployPage";
import { SkillsPage } from "./pages/SkillsPage";
import { SettingsPage } from "./pages/SettingsPage";
import { ToastProvider } from "./components/Toast";
import TitleBar from "./components/TitleBar";
import { Icon, type IconName } from "./icons";
import { detectEnvironment, getAppVersion, describeIpcError, type EnvironmentInfo } from "./lib/ipc";
import { bundledVersionLabel, dshEnvLabel, versionLabel } from "./pages/deploy/logic";

type PageId = "deploy" | "skills" | "settings";

const NAV: { id: PageId; label: string; icon: IconName }[] = [
  { id: "deploy", label: "部署", icon: "deploy" },
  { id: "skills", label: "技能", icon: "skills" },
  { id: "settings", label: "设置", icon: "set" },
];

export default function App() {
  const [page, setPage] = useState<PageId>("deploy");

  const [env, setEnv] = useState<EnvironmentInfo | null>(null);
  const [envStatus, setEnvStatus] = useState<EnvStatus>("loading");
  const [envError, setEnvError] = useState<string | null>(null);
  const [appVersion, setAppVersion] = useState<string | null>(null);
  /** Sidebar 技能 meta: installed-skills count; null = unknown (backend down / not loaded yet). */
  const [skillsCount, setSkillsCount] = useState<number | null>(null);

  const handleInstalledCount = useCallback((n: number | null) => setSkillsCount(n), []);
  const goToSettings = useCallback(() => setPage("settings"), []);

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

  const nodeStatus = env?.node ?? null;
  const opencodeStatus = env?.opencode ?? null;

  return (
    <ToastProvider>
      <TitleBar />
      <div className="app">
        <aside className="sidebar">
          <div className="brand" data-tauri-drag-region>
            <div className="brand-tile">
              <Icon name="term" />
            </div>
            <div>
              <div className="brand-name">My Workbench</div>
              <div className="brand-sub">部署 · 技能 · 设置</div>
            </div>
          </div>
          <nav className="nav" aria-label="主导航">
            {NAV.map((item) => (
              <button
                key={item.id}
                type="button"
                className={`nav-item${page === item.id ? " is-active" : ""}`}
                aria-current={page === item.id ? "page" : undefined}
                onClick={() => setPage(item.id)}
              >
                <Icon name={item.icon} />
                {item.label}
                {item.id === "skills" && skillsCount !== null && <span className="nv-s num">{skillsCount}</span>}
              </button>
            ))}
          </nav>
          <div className="side-foot">
            <div className="env-card" title="环境状态在启动与手动刷新时更新">
              <div className="env-row">
                <span className="dot acc" />
                内置源
                <span className="mono">{bundledVersionLabel(env, appVersion)}</span>
              </div>
              <div className="env-row">
                <span className={nodeStatus?.present ? "dot ok" : "dot off"} />
                Node
                <span className="mono">
                  {nodeStatus?.present ? versionLabel(nodeStatus.version) || "已检测到" : "未检测到"}
                </span>
              </div>
              <div className="env-row">
                <span className={opencodeStatus?.present ? "dot ok" : "dot off"} />
                opencode
                <span className="mono">
                  {opencodeStatus?.present ? versionLabel(opencodeStatus.version) || "已检测到" : "未检测到"}
                </span>
              </div>
              <div className="env-row">
                <span className={env ? (env.dsh.exists ? "dot ok" : "dot off") : "dot off"} />
                dsh profile
                <span className="mono">{env ? dshEnvLabel(env.dsh) : "—"}</span>
              </div>
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
            />
          </section>
          <section className={`page${page === "skills" ? " is-active" : ""}`}>
            <SkillsPage goToSettings={goToSettings} onInstalledCount={handleInstalledCount} />
          </section>
          <section className={`page${page === "settings" ? " is-active" : ""}`}>
            <SettingsPage
              envHome={env?.home ?? null}
              envSourceVersion={env?.sourceVersion ?? null}
              appVersion={appVersion}
            />
          </section>
        </main>
      </div>
    </ToastProvider>
  );
}
