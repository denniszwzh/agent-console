import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { applyChange } from '../../src/cli/main.js';
import { addHooks, removeHooks } from '../../src/cli/settings-merge.js';

const cmds = {
  Stop: 'node "C:\\x\\agent-console\\dist\\hooks\\claude-stop.js"',
  UserPromptSubmit: 'node "C:\\x\\agent-console\\dist\\hooks\\claude-prompt.js"',
};
let dir: string;
let file: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ac-cli-'));
  file = path.join(dir, 'settings.json');
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

const quiet = () => {};
const orig = { hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'node p.js' }] }] } };

describe('applyChange (temp settings file only)', () => {
  it('aborts without writing when not confirmed', async () => {
    fs.writeFileSync(file, JSON.stringify(orig));
    const changed = await applyChange(file, (s) => addHooks(s, cmds), async () => false, quiet);
    expect(changed).toBe(false);
    expect(JSON.parse(fs.readFileSync(file, 'utf8'))).toEqual(orig);
    expect(fs.readdirSync(dir)).toEqual(['settings.json']);
  });

  it('writes a backup then the new file; uninstall restores', async () => {
    fs.writeFileSync(file, JSON.stringify(orig));
    expect(await applyChange(file, (s) => addHooks(s, cmds), async () => true, quiet)).toBe(true);
    const backups = fs.readdirSync(dir).filter((f) => f.startsWith('settings.json.agent-console-backup-'));
    expect(backups).toHaveLength(1);
    expect(JSON.parse(fs.readFileSync(path.join(dir, backups[0]), 'utf8'))).toEqual(orig);
    expect(JSON.parse(fs.readFileSync(file, 'utf8'))).toEqual(addHooks(orig, cmds));
    await applyChange(file, removeHooks, async () => true, quiet);
    expect(JSON.parse(fs.readFileSync(file, 'utf8'))).toEqual(orig);
  });

  it('treats a missing file as {}', async () => {
    await applyChange(file, (s) => addHooks(s, cmds), async () => true, quiet);
    expect(JSON.parse(fs.readFileSync(file, 'utf8'))).toEqual(addHooks({}, cmds));
  });
});
