import { randomUUID } from 'node:crypto';
import type { AgentAdapter, AgentEvent } from '../agents/adapter.js';
import { splitBlocks } from '../shared/blocks.js';
import { concludableChildren, integrationState, isExcluded } from '../shared/gate.js';
import type { AgentKind, Anchor, Message, ReviewUnit, Thread } from '../shared/types.js';
import type { EventBus } from './events.js';
import { changedPaths, defaultGitStatus, defaultStat, fingerprint, type Fingerprints, type GitStatusProbe, type StatFn } from './postcheck.js';
import { conclusionPrompt, questionPrompt } from './prompts.js';
import type { UnitStore } from './store.js';

export class ConflictError extends Error {}
export class NotFoundError extends Error {}
export class ValidationError extends Error {}

export interface ThreadEngineOptions {
  /** Post-check probe seam; defaults to real git (`rev-parse --show-toplevel` + `status --porcelain -z`). */
  gitStatus?: GitStatusProbe;
  /** Stat seam for change fingerprints; returns null when the file is missing. */
  statPath?: StatFn;
  /** Upper bound for one fork run; defaults to 10 minutes. */
  runTimeoutMs?: number;
}

type Job = () => Promise<void>;

const DEFAULT_RUN_TIMEOUT_MS = 600_000;
/** Abort reasons for a fork run. */
const TIMEOUT = Symbol('timeout');
const EXPIRED = Symbol('expired');

function formatMinutes(ms: number): string {
  return String(Number((ms / 60_000).toFixed(2)));
}

export class ThreadEngine {
  private forkSessions = new Set<string>();
  private threadUnit = new Map<string, string>();
  private concurrency: number;
  private active = 0;
  private waiting: (() => void)[] = [];
  private inflight = new Set<Promise<void>>();
  /** unitId -> conclusion runs queued or running for it. */
  private concluding = new Map<string, number>();
  /** Hands an integrated unit back to the main session (writes the bundle, marks it submitted). */
  private submitter?: (unitId: string) => Promise<unknown>;
  /** threadId -> abort controller of its in-flight run. */
  private runs = new Map<string, AbortController>();
  private runTimeoutMs: number;

  constructor(
    private store: UnitStore,
    private bus: EventBus,
    private adapters: Partial<Record<AgentKind, AgentAdapter>>,
    concurrency: number,
    private opts: ThreadEngineOptions = {},
  ) {
    this.concurrency =
      typeof concurrency === 'number' && Number.isFinite(concurrency) ? Math.max(1, Math.floor(concurrency)) : 3;
    const t = opts.runTimeoutMs;
    this.runTimeoutMs = typeof t === 'number' && Number.isFinite(t) && t > 0 ? t : DEFAULT_RUN_TIMEOUT_MS;
    for (const s of store.listSessions()) {
      for (const u of store.listBySession(s.sessionId)) {
        let dirty = false;
        // An integration does not survive a restart: its conclusion runs are gone.
        if (u.status === 'open' && u.integrating) {
          for (const t of u.threads) if (t.status === 'answering') t.status = 'awaiting';
          u.integrating = false;
          u.integrationError = 'Interrupted by server restart';
          dirty = true;
        }
        for (const t of u.threads) {
          this.threadUnit.set(t.id, u.id);
          if (t.sessionId) this.forkSessions.add(t.sessionId);
          // Runs do not survive a restart; unstick threads that were mid-run.
          if (u.status === 'open' && t.status === 'answering') {
            t.status = 'error';
            t.error = 'Interrupted by server restart';
            dirty = true;
          }
        }
        if (dirty) this.persist(u);
      }
    }
  }

  isForkSession(sessionId: string): boolean {
    return this.forkSessions.has(sessionId);
  }

  /** Aborts the in-flight runs of a unit's threads (called when the unit expires). */
  abortUnitRuns(unitId: string): void {
    for (const [threadId, ctl] of this.runs) {
      if (this.threadUnit.get(threadId) === unitId) ctl.abort(EXPIRED);
    }
  }

  /** Resolves once every queued or running branch has finished. */
  async whenIdle(): Promise<void> {
    while (this.inflight.size) await Promise.all([...this.inflight]);
  }

  getThread(threadId: string): Thread {
    return this.locate(threadId).thread;
  }

  setSubmitter(fn: (unitId: string) => Promise<unknown>): void {
    this.submitter = fn;
  }

  // ---- actions -------------------------------------------------------------

