import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildApp } from '../../src/server/app.js';
import { EventBus } from '../../src/server/events.js';
import { UnitStore } from '../../src/server/store.js';
import { ThreadEngine } from '../../src/server/threads.js';
import type { ReviewUnit } from '../../src/shared/types.js';

const TOKEN = 'secret-token';
const HOST = '127.0.0.1:4317';
const headers = { host: HOST, authorization: `Bearer ${TOKEN}` };
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);

let home: string;
let work: string;
let prev: string | undefined;
beforeEach(() => {
  prev = process.env.AGENT_CONSOLE_HOME;
  home = mkdtempSync(join(tmpdir(), 'ac-files-'));
  work = join(home, 'work');
  mkdirSync(join(work, 'img'), { recursive: true });
  process.env.AGENT_CONSOLE_HOME = home;
});
afterEach(() => {
  if (prev === undefined) delete process.env.AGENT_CONSOLE_HOME;
  else process.env.AGENT_CONSOLE_HOME = prev;
  rmSync(home, { recursive: true, force: true });
});

function setup(over: Partial<ReviewUnit> = {}) {
  const store = new UnitStore();
  const bus = new EventBus();
  const engine = new ThreadEngine(store, bus, {}, 1, { gitStatus: async () => null });
  const unit: ReviewUnit = {
    id: 'unit-1',
    agent: 'claude',
    sessionId: 'main-sess',
    cwd: work,
    createdAt: new Date().toISOString(),
    reply: { id: 'reply-1', kind: 'reply', content: 'See ![diagram](img/ok.png) and ![doc](notes.txt).', blocks: [] },
    files: [],
    threads: [],
    status: 'open',
    delivered: false,
    warnings: [],
    ...over,
  };
  store.save(unit);
  const events: string[] = [];
  bus.subscribe((e) => events.push(`${e.type}:${e.unitId}`));
  return { app: buildApp({ store, token: TOKEN, port: 4317, bus, engine }), store, events };
}

const imageUrl = (p: string) => `/api/units/unit-1/image?path=${encodeURIComponent(p)}`;

describe('GET /api/units/:id/image', () => {
  it('image endpoint rejects paths not referenced by the unit', async () => {
    writeFileSync(join(work, 'img', 'ok.png'), PNG);
    writeFileSync(join(work, 'img', 'secret.png'), PNG);
    writeFileSync(join(work, 'notes.txt'), 'text');
    const { app } = setup();
    expect((await app.inject({ method: 'GET', url: imageUrl('img/secret.png'), headers })).statusCode).toBe(404);
    // Referenced, but not an image extension.
    expect((await app.inject({ method: 'GET', url: imageUrl('notes.txt'), headers })).statusCode).toBe(404);
    expect((await app.inject({ method: 'GET', url: '/api/units/unit-1/image', headers })).statusCode).toBe(404);
    expect((await app.inject({ method: 'GET', url: '/api/units/nope/image?path=img%2Fok.png', headers })).statusCode).toBe(404);
    // Referenced image is served, and only with a token.
    const ok = await app.inject({ method: 'GET', url: imageUrl('img/ok.png'), headers });
    expect(ok.statusCode).toBe(200);
    expect(ok.headers['content-type']).toBe('image/png');
    expect(ok.headers['x-content-type-options']).toBe('nosniff');
    expect(ok.rawPayload.equals(PNG)).toBe(true);
    expect((await app.inject({ method: 'GET', url: imageUrl('img/ok.png'), headers: { host: HOST } })).statusCode).toBe(401);
  });

  it('serves image files of the unit and images referenced by markdown files and answers', async () => {
    writeFileSync(join(work, 'shot.png'), PNG);
    writeFileSync(join(work, 'img', 'a.svg'), '<svg xmlns="http://www.w3.org/2000/svg"/>');
    writeFileSync(join(work, 'img', 'b.gif'), 'GIF89a');
    const { app } = setup({
      files: [
        { id: 'f1', kind: 'file', path: 'shot.png', content: '', blocks: [], image: true, binary: true },
        { id: 'f2', kind: 'file', path: 'doc.md', content: '# Doc\n\n![a](img/a.svg)', blocks: [], language: 'md' },
      ],
      threads: [
        {
          id: 't1', unitId: 'unit-1', parentThreadId: null,
          anchor: { sourceId: 'reply-1', blockId: 'b', quote: 'q', headingPath: [], startLine: 1, endLine: 1 },
          forkFromSessionId: 'main-sess', sessionId: 's1', status: 'awaiting', conclusion: null, noConclusion: false,
          messages: [{ id: 'm1', role: 'assistant', content: 'Look: ![b](img/b.gif)', createdAt: '' }],
        },
      ],
    });
    const png = await app.inject({ method: 'GET', url: imageUrl('shot.png'), headers });
    expect(png.statusCode).toBe(200);
    const svg = await app.inject({ method: 'GET', url: imageUrl('img/a.svg'), headers });
    expect(svg.statusCode).toBe(200);
    expect(svg.headers['content-type']).toBe('image/svg+xml');
    expect(svg.headers['content-security-policy']).toBe('sandbox');
    expect(svg.headers['x-content-type-options']).toBe('nosniff');
    const gif = await app.inject({ method: 'GET', url: imageUrl('img/b.gif'), headers });
    expect(gif.statusCode).toBe(200);
    expect(gif.headers['content-type']).toBe('image/gif');
  });

  it('refuses UNC and URL references even when referenced', async () => {
    const { app } = setup({
      reply: {
        id: 'reply-1', kind: 'reply', blocks: [],
        content: '![a](\\\\evil\\share\\x.png) ![b](//evil/share/y.png) ![c](https://example.com/z.png) ![d](img/missing.png)',
      },
    });
    for (const p of ['\\\\evil\\share\\x.png', '//evil/share/y.png', 'https://example.com/z.png', 'img/missing.png']) {
      expect((await app.inject({ method: 'GET', url: imageUrl(p), headers })).statusCode).toBe(404);
    }
  });
});

