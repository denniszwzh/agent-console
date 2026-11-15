import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import type { AgentAdapter, AgentEvent } from '../agents/adapter.js';
import { splitBlocks } from '../shared/blocks.js';
import type { AgentKind, Anchor, Message, ReviewUnit, Thread } from '../shared/types.js';
import type { EventBus } from './events.js';
import { conclusionPrompt, questionPrompt } from './prompts.js';
import type { UnitStore } from './store.js';

export class ConflictError extends Error {}
export class NotFoundError extends Error {}
export class ValidationError extends Error {}

export interface ThreadEngineOptions {
  gitStatus?: (cwd: string) => Promise<string | null>;
}

function defaultGitStatus(cwd: string): Promise<string | null> {
  return new Promise((resolve) => {
    execFile('git', ['status', '--porcelain'], { cwd, windowsHide: true, maxBuffer: 16 * 1024 * 1024 }, (err, stdout) => {
      resolve(err ? null : stdout);
    });
  });
}

/** Parse `git status --porcelain` output into a map of line -> path. */
function parsePorcelain(out: string): Map<string, string> {
  const map = new Map<string, string>();
  for (const line of out.split(/\r?\n/)) {
    if (!line.trim()) continue;
    let p = line.slice(3);
    const arrow = p.indexOf(' -> ');
    if (arrow >= 0) p = p.slice(arrow + 4);
    if (p.length >= 2 && p.startsWith('"') && p.endsWith('"')) p = p.slice(1, -1);
    map.set(line, p);
  }
  return map;
}

function changedPaths(before: string, after: string): string[] {
  const b = parsePorcelain(before);
  const a = parsePorcelain(after);
  const paths = new Set<string>();
  for (const [line, p] of a) if (!b.has(line)) paths.add(p);
  for (const [line, p] of b) if (!a.has(line)) paths.add(p);
  return [...paths].sort();
}

type Job = () => Promise<void>;

export class ThreadEngine {
  private forkSessions = new Set<string>();
  private threadUnit = new Map<string, string>();
  private active = 0;
  private waiting: (() => void)[] = [];
  private inflight = new Set<Promise<void>>();

  constructor(
    private store: UnitStore,
    private bus: EventBus,
    private adapters: Partial<Record<AgentKind, AgentAdapter>>,
    private concurrency: number,
    private opts: ThreadEngineOptions = {},
  ) {
    for (const s of store.listSessions()) {
      for (const u of store.listBySession(s.sessionId)) {
        for (const t of u.threads) {
          this.threadUnit.set(t.id, u.id);
          if (t.sessionId) this.forkSessions.add(t.sessionId);
        }
      }
    }
  }

  isForkSession(sessionId: string): boolean {
    return this.forkSessions.has(sessionId);
  }

  /** Resolves once every queued or running branch has finished. */
  async whenIdle(): Promise<void> {
    while (this.inflight.size) await Promise.all([...this.inflight]);
  }

  getThread(threadId: string): Thread {
    return this.locate(threadId).thread;
  }

  canSubmit(unitId: string): boolean {
    const unit = this.loadUnit(unitId);
    return unit.status === 'open' && unit.threads.length > 0 && unit.threads.every((t) => t.status === 'resolved');
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
    this.persist(unit);
    this.enqueue(threadId, () => this.runAnswer(threadId, text, false));
  }

  retry(threadId: string): void {
    const { unit, thread } = this.locate(threadId);
    this.assertOpen(unit);
    if (thread.status !== 'error') throw new ConflictError('only threads in error can be retried');
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
    if (unit.threads.some((t) => t.parentThreadId === threadId && t.status !== 'resolved')) {
      throw new ConflictError('child threads must be resolved first');
    }
  }

  async resolve(threadId: string): Promise<void> {
    this.checkResolvable(threadId);
    const { unit, thread } = this.locate(threadId);
    const childConclusions = unit.threads
      .filter((t) => t.parentThreadId === threadId && t.conclusion)
      .map((t) => t.conclusion as string);
    thread.status = 'answering';
    delete thread.error;
    this.persist(unit);
    await this.enqueue(threadId, () => this.runConclusion(threadId, conclusionPrompt(childConclusions)));
  }

  setConclusion(threadId: string, conclusion: string | null): void {
    const { unit, thread } = this.locate(threadId);
    this.assertOpen(unit);
    if (thread.status === 'answering') throw new ConflictError('thread is busy');
    thread.conclusion = conclusion;
    thread.noConclusion = conclusion === null;
    thread.status = 'resolved';
    delete thread.error;
    this.persist(unit);
  }

  // ---- internals -----------------------------------------------------------

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

  private fail(threadId: string, message: string): void {
    this.mutate(threadId, (t) => {
      t.status = 'error';
      t.error = message;
    });
  }

  /** Runs the adapter bracketed by git-status checks, feeding events to the handler. */
  private async runAgent(threadId: string, prompt: string, fork: boolean, onEvent: (e: AgentEvent) => void): Promise<void> {
    const { unit, thread } = this.locate(threadId);
    const adapter = this.adapters[unit.agent];
    if (!adapter) {
      this.fail(threadId, `No adapter for agent '${unit.agent}' yet`);
      return;
    }
    const parentSessionId = fork ? thread.forkFromSessionId : (thread.sessionId as string);
    const before = await this.safeGit(unit.cwd);
    try {
      for await (const ev of adapter.run({ parentSessionId, fork, prompt, cwd: unit.cwd })) onEvent(ev);
    } finally {
      const after = await this.safeGit(unit.cwd);
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

  private async safeGit(cwd: string): Promise<string | null> {
    try {
      return await (this.opts.gitStatus ?? defaultGitStatus)(cwd);
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
        this.mutate(threadId, (t) => {
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
        this.mutate(threadId, (t) => {
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