  /** Creates an unsent thread; `ask` sends it at once. */
  addDraft(unitId: string, anchor: Anchor, question: string, parentThreadId?: string): Thread {
    const unit = this.openUnit(unitId);
    this.assertNotIntegrating(unit);
    let forkFrom = unit.sessionId;
    if (parentThreadId) {
      const parent = unit.threads.find((t) => t.id === parentThreadId);
      if (!parent) throw new NotFoundError('parent thread not found');
      if (!parent.sessionId) throw new ConflictError('parent thread has no session yet');
      forkFrom = parent.sessionId;
    }
    const thread: Thread = {
      id: randomUUID(),
      unitId,
      parentThreadId: parentThreadId ?? null,
      anchor,
      forkFromSessionId: forkFrom,
      sessionId: null,
      status: 'draft',
      messages: [this.userMessage(question)],
      conclusion: null,
      noConclusion: false,
    };
    unit.threads.push(thread);
    this.threadUnit.set(thread.id, unitId);
    // The parent gains a child: it and every resolved ancestor must be concluded again.
    this.reopenChain(unit, parentThreadId ?? null);
    this.persist(unit);
    return thread;
  }

  deleteDraft(threadId: string): void {
    const { unit, thread } = this.locate(threadId);
    this.assertOpen(unit);
    this.assertNotIntegrating(unit);
    if (thread.status !== 'draft') throw new ConflictError('only draft threads can be deleted');
    unit.threads = unit.threads.filter((t) => t.id !== threadId);
    this.threadUnit.delete(threadId);
    this.persist(unit);
  }

  /** Creates a thread and sends it at once: its fork starts answering right away. */
  ask(unitId: string, anchor: Anchor, question: string, parentThreadId?: string): Thread {
    if (parentThreadId) this.assertParentIdle(this.openUnit(unitId), parentThreadId);
    const thread = this.addDraft(unitId, anchor, question, parentThreadId);
    this.sendThread(thread.id);
    return this.getThread(thread.id);
  }

  /** Sends one unsent thread (a draft left from before questions were sent at once). */
  sendThread(threadId: string): void {
    const { unit, thread } = this.locate(threadId);
    this.assertOpen(unit);
    this.assertNotIntegrating(unit);
    if (thread.status !== 'draft') throw new ConflictError('only unsent threads can be sent');
    if (thread.parentThreadId) this.assertParentIdle(unit, thread.parentThreadId);
    // The parent gains an answered child: it and every concluded ancestor must be concluded again.
    this.reopenChain(unit, thread.parentThreadId);
    thread.status = 'answering';
    this.persist(unit);
    const prompt = questionPrompt(thread.anchor, this.sourceLabel(unit, thread.anchor), thread.messages[0].content);
    this.enqueue(threadId, () => this.runAnswer(threadId, prompt, true));
  }

  followUp(threadId: string, text: string): void {
    const { unit, thread } = this.locate(threadId);
    this.assertOpen(unit);
    this.assertNotIntegrating(unit);
    if (!thread.sessionId) throw new ConflictError('thread has no session yet');
    if (thread.status === 'draft' || thread.status === 'answering') throw new ConflictError('thread is busy');
    thread.messages.push(this.userMessage(text));
    thread.status = 'answering';
    thread.conclusion = null;
    thread.noConclusion = false;
    delete thread.error;
    this.reopenChain(unit, thread.parentThreadId);
    this.persist(unit);
    this.enqueue(threadId, () => this.runAnswer(threadId, text, false));
  }

  retry(threadId: string): void {
    const { unit, thread } = this.locate(threadId);
    this.assertOpen(unit);
    this.assertNotIntegrating(unit);
    if (thread.status !== 'error') throw new ConflictError('only threads in error can be retried');
    this.reopenChain(unit, thread.parentThreadId);
    const users = thread.messages.filter((m) => m.role === 'user');
    const last = users[users.length - 1];
    if (!last) throw new ConflictError('thread has no user message');
    const prompt =
      users.length === 1 ? questionPrompt(thread.anchor, this.sourceLabel(unit, thread.anchor), last.content) : last.content;
    const fork = !thread.sessionId;
    thread.status = 'answering';
    delete thread.error;
    this.persist(unit);
    this.enqueue(threadId, () => this.runAnswer(threadId, prompt, fork));
  }

  /**
   * Starts integrating the unit's conclusions: every answered thread gets a one-line conclusion
   * (children before their parents), then the unit is submitted. Failed and unsent threads are left out.
   */
  integrate(unitId: string): void {
    const unit = this.openUnit(unitId);
    this.assertNotIntegrating(unit);
    const state = integrationState(unit);
    if (!state.canIntegrate) {
      throw new ConflictError(state.answering > 0 ? 'threads are still being answered' : 'no answered thread to integrate');
    }
    unit.integrating = true;
    delete unit.integrationError;
    this.persist(unit);
    this.advance(unitId);
  }