describe('POST /api/units/:id/files', () => {
  it('add file rejected on stale unit', async () => {
    writeFileSync(join(work, 'a.md'), '# A');
    const { app, store } = setup({ status: 'stale' });
    const res = await app.inject({ method: 'POST', url: '/api/units/unit-1/files', headers, payload: { path: 'a.md' } });
    expect(res.statusCode).toBe(409);
    expect(store.get('unit-1')!.files).toHaveLength(0);
  });

  it('snapshots a file relative to the unit cwd and appends it', async () => {
    writeFileSync(join(work, 'a.md'), '# A\n\nbody');
    const { app, store, events } = setup();
    const res = await app.inject({ method: 'POST', url: '/api/units/unit-1/files', headers, payload: { path: 'a.md' } });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ kind: 'file', path: 'a.md', content: '# A\n\nbody' });
    const files = store.get('unit-1')!.files;
    expect(files).toHaveLength(1);
    expect(files[0].blocks.length).toBe(2);
    expect(events).toContain('unit.updated:unit-1');
  });

  it('validates the body and the unit', async () => {
    const { app } = setup();
    expect((await app.inject({ method: 'POST', url: '/api/units/unit-1/files', headers, payload: {} })).statusCode).toBe(400);
    expect((await app.inject({ method: 'POST', url: '/api/units/unit-1/files', headers, payload: { path: '  ' } })).statusCode).toBe(400);
    expect((await app.inject({ method: 'POST', url: '/api/units/nope/files', headers, payload: { path: 'a.md' } })).statusCode).toBe(404);
    expect((await app.inject({ method: 'POST', url: '/api/units/unit-1/files', headers: { host: HOST }, payload: { path: 'a.md' } })).statusCode).toBe(401);
  });
});

describe('static web UI', () => {
  it('serves index.html from the web root without a token', async () => {
    const webRoot = join(home, 'web');
    mkdirSync(webRoot);
    writeFileSync(join(webRoot, 'index.html'), '<!doctype html><title>Agent Console</title>');
    const app = buildApp({ store: new UnitStore(), token: TOKEN, port: 4317, webRoot });
    const res = await app.inject({ method: 'GET', url: '/', headers: { host: HOST } });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('Agent Console');
    expect(res.headers['content-security-policy']).toContain("default-src 'self'");
    expect((await app.inject({ method: 'GET', url: '/', headers: { host: 'evil.com' } })).statusCode).toBe(403);
    expect((await app.inject({ method: 'GET', url: '/api/sessions', headers: { host: HOST } })).statusCode).toBe(401);
  });
});
