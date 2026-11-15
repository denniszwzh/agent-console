import { randomUUID } from 'node:crypto';
import type { AgentAdapter, AgentEvent } from '../agents/adapter.js';
import { splitBlocks } from '../shared/blocks.js';
import { canSubmit as canSubmitUnit } from '../shared/gate.js';
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
  /** Threads whose last failure happened in an answer run (not the conclusion run). */
  private answerFailed = new Set<string>();
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

  canSubmit(unitId: string): boolean {
    return canSubmitUnit(this.loadUnit(unitId));
  }

  // ---- actions -------------------------------------------------------------

  addDraft(unitId: string, anchor: Anchor, question: string, parentThreadId?: string): Thread {
    const unit = this.openUnit(unitId);
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
    if (thread.status !== 'draft') throw new ConflictError('only draft threads can be deleted');
    unit.threads = unit.threads.filter((t) => t.id !== threadId);
    this.threadUnit.delete(threadId);
    this.persist(unit);
  }

  sendDrafts(unitId: string): void {
    const unit = this.openUnit(unitId);
    const drafts = unit.threads.filter((t) => t.status === 'draft');
    if (!drafts.length) return;
    for (const t of drafts) t.status = 'answering';
    this.persist(unit);
    for (const t of drafts) {
      const prompt = questionPrompt(t.anchor, this.sourceLabel(unit, t.anchor), t.messages[0].content);
      this.enqueue(t.id, () => this.runAnswer(t.id, prompt, true));
    }
  }

  followUp(threadId: string, text: string): void {
    const { unit, thread } = this.locate(threadId);
    this.assertOpen(unit);
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
    if (thread.status !== 'error') throw new ConflictError('only threads in error can be retried');
    this.reopenChain(unit, thread.parentThreadId);
    const lastMsg = thread.messages[thread.messages.length - 1];
    if (lastMsg?.role === 'assistant' && thread.sessionId && !this.answerFailed.has(threadId)) {
      // The failure happened in the conclusion run: re-run it.
      this.startConclusion(unit, thread);
      return;
    }
    this.answerFailed.delete(threadId);
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

  /** Throws ConflictError when the thread cannot be resolved right now. */
  checkResolvable(threadId: string): void {
    const { unit, thread } = this.locate(threadId);
    this.assertOpen(unit);
    if (!thread.sessionId) throw new ConflictError('thread has no session yet');
    if (thread.status === 'draft' || thread.status === 'answering') throw new ConflictError('thread is busy');
    if (this.hasOpenChildren(unit, threadId)) throw new ConflictError('child threads must be resolved first');
  }

  async resolve(threadId: string): Promise<void> {
    this.checkResolvable(threadId);
    const { unit, thread } = this.locate(threadId);
    await this.startConclusion(unit, thread);
  }

  private startConclusion(unit: ReviewUnit, thread: Thread): Promise<void> {
    const childConclusions = unit.threads
      .filter((t) => t.parentThreadId === thread.id && t.conclusion)
      .map((t) => t.conclusion as string);
    thread.status = 'answering';
    delete thread.error;
    this.persist(unit);
    return this.enqueue(thread.id, () => this.runConclusion(thread.id, conclusionPrompt(childConclusions)));
  }

  setConclusion(threadId: string, conclusion: string | null): void {
    const { unit, thread } = this.locate(threadId);
    this.assertOpen(unit);
    if (thread.status === 'answering') throw new ConflictError('thread is busy');
    if (thread.status === 'draft') throw new ConflictError('draft threads cannot be concluded');
    if (this.hasOpenChildren(unit, threadId)) throw new ConflictError('child threads must be resolved first');
    thread.conclusion = conclusion;
    thread.noConclusion = conclusion === null;
    thread.status = 'resolved';
    delete thread.error;
    this.persist(unit);
  }

  // ---- internals -----------------------------------------------------------

  private hasOpenChildren(unit: ReviewUnit, threadId: string): boolean {
    return unit.threads.some((t) => t.parentThreadId === threadId && t.status !== 'resolved');
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
    if (!adapter) {
      this.fail(threadId, `No adapter for agent '${unit.agent}' yet`);
      return;
    }
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
    // Any way this run fails (error event, throw, timeout) counts as an answer failure.
    this.answerFailed.add(threadId);
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
        this.answerFailed.delete(threadId);
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

  private async runConclusion(threadId: string, prompt: string): Promise<void> {
    let finished = false;
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
        this.fail(threadId, ev.message);
      }
    });
    if (!finished && this.getThread(threadId).status === 'answering') {
      this.fail(threadId, 'Agent ended without a conclusion');
    }
  }
}
