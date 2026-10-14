// Realm scope bar (SPEC §4.3): one compact row under the backend tabs, for
// opencode/claude only — 项目级/用户级 segmented control + project directory
// input + 浏览… (one app-wide persisted state shared with the deploy dialog).
// zcode/dsh have fixed locations with no scope choice (2026-10: the former
// fixed-location info lines are UI-removed — they carry no control) and the
// component renders nothing for them.
import { Icon } from "../../icons";
import type { Target } from "../../lib/ipc";

interface ScopeBarProps {
  target: Target;
  userLevel: boolean;
  projectDir: string;
  onUserLevel: (userLevel: boolean) => void;
  onProjectDir: (dir: string) => void;
  /** Page-level picker (pickDirectory + browser-degradation toast). */
  onBrowse: () => void;
}

export function ScopeBar({ target, userLevel, projectDir, onUserLevel, onProjectDir, onBrowse }: ScopeBarProps) {
  if (target === "zcode" || target === "dsh") return null;

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
