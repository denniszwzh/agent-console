import fs from 'node:fs';
import { codexInstruction, type CodexQueueRunner } from '../agents/codex.js';
import { buildConclusionBundle } from './conclusion.js';
import type { EventBus } from './events.js';
import { conclusionFile } from './paths.js';
import type { UnitStore } from './store.js';
import { ConflictError, NotFoundError } from './threads.js';

export interface SubmitDeps {
  store: UnitStore;
  bus: EventBus;
  codexQueue: CodexQueueRunner;
}

/**
 * Hands a unit's conclusions back to the main session: writes the bundle file and marks the unit
 * submitted (Claude's prompt hook injects it into the next prompt). For Codex the instruction is also
 * queued once, best effort.
 */
export async function submitUnit(deps: SubmitDeps, unitId: string): Promise<{ bundle: string; queued: boolean }> {
  const { store, bus, codexQueue } = deps;
  const unit = store.get(unitId);
  if (!unit) throw new NotFoundError('unit not found');
  if (unit.status !== 'open') throw new ConflictError(`unit is ${unit.status}`);
  const bundle = buildConclusionBundle(unit);
  const file = conclusionFile(unitId);
  fs.writeFileSync(file, bundle);
  // Marked submitted before any await, so a second submit finds it no longer open.
  unit.status = 'submitted';
  unit.delivered = false;
  unit.conclusionsPath = file;
  store.save(unit);
  bus.emit({ type: 'unit.updated', unitId, sessionId: unit.sessionId });
  let queued = false;
  if (unit.agent === 'codex') {
    // Best effort: the UI always offers a copy button too; a queue failure never fails the submit.
    const instruction = codexInstruction(file);
    queued = await codexQueue(unit.sessionId, instruction).catch(() => false);
    const fresh = store.get(unitId) ?? unit;
    fresh.delivery = { queued, instruction };
    store.save(fresh);
    bus.emit({ type: 'unit.updated', unitId, sessionId: fresh.sessionId });
  }
  return { bundle, queued };
}