  // ---- internals -----------------------------------------------------------

  /** Children still to be concluded; failed and unsent children are left out and do not block. */
  private hasOpenChildren(unit: ReviewUnit, threadId: string): boolean {
    return concludableChildren(unit.threads, threadId).some((t) => t.status === 'awaiting' || t.status === 'answering');
  }

  /** Forking a parent's session while it is still writing would branch from a half-written turn. */
  private assertParentIdle(unit: ReviewUnit, parentThreadId: string): void {
    if (unit.threads.find((t) => t.id === parentThreadId)?.status === 'answering') throw new ConflictError('parent thread is busy');
  }

  private assertNotIntegrating(unit: ReviewUnit): void {
    if (unit.integrating) throw new ConflictError('conclusions are being integrated');
  }

  /** Next step of an integration: start the conclusions that are ready, or submit when all are done. */
  private advance(unitId: string): void {
    const unit = this.store.get(unitId);
    if (!unit || unit.status !== 'open' || !unit.integrating) return;
    const running = this.concluding.get(unitId) ?? 0;
    if (unit.integrationError !== undefined) {
      // A conclusion failed: start nothing new, and end once the runs still going have finished.
      if (running === 0) {
        unit.integrating = false;
        this.persist(unit);
      }
      return;
    }
    const pending = unit.threads.filter((t) => !isExcluded(t) && t.status !== 'resolved');
    if (pending.length === 0) {
      if (running > 0) return;
      unit.integrating = false;
      this.persist(unit);
      this.submit(unitId);
      return;
    }
    const ready = pending.filter((t) => t.status === 'awaiting' && !this.hasOpenChildren(unit, t.id));
    if (ready.length === 0 && running === 0) {
      unit.integrating = false;
      unit.integrationError = 'Nothing left that can be concluded';
      this.persist(unit);
      return;
    }
    for (const t of ready) this.startConclusion(unit, t);
  }

  private startConclusion(unit: ReviewUnit, thread: Thread): void {
    const childConclusions = concludableChildren(unit.threads, thread.id)
      .filter((t) => t.status === 'resolved' && t.conclusion)
      .map((t) => t.conclusion as string);
    thread.status = 'answering';
    delete thread.error;
    this.persist(unit);
    this.concluding.set(unit.id, (this.concluding.get(unit.id) ?? 0) + 1);
    const unitId = unit.id;
    const threadId = thread.id;
    // Never throws: a failed conclusion returns its thread to answered instead of to error.
    this.enqueue(threadId, async () => {
      let error: string | undefined;
      try {
        error = await this.runConclusion(threadId, conclusionPrompt(childConclusions));
      } catch (e) {
        error = (e as Error).message;
      }
      this.afterConclusion(unitId, threadId, error);
    });
  }

  private afterConclusion(unitId: string, threadId: string, error: string | undefined): void {
    const left = (this.concluding.get(unitId) ?? 1) - 1;
    if (left > 0) this.concluding.set(unitId, left);
    else this.concluding.delete(unitId);
    const unit = this.store.get(unitId);
    if (!unit || unit.status !== 'open') return;
    const thread = unit.threads.find((t) => t.id === threadId);
    if (error !== undefined || thread?.status !== 'resolved') {
      if (thread && thread.status === 'answering') thread.status = 'awaiting';
      if (unit.integrating && unit.integrationError === undefined) unit.integrationError = error ?? 'Conclusion failed';
      this.persist(unit);
    }
    this.advance(unitId);
  }

  /** Hands the integrated unit to the submitter; tracked so whenIdle waits for it. */
  private submit(unitId: string): void {
    const fail = (message: string) =>
      this.mutateUnit(unitId, (u) => {
        if (u.status === 'open') u.integrationError = message;
      });
    if (!this.submitter) {
      fail('No way to submit the conclusions');
      return;
    }
    let p: Promise<void>;
    try {
      p = this.submitter(unitId).then(
        () => {},
        (e: unknown) => fail((e as Error).message),
      );
    } catch (e) {
      fail((e as Error).message);
      return;
    }
    const tracked: Promise<void> = p.finally(() => this.inflight.delete(tracked));
    this.inflight.add(tracked);
  }

