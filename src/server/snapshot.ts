import { randomUUID } from 'node:crypto';
import { closeSync, openSync, readSync } from 'node:fs';
import { extname, resolve } from 'node:path';
import type { Source } from '../shared/types.js';
import { splitBlocks } from '../shared/blocks.js';
import { IMAGE_EXTENSIONS } from '../shared/images.js';

export const MAX_SNAPSHOT_BYTES = 1_048_576;

export function takeSnapshot(filePath: string, cwd: string): Source {
  const ext = extname(filePath).slice(1).toLowerCase();
  const source: Source = {
    id: randomUUID(),
    kind: 'file',
    path: filePath,
    content: '',
    blocks: [],
    language: ext || undefined,
  };
  const isImage = IMAGE_EXTENSIONS.has(ext);
  if (isImage) source.image = true;

  let buf: Buffer;
  try {
    // Read at most one byte past the limit: a huge file must not be loaded whole.
    const fd = openSync(resolve(cwd, filePath), 'r');
    try {
      const chunk = Buffer.alloc(MAX_SNAPSHOT_BYTES + 1);
      let n = 0;
      while (n < chunk.length) {
        const r = readSync(fd, chunk, n, chunk.length - n, n);
        if (r === 0) break;
        n += r;
      }
      buf = chunk.subarray(0, n);
    } finally {
      closeSync(fd);
    }
  } catch (err) {
    source.error = err instanceof Error ? err.message : String(err);
    return source;
  }

  if (buf.length > MAX_SNAPSHOT_BYTES) {
    source.truncated = true;
    buf = buf.subarray(0, MAX_SNAPSHOT_BYTES);
  }
  if (buf.subarray(0, 8192).includes(0) || (isImage && ext !== 'svg')) {
    source.binary = true;
    return source;
  }

  source.content = buf.toString('utf8');
  source.blocks = splitBlocks(source.content, ext === 'md' || ext === 'markdown' ? 'markdown' : 'text');
  return source;
}
