// Area 3 — 设置 (SPEC §6): 通用 (disabled M3 controls), 关于 (app version,
// 内置 agents 源版本 + npm consistency chip, repo link, updater placeholder).
// Same degradation idiom as the deploy page.
import { Icon } from "../icons";

export interface SettingsPageProps {
  /** Bundled source version from the app shell — feeds 关于. */
  envSourceVersion: string | null;
  appVersion: string | null;
}

const REPO_URL = "https://github.com/xiaolf0813/my-workbench";
const REPO_LABEL = "github.com/xiaolf0813/my-workbench";

export function SettingsPage({ envSourceVersion, appVersion }: SettingsPageProps) {
  /* ---------------- 关于 derivation ---------------- */
  const agentsVersion = (envSourceVersion ?? "").trim();
  const appV = (appVersion ?? "").trim();
  const versionsKnown = agentsVersion !== "" && appV !== "";
  const versionsMatch = versionsKnown && agentsVersion === appV;

  return (
    <>
      <header className="page-head" data-tauri-drag-region="deep">
        <div>
          <h1 className="ph-title">设置</h1>
          <p className="ph-sub">通用设置与应用信息</p>
        </div>
      </header>
      <div className="page-body">
        <div className="set-wrap">
          {/* ---------------- 通用 ---------------- */}
          <div className="card">
            <div className="card-h">
              <span className="card-t">通用</span>
            </div>
            <div className="set-row">
              <div className="set-l">
                <div className="set-lt">界面语言</div>
              </div>
              <div className="set-c">
                <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
                  <select className="fsel" style={{ width: 180 }} disabled value="zh" aria-label="界面语言">
                    <option value="zh">中文（简体）</option>
                    <option value="en">English（计划于 M3）</option>
                  </select>
                </div>
                <div className="fhint">
                  <Icon name="info" />
                  英文界面计划于 M3（i18n）提供。
                </div>
              </div>
            </div>
            <div className="set-row">
              <div className="set-l">
                <div className="set-lt">日志导出</div>
              </div>
              <div className="set-c">
                <div>
                  <button type="button" className="btn btn-sm" disabled title="计划于 M3 提供">
                    导出安装日志…
                  </button>
                </div>
                <div className="fhint">
                  <Icon name="info" />
                  计划于 M3 提供。
                </div>
              </div>
            </div>
          </div>

          {/* ---------------- 关于 ---------------- */}
          <div className="card">
            <div className="card-h">
              <span className="card-t">关于</span>
            </div>
            <div className="set-row">
              <div className="set-l">
                <div className="set-lt">应用</div>
              </div>
              <div className="set-c">
                <div className="about">
                  <div className="about-tile">
                    <Icon name="mark" />
                  </div>
                  <div>
                    <div className="about-n">My Workbench 桌面版</div>
                    <div className="about-v">
                      版本 <span className="mono">{appV || "—"}</span> (stable) · Tauri 2
                    </div>
                  </div>
                </div>
              </div>
            </div>
            <div className="set-row">
              <div className="set-l">
                <div className="set-lt">内置 agents 源版本</div>
              </div>
              <div className="set-c">
                <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                  <span className="mono" style={{ fontSize: 13 }}>
                    {agentsVersion || "—"}
                  </span>
                  {versionsKnown &&
                    (versionsMatch ? (
                      <span className="vchip ok">与 npm 版本一致</span>
                    ) : (
                      <span className="vchip warn">与 npm 版本不一致</span>
                    ))}
                </div>
                <div className="fhint">
                  <Icon name="info" />
                  若不一致会在此显示警告（
                  <span className="vchip warn" style={{ fontSize: 10 }}>
                    与 npm 版本不一致
                  </span>
                  ），提示重新安装。
                </div>
              </div>
            </div>
            <div className="set-row">
              <div className="set-l">
                <div className="set-lt">源代码仓库</div>
              </div>
              <div className="set-c">
                <a
                  className="link mono link-btn"
                  style={{ fontSize: 12.5 }}
                  href={REPO_URL}
                  target="_blank"
                  rel="noreferrer"
                >
                  {REPO_LABEL}
                  <Icon name="ext" className="link-ic" />
                </a>
              </div>
            </div>
            <div className="set-row">
              <div className="set-l">
                <div className="set-lt">检查更新</div>
              </div>
              <div className="set-c">
                <div>
                  <button type="button" className="btn btn-sm" disabled title="计划于 M3 提供">
                    检查更新…
                  </button>
                </div>
                <div className="fhint">
                  <Icon name="info" />
                  Tauri updater 计划于 M3 提供。
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </>
  );
}