  private mutateUnit(unitId: string, fn: (u: ReviewUnit) => void): void {
    const unit = this.store.get(unitId);
    if (!unit) return;
    fn(unit);
    this.persist(unit);
  }

  /**
   * Walks from `threadId` up to the root and sends every resolved thread back to `awaiting`,
   * so a conclusion is never kept while a descendant is still being discussed.
   */
  private reopenChain(unit: ReviewUnit, threadId: string | null): void {
    const seen = new Set<string>();
    let id = threadId;
    while (id && !seen.has(id)) {
      seen.add(id);
      const t = unit.threads.find((x) => x.id === id);
      if (!t) return;
      if (t.status === 'resolved') {
        t.status = 'awaiting';
        t.conclusion = null;
        t.noConclusion = false;
      }
      id = t.parentThreadId;
    }
  }

  private userMessage(content: string): Message {
    return { id: randomUUID(), role: 'user', content, createdAt: new Date().toISOString() };
  }

  private sourceLabel(unit: ReviewUnit, anchor: Anchor): string {
    if (anchor.sourceId === unit.reply.id) return 'agent reply';
    if (anchor.sourceId.startsWith('msg:')) return 'earlier answer in this review thread';
    const file = unit.files.find((f) => f.id === anchor.sourceId);
    if (file) return `file ${file.path ?? ''}`;
    return 'agent reply';
  }

  private loadUnit(unitId: string): ReviewUnit {
    const unit = this.store.get(unitId);
    if (!unit) throw new NotFoundError('unit not found');
    return unit;
  }

  private openUnit(unitId: string): ReviewUnit {
    const unit = this.loadUnit(unitId);
    this.assertOpen(unit);
    return unit;
  }

  private assertOpen(unit: ReviewUnit): void {
    if (unit.status !== 'open') throw new ConflictError(`unit is ${unit.status}`);
  }

  private locate(threadId: string): { unit: ReviewUnit; thread: Thread } {
    const unitId = this.threadUnit.get(threadId);
    if (!unitId) throw new NotFoundError('thread not found');
    const unit = this.loadUnit(unitId);
    const thread = unit.threads.find((t) => t.id === threadId);
    if (!thread) throw new NotFoundError('thread not found');
    return { unit, thread };
  }

  private persist(unit: ReviewUnit): void {
    this.store.save(unit);
    this.bus.emit({ type: 'unit.updated', unitId: unit.id, sessionId: unit.sessionId });
  }

  /** Load-modify-save of one thread; silently ignored if it has vanished. */
  private mutate(threadId: string, fn: (t: Thread, u: ReviewUnit) => void): void {
    const unitId = this.threadUnit.get(threadId);
    if (!unitId) return;
    const unit = this.store.get(unitId);
    const thread = unit?.threads.find((t) => t.id === threadId);
    if (!unit || !thread) return;
    fn(thread, unit);
    this.persist(unit);
  }

  private enqueue(threadId: string, job: Job): Promise<void> {
    const p: Promise<void> = this.withSlot(job)
      .catch((e) => this.fail(threadId, (e as Error).message))
      .catch((e) => console.error(`[threads] run bookkeeping failed for ${threadId}: ${(e as Error).message}`))
      .finally(() => this.inflight.delete(p));
    this.inflight.add(p);
    return p;
  }

  private async withSlot(job: Job): Promise<void> {
    if (this.active >= this.concurrency) await new Promise<void>((r) => this.waiting.push(r));
    else this.active++;
    try {
      await job();
    } finally {
      const next = this.waiting.shift();
      if (next) next();
      else this.active--;
    }
  }

  /** Status-changing mutation; skipped for expired threads and non-open units. */
  private mutateStatus(threadId: string, fn: (t: Thread, u: ReviewUnit) => void): void {
    this.mutate(threadId, (t, u) => {
      if (t.status === 'expired' || u.status !== 'open') return;
      fn(t, u);
    });
  }

  private fail(threadId: string, message: string): void {
    this.mutateStatus(threadId, (t) => {
      t.status = 'error';
      t.error = message;
    });
  }

