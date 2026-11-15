import { describe, expect, it } from 'vitest';
import { addHooks, assertRecognisable, removeHooks } from '../../src/cli/settings-merge.js';

const cmds = {
  Stop: 'node "C:\\x\\agent-console\\dist\\hooks\\claude-stop.js"',
  UserPromptSubmit: 'node "C:\\x\\agent-console\\dist\\hooks\\claude-prompt.js"',
};

function fixture() {
  return {
    model: 'x',
    hooks: {
      PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'node pre.js' }] }],
      PostToolUse: [{ matcher: 'Edit', hooks: [{ type: 'command', command: 'node post.js' }] }],
      SubagentStart: [{ hooks: [{ type: 'command', command: 'node a.js' }] }],
      SubagentStop: [{ hooks: [{ type: 'command', command: 'node b.js' }] }],
      PreCompact: [{ hooks: [{ type: 'command', command: 'node c.js' }] }],
      Stop: [{ hooks: [{ type: 'command', command: 'node other-stop.js' }] }],
    },
  };
}

describe('settings-merge', () => {
  it('addHooks preserves existing hooks', () => {
    const out = addHooks(fixture(), cmds) as ReturnType<typeof fixture>;
    const orig = fixture();
    for (const k of ['PreToolUse', 'PostToolUse', 'SubagentStart', 'SubagentStop', 'PreCompact'] as const) {
      expect(out.hooks[k]).toEqual(orig.hooks[k]);
    }
    expect(out.hooks.Stop[0]).toEqual(orig.hooks.Stop[0]);
    expect(out.hooks.Stop).toHaveLength(2);
    expect((out.hooks as Record<string, unknown[]>).UserPromptSubmit).toHaveLength(1);
    expect(out.model).toBe('x');
  });

  it('addHooks is idempotent', () => {
    const once = addHooks(fixture(), cmds);
    expect(addHooks(once, cmds)).toEqual(once);
  });

  it('removeHooks restores original', () => {
    expect(removeHooks(addHooks(fixture(), cmds))).toEqual(fixture());
    expect(removeHooks(addHooks({ hooks: {} }, cmds))).toEqual({ hooks: {} });
    expect(removeHooks(addHooks({}, cmds))).toEqual({ hooks: {} });
  });

  it('refuses a non-object hooks value', () => {
    for (const bad of ['x', [], null]) {
      expect(() => addHooks({ hooks: bad }, cmds)).toThrow(/not an object/);
      expect(() => removeHooks({ hooks: bad })).toThrow(/not an object/);
    }
  });

  it('assertRecognisable rejects paths without agent-console', () => {
    expect(() => assertRecognisable(cmds)).not.toThrow();
    expect(() => assertRecognisable({ ...cmds, Stop: 'node "C:\\other\\claude-stop.js"' })).toThrow(/not recognisable/);
  });

  it('does not mutate its input', () => {
    const x = fixture();
    addHooks(x, cmds);
    expect(x).toEqual(fixture());
  });
});
