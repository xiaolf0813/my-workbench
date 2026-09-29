// Skills dialogs (SPEC §3.13 / §5.2 / §5.3): 添加/编辑技能源 · 删除技能源 ·
// 检测到本地修改 · 删除技能. Shell, focus flow and Esc/backdrop handling come
// from the shared Dialog component; copy is verbatim from the mockup / SPEC §8.
import { useEffect, useState } from "react";
import { Dialog } from "../../components/Dialog";
import { Icon } from "../../icons";
import type { SkillSourceConfig } from "../../lib/ipc";
import { backupStamp, repoShapeOk } from "./logic";

/* ------------------------------------------------------------------ */
/* 添加技能源 / 编辑技能源                                              */
/* ------------------------------------------------------------------ */

export interface SourceDialogState {
  mode: "add" | "edit";
  index?: number;
  initial?: SkillSourceConfig;
}

interface SourceDialogProps {
  state: SourceDialogState | null;
  onClose: () => void;
  onSave: (repo: string, ref: string | null, subdir: string) => Promise<boolean>;
}

export function SourceDialog({ state, onClose, onSave }: SourceDialogProps) {
  const edit = state?.mode === "edit";
  const [repo, setRepo] = useState("");
  const [ref, setRef] = useState("");
  const [subdir, setSubdir] = useState("");
  const [saving, setSaving] = useState(false);
  const [touched, setTouched] = useState(false);

  useEffect(() => {
    if (state) {
      setRepo(state.initial?.repo ?? "");
      setRef(state.initial?.ref ?? "");
      setSubdir(state.initial?.subdir ?? "");
      setSaving(false);
      setTouched(false);
    }
  }, [state]);

  const repoOk = repoShapeOk(repo);
  const showShapeHint = touched && repo.trim() !== "" && !repoOk;
  const canSave = repoOk && !saving;

  const save = async () => {
    setTouched(true);
    if (!canSave) return;
    setSaving(true);
    const ok = await onSave(repo.trim(), ref.trim() === "" ? null : ref.trim(), subdir.trim());
    setSaving(false);
    if (ok) onClose();
  };

  return (
    <Dialog
      open={state !== null}
      onClose={onClose}
      title={edit ? "编辑技能源" : "添加技能源"}
      icon="git"
      iconKind="info"
      footer={
        <>
          <button type="button" className="btn btn-ghost" onClick={onClose} disabled={saving}>
            取消
          </button>
          <button type="button" className="btn btn-primary" onClick={() => void save()} disabled={!canSave}>
            {saving ? <span className="spin" /> : null}
            {edit ? "保存" : "添加源"}
          </button>
        </>
      }
    >
      <div className="fld">
        <label className="flab" htmlFor="sk-src-repo">
          仓库
        </label>
        <input
          id="sk-src-repo"
          className="fld-in mono"
          placeholder="owner/repo"
          value={repo}
          spellCheck={false}
          onChange={(e) => {
            setRepo(e.target.value);
            setTouched(true);
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter") void save();
          }}
        />
        {showShapeHint ? (
          <div className="fhint err">
            <Icon name="warn" />
            仓库需为 owner/repo 形式（仅支持 GitHub，公开或私有）。
          </div>
        ) : (
          <div className="fhint">
            <Icon name="info" />
            仅支持 GitHub 仓库（公开或私有）。
          </div>
        )}
      </div>
      <div className="src-grid2">
        <div className="fld">
          <label className="flab" htmlFor="sk-src-ref">
            分支 / Ref <span className="opt-tag">（可选）</span>
          </label>
          <input
            id="sk-src-ref"
            className="fld-in mono"
            placeholder="默认分支"
            value={ref}
            spellCheck={false}
            onChange={(e) => setRef(e.target.value)}
          />
        </div>
        <div className="fld">
          <label className="flab" htmlFor="sk-src-sub">
            技能子目录 <span className="opt-tag">（可选）</span>
          </label>
          <input
            id="sk-src-sub"
            className="fld-in mono"
            placeholder="skills/"
            value={subdir}
            spellCheck={false}
            onChange={(e) => setSubdir(e.target.value)}
          />
        </div>
      </div>
      <div className="bn mut" style={{ padding: "8px 10px" }}>
        <Icon name="lock" />
        <div className="bn-c">
          <div className="bn-s">私有仓库将使用已配置的 GitHub PAT（设置 → GitHub 访问）。公开仓库无需认证。</div>
        </div>
      </div>
    </Dialog>
  );
}

/* ------------------------------------------------------------------ */
/* 删除技能源                                                          */
/* ------------------------------------------------------------------ */

