// Deploy empty states (SPEC §3.23): the not-deployed panel with the prominent
// 部署 CTA, the dsh preset summary (dsh has no per-agent files), and the
// distinct empty-roster state for a target marked deployed whose agent listing
// came back empty (notes §5.3 — never the generic not-deployed panel).
import { Icon } from "../../icons";
import { DSH_PRESET_NAME } from "./logic";

interface NotDeployedEmptyProps {
  target: string;
  /** Short install-location word for the explanation (locationShort). */
  locationLabel: string;
  onDeploy: () => void;
}

export function NotDeployedEmpty({ target, locationLabel, onDeploy }: NotDeployedEmptyProps) {
  return (
    <div className="empty">
      <div className="empty-ic">
        <Icon name="deploy" />
      </div>
      <div className="empty-t">{target} 尚未部署</div>
      <div className="empty-s">
        从内置源渲染并写入 {target} 的安装位置（{locationLabel}），安装前可预览每个文件。
      </div>
      <button type="button" className="btn btn-primary" onClick={onDeploy}>
        <Icon name="deploy" />
        部署
      </button>
    </div>
  );
}

interface DshPresetEmptyProps {
  /** DSH home from detect_environment. */
  home: string;
  /** Active profile name, or null when no unique profile was found. */
  profile: string | null;
  /** dsh preset row (deployed_overview): recursive deployed-file count, null when unavailable. */
  presetFileCount: number | null;
  /** dsh preset row (deployed_overview): newest deployed-file mtime in millis, null when unavailable. */
  deployedAtMs: number | null;
}

/** The mockup's 部署时间 format: `YYYY-MM-DD HH:mm` (app.html `${DSH_PRESET.at}`). */
function formatDeployedAt(ms: number): string {
  const d = new Date(ms);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

export function DshPresetEmpty({ home, profile, presetFileCount, deployedAtMs }: DshPresetEmptyProps) {
  return (
    <div className="empty">
      <div className="empty-ic">
        <Icon name="layers" />
      </div>
      <div className="empty-t">dsh 已部署</div>
      <div className="empty-s">dsh 以预设为单位部署 — 没有单独的智能体文件。点击右上角「更新」从内置源重新部署。</div>
      <div className="preset">
        <div className="pr-row">
          <span>预设</span>
          <span className="mono">{DSH_PRESET_NAME}</span>
        </div>
        <div className="pr-row">
          <span>主目录</span>
          <span className="mono">{home}</span>
        </div>
        <div className="pr-row">
          <span>profile</span>
          <span className="mono">{profile ?? "—"}</span>
        </div>
        <div className="pr-row">
          <span>部署文件</span>
          <span className="mono num">{presetFileCount ?? "—"}</span>
        </div>
        <div className="pr-row">
          <span>部署时间</span>
          <span className="mono num">{deployedAtMs !== null ? formatDeployedAt(deployedAtMs) : "—"}</span>
        </div>
      </div>
    </div>
  );
}

export function RosterEmpty() {
  return (
    <div className="empty">
      <div className="empty-ic">
        <Icon name="file" />
      </div>
      <div className="empty-t">未找到已部署的智能体文件</div>
      <div className="empty-s">目标已标记为部署，但没有可显示的智能体文件。点击「更新」重新部署。</div>
    </div>
  );
}
