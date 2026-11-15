import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { readJsonl } from '../../src/server/jsonl.js';

describe('readJsonl', () => {
  it('parses object lines, skipping blank, malformed and non-object lines (CRLF tolerated)', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ac-jsonl-'));
    try {
      const file = path.join(dir, 'a.jsonl');
      fs.writeFileSync(file, ['{"a":1}', '', 'garbage', '42', 'null', '{"b":2}'].join('\r\n'));
      expect(readJsonl(file)).toEqual([{ a: 1 }, { b: 2 }]);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('returns [] for a missing file', () => {
    expect(readJsonl(path.join(os.tmpdir(), 'ac-missing-file.jsonl'))).toEqual([]);
  });
});
