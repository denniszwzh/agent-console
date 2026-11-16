import type { AgentKind } from '../shared/types.js';
import type { EventBus } from './events.js';
import type { UnitStore } from './store.js';
import { promptsInWindow, readUserPrompts, type PromptReader } from './turn-prompts.js';

export type TranscriptLocator = (agent: AgentKind, sessionId: string, knownPath?: string) => string | undefined;

/**
 * Adds the user's prompts to replies saved before prompts were recorded (or whose transcript could not
 * be read at the time). Runs in the background, one session at a time, newest replies first; each
 * transcript is read once per session.
 */
export class PromptBackfill {
  constructor(
    private readonly store: UnitStore,
    private readonly bus: EventBus,
    private readonly locate: TranscriptLocator,
    private readonly read: PromptReader = readUserPrompts,
  ) {}

  /** Fills every unit that has no prompts yet; returns how many units were updated. */
  async runOnce(): Promise<number> {
    let updated = 0;
    for (const session of this.store.listSessions()) {
      const units = this.store.listBySession(session.sessionId);
      if (!units.some((u) => u.prompts === undefined)) continue;
      const file = this.locate(session.agent, session.sessionId, this.store.transcriptPathFor(session.sessionId));
      const all = file ? await this.read(session.agent, file) : [];
      // Unreadable for now (not missing): try again on the next run.
      if (all !== null) {
        // Synchronous from here: thread runs save these units too, and their changes must not be lost.
        units.forEach((u, i) => {
          const fresh = this.store.get(u.id);
          if (!fresh || fresh.prompts !== undefined) return;
          const { prompts, omitted } = promptsInWindow(all, i === 0 ? undefined : units[i - 1].createdAt, fresh.createdAt);
          fresh.prompts = prompts;
          if (omitted > 0) fresh.promptsOmitted = omitted;
          this.store.save(fresh);
          this.bus.emit({ type: 'unit.updated', unitId: fresh.id, sessionId: fresh.sessionId });
          updated++;
        });
      }
      await new Promise((resolve) => setImmediate(resolve));
    }
    return updated;
  }

  /** Runs once in the background; failures are logged, never thrown. */
  start(): void {
    this.runOnce().catch((e: unknown) => console.warn(`[backfill] prompt backfill stopped: ${(e as Error).message}`));
  }
}
