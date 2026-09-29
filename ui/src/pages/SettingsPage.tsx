// Area 3 — 设置 (SPEC §6): 技能存储 (skills root + manifest hint), GitHub 访问
// (PAT via the OS keyring — the token value never round-trips), 通用 (disabled
// M3 controls), 关于 (app version, 内置 agents 源版本 + npm consistency chip,
// repo link, updater placeholder). settings and PAT status on mount; explicit
// 保存 per card. Same degradation idiom as the deploy page.
import { useCallback, useEffect, useState } from "react";
import { useToast } from "../components/Toast";
import { Icon } from "../icons";
import {
  describeIpcError,
  isTauriAvailable,
  patClear,
  patSet,
  patStatus,
  pickDirectory,
  settingsGet,
  settingsSet,
  type AppSettings,
  type IpcFailure,
  type PatStatus,
} from "../lib/ipc";

export interface SettingsPageProps {
  /** Environment home from the app shell — feeds 恢复默认; sourceVersion feeds 关于. */
  envHome: string | null;
  envSourceVersion: string | null;
  appVersion: string | null;
}

const REPO_URL = "https://github.com/xiaolf0813/my-workbench";
const REPO_LABEL = "github.com/xiaolf0813/my-workbench";

export function SettingsPage({ envHome, envSourceVersion, appVersion }: SettingsPageProps) {
  const toast = useToast();

  /* ---------------- 技能存储 ---------------- */
  const [rootInput, setRootInput] = useState("~\\.agents\\skills\\");
  const [settings, setSettings] = useState<AppSettings | null>(null);
  const [settingsError, setSettingsError] = useState<IpcFailure | null>(null);
  const [savingRoot, setSavingRoot] = useState(false);

  /* ---------------- GitHub 访问 ---------------- */
  const [pat, setPat] = useState<PatStatus | null>(null);
  const [patError, setPatError] = useState<IpcFailure | null>(null);
  const [patEditing, setPatEditing] = useState(false);
  const [token, setToken] = useState("");
  const [patSaving, setPatSaving] = useState(false);

  const configured = pat?.configured === true;

  /* ---------------- load on mount ---------------- */
  useEffect(() => {
    void (async () => {
      try {
        const s = await settingsGet();
        setSettings(s);
        setRootInput(s.skillsRoot || "~\\.agents\\skills\\");
      } catch (e) {
        setSettingsError(describeIpcError(e));
      }
    })();
    void (async () => {
      try {
        setPat(await patStatus());
      } catch (e) {
        setPatError(describeIpcError(e));
      }
    })();
  }, []);

  /* ---------------- 技能存储 handlers ---------------- */
  const browseRoot = useCallback(async () => {
    const picked = await pickDirectory("选择技能根目录");
    if (picked) {
      setRootInput(picked);
      return;
    }
    if (!isTauriAvailable()) {
      toast({ kind: "info", title: "浏览器预览模式", sub: "系统目录选择器不可用 — 请直接在输入框中填写路径" });
    }
  }, [toast]);

  /** 恢复默认: the real home reported by the backend, else the ~ literal. */
  const restoreDefaultRoot = useCallback(() => {
    setRootInput(envHome ? `${envHome}\\.agents\\skills` : "~\\.agents\\skills\\");
  }, [envHome]);

  const saveRoot = useCallback(async () => {
    setSavingRoot(true);
    try {
      const normalized = await settingsSet({
        skillsRoot: rootInput,
        language: settings?.language ?? "zh",
      });
      setSettings(normalized);
      setRootInput(normalized.skillsRoot || rootInput);
      toast({ kind: "ok", title: "已保存", sub: `技能根目录 ${normalized.skillsRoot}` });
    } catch (e) {
      toast({ kind: "err", title: "保存失败", sub: describeIpcError(e).message });
    } finally {
      setSavingRoot(false);
    }
  }, [rootInput, settings, toast]);

  /* ---------------- GitHub 访问 handlers ---------------- */
  const refreshPat = useCallback(async () => {
    try {
      setPat(await patStatus());
      setPatError(null);
    } catch (e) {
      setPatError(describeIpcError(e));
    }
  }, []);

  const savePat = useCallback(async () => {
    if (token.trim() === "") return;
    setPatSaving(true);
    try {
      await patSet(token);
      // The token value never lives in state past the save.
      setToken("");
      setPatEditing(false);
      await refreshPat();
      toast({ kind: "ok", title: "PAT 已保存", sub: "已存入系统钥匙串" });
    } catch (e) {
      toast({ kind: "err", title: "保存失败", sub: describeIpcError(e).message });
    } finally {
      setPatSaving(false);
    }
  }, [token, refreshPat, toast]);

  const clearPat = useCallback(async () => {
    setPatSaving(true);
    try {
      await patClear();
      setToken("");
      setPatEditing(false);
      await refreshPat();
      toast({ kind: "ok", title: "PAT 已清除", sub: "已从系统钥匙串移除" });
    } catch (e) {
      toast({ kind: "err", title: "清除失败", sub: describeIpcError(e).message });
    } finally {
      setPatSaving(false);
    }
  }, [refreshPat, toast]);

  /* ---------------- 关于 derivation ---------------- */
  const agentsVersion = (envSourceVersion ?? "").trim();
  const appV = (appVersion ?? "").trim();
  const versionsKnown = agentsVersion !== "" && appV !== "";
  const versionsMatch = versionsKnown && agentsVersion === appV;

  const patTokenInput = (
    <input
      type="password"
      className="fld-in mono pat-in"
      placeholder={patEditing ? "输入新令牌以更新" : "ghp_… 或 40 位十六进制"}
      value={token}
      spellCheck={false}
      autoComplete="off"
      aria-label="GitHub PAT"
      onChange={(e) => setToken(e.target.value)}
      onKeyDown={(e) => {
        if (e.key === "Enter") void savePat();
      }}
    />
  );

  const scopeHint = (
    <div className="fhint">
      <Icon name="info" />
      公开仓库无需令牌；私有仓库读取需要 <span className="mono">repo</span> 权限的 PAT。
    </div>
  );

  return (
    <>
      <header className="page-head" data-tauri-drag-region>
        <div>
          <h1 className="ph-title">设置</h1>
          <p className="ph-sub">技能存储、GitHub 访问与应用信息</p>
        </div>
      </header>
      <div className="page-body">
        <div className="set-wrap">
          {/* ---------------- 技能存储 ---------------- */}
          <div className="card">
            <div className="card-h">
              <span className="card-t">技能存储</span>
            </div>
            <div className="set-row">
              <div className="set-l">
                <div className="set-lt">技能根目录</div>
                <div className="set-ls">
                  技能安装位置。默认 <span className="mono">~\.agents\skills\</span>。
                </div>
              </div>
              <div className="set-c">
                <div className="path">
                  <div className="path-in">
                    <input
                      value={rootInput}
                      spellCheck={false}
                      aria-label="技能根目录"
                      onChange={(e) => setRootInput(e.target.value)}
                    />
                  </div>
                  <button type="button" className="btn btn-sm" style={{ height: 32 }} onClick={() => void browseRoot()}>
                    <Icon name="folder" />
                    浏览…
                  </button>
                  <button type="button" className="btn btn-sm btn-ghost" style={{ height: 32 }} onClick={restoreDefaultRoot}>
                    恢复默认
                  </button>
                </div>
                {settingsError !== null ? (
                  <div className="fhint warn">
                    <Icon name="warn" />
                    设置不可用 — {settingsError.message}
                  </div>
                ) : (
                  <div className="fhint">
                    <Icon name="info" />
                    技能清单存储于 <span className="mono">&nbsp;&lt;root&gt;\.workbench-skills.json&nbsp;</span>。
                  </div>
                )}
                <div>
                  <button type="button" className="link link-btn" disabled title="计划于 M3 提供">
                    <Icon name="folder" className="link-ic" />
                    打开技能目录
                  </button>
                </div>
                <div className="set-actions">
                  <button
                    type="button"
                    className="btn btn-primary btn-sm"
                    disabled={savingRoot || settingsError !== null}
                    onClick={() => void saveRoot()}
                  >
                    {savingRoot ? <span className="spin" /> : null}
                    保存
                  </button>
                </div>
              </div>
            </div>
          </div>

          {/* ---------------- GitHub 访问 ---------------- */}
          <div className="card">
            <div className="card-h">
              <span className="card-t">GitHub 访问</span>
            </div>
            <div className="set-row">
              <div className="set-l">
                <div className="set-lt">GitHub PAT（个人访问令牌）</div>
                <div className="set-ls">
                  公开仓库无需令牌；私有仓库读取需要 <span className="mono">repo</span> 权限的 PAT。
                </div>
              </div>
              <div className="set-c">
                {patError !== null ? (
                  <div className="fhint warn">
                    <Icon name="warn" />
                    PAT 状态不可用 — {patError.message}
                  </div>
                ) : pat === null ? (
                  <div className="fhint">
                    <span className="spin" />
                    正在读取钥匙串状态…
                  </div>
                ) : configured && !patEditing ? (
                  <>
                    <div className="patbox">
                      <div className="patval">
                        <Icon name="lock" />
                        <span className="mask">ghp_••••••••••••••••••••</span>
                      </div>
                      <button type="button" className="btn btn-sm" onClick={() => setPatEditing(true)}>
                        更新
                      </button>
                      <button
                        type="button"
                        className="btn btn-sm btn-danger-o"
                        disabled={patSaving}
                        onClick={() => void clearPat()}
                      >
                        清除
                      </button>
                    </div>
                    <div className="fhint ok">
                      <Icon name="shield" />
                      已存入系统钥匙串 · 保存后不再显示完整令牌。
                    </div>
                  </>
                ) : (
                  <>
                    <div className="patbox">
                      {patTokenInput}
                      <button
                        type="button"
                        className="btn btn-sm btn-primary"
                        disabled={token.trim() === "" || patSaving}
                        onClick={() => void savePat()}
                      >
                        {patSaving ? <span className="spin" /> : null}
                        保存
                      </button>
                      {patEditing && (
                        <button
                          type="button"
                          className="btn btn-sm btn-ghost"
                          onClick={() => {
                            setPatEditing(false);
                            setToken("");
                          }}
                        >
                          取消
                        </button>
                      )}
                    </div>
                    {scopeHint}
                  </>
                )}
                <div className="fhint">
                  <Icon name="info" />
                  配置 PAT 后，GitHub API 限额由 60 次/小时（未认证）提升至 5,000 次/小时。
                </div>
              </div>
            </div>
          </div>

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
                    <Icon name="term" />
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
