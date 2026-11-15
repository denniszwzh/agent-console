import { pathToFileURL } from 'node:url';
import { buildApp } from './app.js';
import { UnitStore } from './store.js';
import { ensureToken, readConfig, writeServerInfo } from './paths.js';

export async function start(): Promise<void> {
  const config = readConfig();
  const token = ensureToken();
  const app = buildApp({ store: new UnitStore(), token, port: config.port });
  await app.listen({ host: '127.0.0.1', port: config.port });
  writeServerInfo(config.port);
  console.log(`Agent Console running at http://127.0.0.1:${config.port}/auth?token=${token}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  start().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