interface SourceDeleteDialogProps {
  state: { index: number; repo: string } | null;
  onClose: () => void;
  onRemove: (index: number) => void;
}

export function SourceDeleteDialog({ state, onClose, onRemove }: SourceDeleteDialogProps) {
  return (
    <Dialog
      open={state !== null}
      onClose={onClose}
      title="删除技能源"
      icon="trash"
      iconKind="err"
      width={440}
      footer={
        <>
          <button type="button" className="btn btn-ghost" onClick={onClose}>
            取消
          </button>
          <button
            type="button"
            className="btn btn-danger"
            onClick={() => {
              if (state) onRemove(state.index);
              onClose();
            }}
          >
            移除源
          </button>
        </>
      }
    >
      <span>
        移除源 <b className="mono">{state?.repo ?? ""}</b>？已安装的技能不受影响，仅解除关联（无法再更新）。
      </span>
    </Dialog>
  );
}

/* ------------------------------------------------------------------ */
/* 检测到本地修改                                                      */
/* ------------------------------------------------------------------ */

export interface ModifiedDialogState {
  name: string;
  modified: string[];
  backupPath: string;
}

interface ModifiedDialogProps {
  state: ModifiedDialogState | null;
  onClose: () => void;
  onForceUpdate: (name: string) => void;
}

export function ModifiedDialog({ state, onClose, onForceUpdate }: ModifiedDialogProps) {
  return (
    <Dialog
      open={state !== null}
      onClose={onClose}
      title="检测到本地修改"
      icon="warn"
      iconKind="warn"
      footer={
        <>
          <button type="button" className="btn btn-ghost" onClick={onClose}>
            取消
          </button>
          <button
            type="button"
            className="btn btn-warn"
            onClick={() => {
              if (state) onForceUpdate(state.name);
              onClose();
            }}
          >
            <Icon name="up" />
            备份后强制更新
          </button>
        </>
      }
    >
      {state && (
        <>
          <span>
            技能 <b className="mono">{state.name}</b> 的以下文件自安装后被修改过：
          </span>
          <div className="modlist">
            <div className="ml-h">已修改的文件 · {state.modified.length}</div>
            {state.modified.map((f) => (
              <div className="ml-r" key={f}>
                <Icon name="warn" />
                {f}
              </div>
            ))}
          </div>
          <span>
            强制更新将<b>丢失这些修改</b>。选择「备份后强制更新」会先把当前目录完整备份，再应用远端最新版本。
          </span>
          <div className="fhint">
            <Icon name="folder" />
            备份位置：<span className="mono">&nbsp;{state.backupPath}&nbsp;</span>
          </div>
        </>
      )}
    </Dialog>
  );
}

/* ------------------------------------------------------------------ */
/* 删除技能                                                            */
/* ------------------------------------------------------------------ */

interface DeleteSkillDialogProps {
  state: { name: string } | null;
  skillsRoot: string;
  onClose: () => void;
  onDelete: (name: string, trash: boolean) => void;
}

export function DeleteSkillDialog({ state, skillsRoot, onClose, onDelete }: DeleteSkillDialogProps) {
  const [trash, setTrash] = useState(true);
  useEffect(() => {
    if (state) setTrash(true);
  }, [state]);
  return (
    <Dialog
      open={state !== null}
      onClose={onClose}
      title="删除技能"
      icon="trash"
      iconKind="err"
      footer={
        <>
          <button type="button" className="btn btn-ghost" onClick={onClose}>
            取消
          </button>
          <button
            type="button"
            className="btn btn-danger"
            onClick={() => {
              if (state) onDelete(state.name, trash);
              onClose();
            }}
          >
            删除
          </button>
        </>
      }
    >
      {state && (
        <>
          <span>
            将从 <span className="mono">{skillsRoot}</span> 移除 <b className="mono">{state.name}</b>
            及其清单条目。此操作不可撤销（除非勾选备份）。
          </span>
          <label className="fchk">
            <input type="checkbox" checked={trash} onChange={(e) => setTrash(e.target.checked)} />
            备份到回收站（删除前复制整个技能目录到系统回收站）
          </label>
        </>
      )}
    </Dialog>
  );
}

/** Backup-hint path for the 检测到本地修改 dialog: <root>\.backups\<skill>-<stamp>\ */
export function backupHintPath(root: string, skill: string, now: Date): string {
  const base = root.replace(/[\\/]+$/, "");
  return `${base}\\.backups\\${skill}-${backupStamp(now)}\\`;
}
