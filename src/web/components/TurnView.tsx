import { memo, useState } from 'react';
import type { ReviewUnit, TurnPrompt } from '../../shared/types.js';
import { UNIT_STATUS_LABELS, basename, formatTime } from '../labels.js';
import { UnitProvider, type UnitActions } from '../unit-context.js';
import { SourceView } from './SourceView.js';

/** Prompts longer than this many lines are folded until expanded. */
const FOLD_LINES = 12;

function PromptText({ text }: { text: string }) {
  const lines = text.split(/\r?\n/);
  const [open, setOpen] = useState(false);
  const folded = !open && lines.length > FOLD_LINES;
  return (
    <div className="turn-prompt-text">
      {folded ? lines.slice(0, FOLD_LINES).join('\n') : text}
      {folded && (
        <button type="button" className="btn ghost small turn-prompt-more" onClick={() => setOpen(true)}>
          Show more
        </button>
      )}
    </div>
  );
}

function DeliveryPrompt({ text }: { text: string }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="turn-prompt turn-prompt-delivery">
      <button type="button" className="btn ghost small" aria-expanded={open} onClick={() => setOpen((v) => !v)}>
        Review conclusions applied
      </button>
      {open && <div className="turn-prompt-text">{text}</div>}
    </div>
  );
}

function Prompts({ prompts, omitted }: { prompts: TurnPrompt[]; omitted: number }) {
  return (
    <div className="turn-prompts">
      {omitted > 0 && <div className="turn-prompts-omitted">{omitted} earlier {omitted === 1 ? 'prompt' : 'prompts'} not shown</div>}
      {prompts.map((p, i) =>
        p.delivery ? (
          <DeliveryPrompt key={i} text={p.text} />
        ) : (
          <div key={i} className="turn-prompt">
            <span className="you-label turn-prompt-who">You</span>
            <PromptText text={p.text} />
          </div>
        ),
      )}
    </div>
  );
}

function Notices({ unit, latestOpen }: { unit: ReviewUnit; latestOpen: boolean }) {
  const paths = [...new Set(unit.warnings.flatMap((w) => w.paths))].sort();
  return (
    <>
      {paths.length > 0 && (
        <div className="banner banner-danger" role="alert">
          <strong>Files changed while a thread was running</strong>
          <ul>
            {paths.map((p) => (
              <li key={p}>
                <code>{p}</code>
              </li>
            ))}
          </ul>
          <p className="hint">You may also have edited them in your editor yourself.</p>
        </div>
      )}
      {unit.scanNotice && (
        <div className="banner banner-scan">
          {unit.scanNotice.omitted > 0 && (
            <p>{unit.scanNotice.omitted} more changed files from this turn were not added (at most 30 are added per turn, newest first).</p>
          )}
          {unit.scanNotice.incomplete && <p>The folder is too large; the file scan did not finish and may have missed some files.</p>}
          {latestOpen && <p className="hint">Add the files you need with + Add file.</p>}
        </div>
      )}
    </>
  );
}

interface Props {
  unit: ReviewUnit;
  actions: UnitActions;
  /** The session's newest turn (its files are also the tabs above the conversation). */
  latest: boolean;
  /** Position of this turn in the whole session, from 1. */
  turnNumber: number;
  onOpenFile(unitId: string, sourceId: string): void;
}

/** One turn of a session: the user's prompts, the agent's reply (reviewable while open), and the files it changed. */
export const TurnView = memo(function TurnView({ unit, actions, latest, turnNumber, onOpenFile }: Props) {
  return (
    <section className={`turn turn-${unit.status}`} data-unit-id={unit.id} aria-label={`Turn ${turnNumber}`}>
      <div className="turn-divider">
        <span className="turn-time">{formatTime(unit.createdAt)}</span>
        <span className={`unit-status unit-status-${unit.status}`}>{UNIT_STATUS_LABELS[unit.status]}</span>
      </div>
      {unit.prompts && unit.prompts.length > 0 && <Prompts prompts={unit.prompts} omitted={unit.promptsOmitted ?? 0} />}
      <div className="turn-reply">
        <span className={`agent-badge agent-${unit.agent}`}>{unit.agent}</span>
        <UnitProvider unit={unit} actions={actions}>
          <SourceView source={unit.reply} />
        </UnitProvider>
      </div>
      <Notices unit={unit} latestOpen={latest && unit.status === 'open'} />
      {unit.files.length > 0 && (
        <div className="turn-files">
          <span className="turn-files-label">Changed this turn:</span>
          {unit.files.map((f) => (
            <button key={f.id} type="button" className="btn ghost small turn-file" title={f.path} onClick={() => onOpenFile(unit.id, f.id)}>
              {basename(f.path ?? 'file')}
            </button>
          ))}
        </div>
      )}
    </section>
  );
});
