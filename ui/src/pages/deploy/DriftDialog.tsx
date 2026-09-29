// 漂移详情 dialog (SPEC §3.11 + locked decision §10.3): 期望/本地 panes,
// warning copy, footer 关闭 / 覆盖重装. 覆盖重装 never writes ad-hoc — it
// routes into the normal plan/execute flow with 覆盖 forced ON.
import { Dialog } from "../../components/Dialog";
import { Icon } from "../../icons";
import type { DriftFile } from "../../lib/ipc";

interface DriftDialogProps {
  file: DriftFile | null;
  onClose: () => void;
  onRepair: () => void;
}

export function DriftDialog({ file, onClose, onRepair }: DriftDialogProps) {
  return (
    <Dialog
      open={file !== null}
      onClose={onClose}
      title="漂移详情"
      icon="act"
      iconKind="warn"
      width={640}
      footer={
        <>
          <button type="button" className="btn btn-ghost" onClick={onClose}>
            关闭
          </button>
          <button type="button" className="btn btn-primary" onClick={onRepair}>
            覆盖重装
          </button>
        </>
      }
    >
      {file && (
        <>
          <span className="mono" style={{ color: "var(--text-1)" }}>
            {file.path}
          </span>
          <span>本地文件与渲染期望不一致（字节对比）。</span>
          <div className="diff2">
            <div className="dpan">
              <div className="dp-h">
                <Icon name="file" />
                期望（渲染结果）
              </div>
              <pre>{`来源：agents\\${file.sourceRel}`}</pre>
            </div>
            <div className="dpan">
              <div className="dp-h">
                <Icon name="edit" />
                本地文件
              </div>
              <pre>{file.path}</pre>
            </div>
          </div>
          <div className="fhint warn">
            <Icon name="warn" />
            <span>将以覆盖模式重新安装；所有已存在的文件都会被覆盖且不可恢复。</span>
          </div>
        </>
      )}
    </Dialog>
  );
}
