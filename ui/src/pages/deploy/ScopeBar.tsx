// Realm scope bar (SPEC §4.3): one compact row under the backend tabs.
// opencode/claude — 项目级/用户级 segmented control + project directory
// input + 浏览… (one app-wide persisted state shared with the deploy dialog);
// zcode/dsh — fixed-location line instead, with the scope seg never shown
// (not even disabled). The dsh line mirrors the sidebar env card's §10.5
// payload (`DSH_HOME → {home} · profile {name}` + the 已覆盖 chip).
import { Icon } from "../../icons";
import type { EnvironmentInfo, Target } from "../../lib/ipc";

interface ScopeBarProps {
  target: Target;
  userLevel: boolean;
  projectDir: string;
  onUserLevel: (userLevel: boolean) => void;
  onProjectDir: (dir: string) => void;
  /** Page-level picker (pickDirectory + browser-degradation toast). */
  onBrowse: () => void;
  /** detect_environment payload — feeds the dsh fixed-location line. */
  env: EnvironmentInfo | null;
}

export function ScopeBar({ target, userLevel, projectDir, onUserLevel, onProjectDir, onBrowse, env }: ScopeBarProps) {
  if (target === "zcode") {
    return (
      <div className="dep-scopebar">
        <span className="dep-loclabel">部署位置</span>
        <span className="dep-loc">
          <span className="mono">~\.zcode</span>
        </span>
        <span className="fixchip">固定</span>
      </div>
    );
  }

  if (target === "dsh") {
    const dsh = env?.dsh ?? null;
    const home = dsh !== null ? dsh.home : "—";
    const profile = dsh !== null ? (dsh.profile ?? "—") : "—";
    const overridden = dsh !== null && dsh.homeSource === "env";
    return (
      <div className="dep-scopebar">
        <span className="dep-loclabel">部署位置</span>
        <span className="dep-loc">
          <span className="mono">DSH_HOME → {home}</span>
          <span className="mono">· profile {profile}</span>
        </span>
        {overridden && <span className="envchip">DSH_HOME 已覆盖</span>}
      </div>
    );
  }

  return (
    <div className="dep-scopebar">
      <div className="seg" role="group" aria-label="部署范围">
        <button type="button" className={`seg-b${!userLevel ? " is-on" : ""}`} aria-pressed={!userLevel} onClick={() => onUserLevel(false)}>
          项目级
        </button>
        <button type="button" className={`seg-b${userLevel ? " is-on" : ""}`} aria-pressed={userLevel} onClick={() => onUserLevel(true)}>
          用户级
        </button>
      </div>
      {userLevel ? (
        <div className="fhint">
          <Icon name="info" />
          安装到用户配置目录而非项目目录
        </div>
      ) : (
        <>
          <div className="path">
            <div className="path-in">
              <input
                value={projectDir}
                onChange={(e) => onProjectDir(e.target.value)}
                spellCheck={false}
                aria-label="项目目录"
                placeholder="D:\dev\acme-web"
              />
            </div>
            <button type="button" className="btn btn-sm" style={{ height: 32 }} onClick={onBrowse}>
              <Icon name="folder" />
              浏览…
            </button>
          </div>
          <div className="fhint">
            <Icon name="info" />
            项目目录 = opencode / claude 项目级安装根目录
          </div>
        </>
      )}
    </div>
  );
}
