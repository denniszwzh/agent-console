import { useEffect, useRef, useState, type ReactNode } from 'react';
import type { ReviewUnit, SessionActivity } from '../../shared/types.js';
import { UNIT_STATUS_LABELS, formatTime } from '../labels.js';
import { UnitProvider, useUnit, type UnitActions } from '../unit-context.js';
import { ConclusionBar } from './ConclusionBar.js';
import { RespondingBanner } from './Responding.js';
import { SourceTabs } from './SourceTabs.js';
import { SourceView } from './SourceView.js';

function Banners() {
  const { unit } = useUnit();
  const paths = [...new Set(unit.warnings.flatMap((w) => w.paths))].sort();
  return (
    <>
      {unit.status === 'stale' && <div className="banner banner-stale">已過期：主對話已進入下一輪</div>}
      {paths.length > 0 && (
        <div className="banner banner-danger" role="alert">
          <strong>問題串執行期間偵測到檔案變動</strong>
          <ul>
            {paths.map((p) => (
              <li key={p}>
                <code>{p}</code>
              </li>
            ))}
          </ul>
          <p className="hint">這也可能是你自己在編輯器中修改了檔案。</p>
        </div>
      )}
      {unit.scanNotice && (
        <div className="banner banner-scan">
          {unit.scanNotice.omitted > 0 && (
            <p>這一輪還有 {unit.scanNotice.omitted} 個變動的檔案沒有加入（每輪最多自動加入 30 個，先加入最新的）。</p>
          )}
          {unit.scanNotice.incomplete && <p>資料夾太大，檔案掃描沒有做完，可能漏掉一些檔案。</p>}
          <p className="hint">需要的檔案可以用「＋ 加入檔案」加入。</p>
        </div>
      )}
    </>
  );
}

function UnitBody({ navToggle, responding }: { navToggle?: ReactNode; responding?: SessionActivity }) {
  const { unit } = useUnit();
  const [activeId, setActiveId] = useState(unit.reply.id);
  const awaitingNewFile = useRef<number | null>(null);
  const active = [unit.reply, ...unit.files].find((s) => s.id === activeId) ?? unit.reply;

  // After "add file", switch to the new tab once it arrives.
  useEffect(() => {
    if (awaitingNewFile.current !== null && unit.files.length > awaitingNewFile.current) {
      awaitingNewFile.current = null;
      setActiveId(unit.files[unit.files.length - 1].id);
    }
  }, [unit.files]);

  return (
    <div className={`unit unit-${unit.status}`}>
      <header className="unit-head">
        <span className={`agent-badge agent-${unit.agent}`}>{unit.agent}</span>
        <span className="unit-cwd" title={unit.cwd}>
          {unit.cwd}
        </span>
        <span className="unit-time">{formatTime(unit.createdAt)}</span>
        <span className={`unit-status unit-status-${unit.status}`}>{UNIT_STATUS_LABELS[unit.status]}</span>
      </header>
      {responding && <RespondingBanner activity={responding} unitOpen={unit.status === 'open'} />}
      <Banners />
      <SourceTabs
        activeId={active.id}
        leading={navToggle}
        onSelect={setActiveId}
        onAddingFile={() => {
          awaitingNewFile.current = unit.files.length;
        }}
      />
      <main className="reading">
        <SourceView key={active.id} source={active} />
      </main>
      <ConclusionBar />
    </div>
  );
}

export function UnitView({
  unit,
  actions,
  navToggle,
  responding,
}: {
  unit: ReviewUnit;
  actions: UnitActions;
  navToggle?: ReactNode;
  /** Set while the unit's main session is working on a new turn. */
  responding?: SessionActivity;
}) {
  return (
    <UnitProvider unit={unit} actions={actions}>
      <UnitBody navToggle={navToggle} responding={responding} />
    </UnitProvider>
  );
}