  /** Runs the adapter bracketed by git-status checks, feeding events to the handler. */
  private async runAgent(threadId: string, prompt: string, fork: boolean, onEvent: (e: AgentEvent) => void): Promise<void> {
    const { unit, thread } = this.locate(threadId);
    // The unit may have been superseded while this job waited for a slot.
    if (unit.status !== 'open' || thread.status === 'expired') return;
    const adapter = this.adapters[unit.agent];
    if (!adapter) throw new Error(`No adapter for agent '${unit.agent}' yet`);
    const parentSessionId = fork ? thread.forkFromSessionId : (thread.sessionId as string);
    const ctl = new AbortController();
    this.runs.set(threadId, ctl);
    const timer = setTimeout(() => ctl.abort(TIMEOUT), this.runTimeoutMs);
    // Settles only on abort, so a hung adapter (one that ignores its signal) cannot hold the slot.
    const aborted = new Promise<never>((_, reject) => {
      ctl.signal.addEventListener('abort', () => reject(ctl.signal.reason), { once: true });
    });
    aborted.catch(() => {});
    const before = await this.snapshot(unit.cwd);
    try {
      const it = adapter.run({ parentSessionId, fork, prompt, cwd: unit.cwd }, ctl.signal)[Symbol.asyncIterator]();
      try {
        for (;;) {
          const next = it.next();
          next.catch(() => {});
          const r = await Promise.race([next, aborted]);
          if (r.done) break;
          onEvent(r.value);
        }
      } catch (e) {
        if (!ctl.signal.aborted) throw e;
        // Do not wait for the generator: a hung one would never finish its cleanup.
        it.return?.(undefined)?.catch(() => {});
        if (ctl.signal.reason === TIMEOUT) throw new Error(`Timed out after ${formatMinutes(this.runTimeoutMs)} min`);
      }
    } finally {
      clearTimeout(timer);
      if (this.runs.get(threadId) === ctl) this.runs.delete(threadId);
      const after = await this.snapshot(unit.cwd);
      if (before !== null && after !== null) {
        const paths = changedPaths(before, after);
        if (paths.length) {
          this.mutate(threadId, (_t, u) => {
            u.warnings.push({ at: new Date().toISOString(), threadId, paths });
          });
        }
      }
    }
  }

  private async snapshot(cwd: string): Promise<Fingerprints | null> {
    try {
      const probe = await (this.opts.gitStatus ?? defaultGitStatus)(cwd);
      return probe === null ? null : fingerprint(probe, this.opts.statPath ?? defaultStat);
    } catch {
      return null;
    }
  }

  private async runAnswer(threadId: string, prompt: string, fork: boolean): Promise<void> {
    const texts: string[] = [];
    let messageId: string | null = null;
    let finished = false;
    const setContent = (content: string) => {
      this.mutate(threadId, (t) => {
        let m = messageId ? t.messages.find((x) => x.id === messageId) : undefined;
        if (!m) {
          m = { id: randomUUID(), role: 'assistant', content: '', createdAt: new Date().toISOString() };
          messageId = m.id;
          t.messages.push(m);
        }
        m.content = content;
        m.blocks = splitBlocks(content, 'markdown');
      });
    };
    await this.runAgent(threadId, prompt, fork, (ev) => {
      if (finished) return;
      if (ev.type === 'session') {
        this.forkSessions.add(ev.sessionId);
        this.mutate(threadId, (t) => {
          t.sessionId = ev.sessionId;
        });
      } else if (ev.type === 'text') {
        texts.push(ev.text);
        setContent(texts.join('\n\n'));
      } else if (ev.type === 'done') {
        finished = true;
        setContent(ev.finalText);
        this.mutateStatus(threadId, (t) => {
          t.status = 'awaiting';
        });
      } else if (ev.type === 'error') {
        finished = true;
        this.fail(threadId, ev.message);
      }
    });
    if (!finished && this.getThread(threadId).status === 'answering') {
      this.fail(threadId, 'Agent ended without a final answer');
    }
  }

  /** Runs one conclusion; returns the error message when it did not produce one. */
  private async runConclusion(threadId: string, prompt: string): Promise<string | undefined> {
    let finished = false;
    let error: string | undefined;
    await this.runAgent(threadId, prompt, false, (ev) => {
      if (finished) return;
      if (ev.type === 'session') {
        this.forkSessions.add(ev.sessionId);
      } else if (ev.type === 'done') {
        finished = true;
        const first = ev.finalText.trim().split(/\r?\n/)[0] ?? '';
        this.mutateStatus(threadId, (t, u) => {
          // A child was added while the conclusion ran: the conclusion is already outdated.
          if (this.hasOpenChildren(u, threadId)) {
            t.status = 'awaiting';
            t.conclusion = null;
            t.noConclusion = false;
            return;
          }
          t.conclusion = first;
          t.noConclusion = false;
          t.status = 'resolved';
        });
      } else if (ev.type === 'error') {
        finished = true;
        error = ev.message;
      }
    });
    if (!finished) return 'Agent ended without a conclusion';
    return error;
  }
}
