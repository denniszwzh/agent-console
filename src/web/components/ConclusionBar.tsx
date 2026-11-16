import { useState } from 'react';
import { carriedByAncestor, integrationState } from '../../shared/gate.js';
import type { ReviewUnit, Thread } from '../../shared/types.js';
import { firstLine } from '../labels.js';
import { fire, useUnit } from '../unit-context.js';

/** One concluded thread in the read-only list shown after the conclusions were handed back. */
function ConclusionItem({ thread }: { thread: Thread }) {
  const question = thread.messages.find((m) => m.role === 'user')?.content ?? '';
  const text = thread.noConclusion || thread.conclusion === null ? null : thread.conclusion;
  return (
    <li className="conclusion-item">
      <div className="conclusion-question">
        <span>{firstLine(question, 90)}</span>
      </div>
      <div className="conclusion-text">
        <span className={text === null ? 'muted' : undefined}>{text ?? '(no conclusion)'}</span>
      </div>
    </li>
  );
}

/** A copy-to-clipboard button that confirms with Copied. */
function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
    } catch {
      setCopied(false);
    }
  };
  return (
    <button type="button" className="btn small" onClick={() => void copy()}>
      {copied ? 'Copied' : 'Copy'}
    </button>
  );
}

/** What happens after submission depends on the agent. */
function DeliveryNotice({ unit }: { unit: ReviewUnit }) {
  if (unit.agent === 'claude') return <ClaudeDelivery unit={unit} />;
  return <CodexDelivery unit={unit} />;
}

/** Claude gets the bundle via the prompt hook; the file path is the fallback for /clear'ed or closed sessions. */
function ClaudeDelivery({ unit }: { unit: ReviewUnit }) {
  return (
    <div className="delivery">
      <span>
        {unit.delivered
          ? 'The conclusions were passed to the main session.'
          : 'They are added to the main session with your next message in the terminal (for example "apply the review conclusions").'}
      </span>
      {unit.conclusionsPath && (
        <>
          <span>If you ran /clear or closed the session, copy the conclusions file path and ask Claude to read and apply it:</span>
          <code>{unit.conclusionsPath}</code>
          <CopyButton text={unit.conclusionsPath} />
        </>
      )}
    </div>
  );
}

/** Codex has no prompt hook: the instruction is queued when possible and can always be copied. */
function CodexDelivery({ unit }: { unit: ReviewUnit }) {
  const instruction = unit.delivery?.instruction;
  // Submitted, but the queue attempt (up to ~10 s) has not reported back yet.
  if (!instruction) return <div className="delivery muted">Queueing in Codex…</div>;
  return (
    <div className="delivery">
      <span>{unit.delivery?.queued ? 'Queued. If the next turn does not pick it up, paste the instruction below into Codex.' : 'Paste this into Codex to apply the conclusions:'}</span>
      <code>{instruction}</code>
      <CopyButton text={instruction} />
    </div>
  );
}

/** The single action of a turn under review: conclude every answered thread and hand them back. */
export function ConclusionBar() {
  const { unit, actions } = useUnit();
  const [expanded, setExpanded] = useState(false);
  const state = integrationState(unit);
  const integrating = unit.integrating === true;
  const submitted = unit.status === 'submitted';
  // Children are folded into their nearest concluded ancestor, as in the bundle.
  const concluded = unit.threads.filter((t) => t.status === 'resolved' && !carriedByAncestor(unit.threads, t));

  let reason = '';
  if (!submitted && !integrating) {
    if (state.answering > 0) reason = `${state.answering} still answering`;
    else if (state.answered === 0) reason = 'No answered threads yet';
  }

  return (
    <footer className="conclusion-bar">
      {submitted && expanded && (
        <ol className="conclusion-list">
          {concluded.length === 0 && <li className="muted">No conclusions.</li>}
          {concluded.map((t) => (
            <ConclusionItem key={t.id} thread={t} />
          ))}
        </ol>
      )}
      <div className="bar-row">
        {submitted ? (
          <button type="button" className="btn ghost" aria-expanded={expanded} onClick={() => setExpanded(!expanded)}>
            {expanded ? '▾' : '▸'} View conclusions ({concluded.length})
          </button>
        ) : integrating ? (
          <span className="bar-status" role="status">
            Integrating conclusions… ({state.concluded}/{state.total})
          </span>
        ) : (
          <span className="bar-status muted">{state.answered > 0 ? `${state.answered} answered` : ''}</span>
        )}
        <span className="spacer" />
        {reason && <span className="bar-reason muted">{reason}</span>}
        {!submitted && (
          <button
            type="button"
            className="btn primary"
            disabled={!state.canIntegrate}
            title="Write a one-line conclusion for each answered thread and pass them to the main session with your next message"
            onClick={() => fire(actions.integrate())}
          >
            {integrating ? 'Integrating…' : 'Integrate conclusions'}
          </button>
        )}
      </div>
      {!submitted && !integrating && unit.integrationError && (
        <div className="delivery error" role="alert">
          Integration did not finish: {unit.integrationError}. Press Integrate conclusions again; conclusions already written are kept.
        </div>
      )}
      {submitted && <DeliveryNotice unit={unit} />}
    </footer>
  );
}
