import { pathToFileURL } from 'node:url';
import { createClaudeAdapter } from '../agents/claude.js';
import { createCodexAdapter } from '../agents/codex.js';
import { buildApp } from './app.js';
import { EventBus } from './events.js';
import { PromptBackfill } from './prompt-backfill.js';
import { SessionMetaService, defaultSessionMetaOptions } from './session-meta.js';
import { UnitStore } from './store.js';
import { ThreadEngine } from './threads.js';
import { ensureToken, readConfig, writeServerInfo } from './paths.js';

export async function start(): Promise<void> {
  const config = readConfig();
  const token = ensureToken();
  const store = new UnitStore();
  const bus = new EventBus();
  const engine = new ThreadEngine(store, bus, { claude: createClaudeAdapter(), codex: createCodexAdapter() }, config.concurrency, {
    runTimeoutMs: config.runTimeoutMs,
  });
  const sessionMeta = new SessionMetaService(defaultSessionMetaOptions());
  const app = buildApp({ store, token, port: config.port, bus, engine, sessionMeta });
  await app.listen({ host: '127.0.0.1', port: config.port });
  writeServerInfo(config.port);
  // Earlier replies get their prompts from the transcripts, in the background.
  new PromptBackfill(store, bus, (agent, sessionId, known) => sessionMeta.transcriptFor(agent, sessionId, known)).start();
  console.log(`Agent Console running at http://127.0.0.1:${config.port}/auth?token=${token}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  start().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
