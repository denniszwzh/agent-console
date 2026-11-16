// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render } from '@testing-library/react';
import type { Source } from '../../src/shared/types.js';
import { fakeActions, makeUnit } from './fixtures.js';

const rendered: string[] = [];
vi.mock('../../src/web/components/SourceView.js', () => ({
  SourceView: ({ source }: { source: Source }) => {
    rendered.push(source.id);
    return <div>{source.content}</div>;
  },
}));

const { ConversationView } = await import('../../src/web/components/ConversationView.js');

afterEach(cleanup);

describe('ConversationView rendering', () => {
  it('does not re-render unchanged turns on refresh', () => {
    const actions = fakeActions();
    const units = [0, 1, 2].map((i) => makeUnit({ id: `u${i}`, reply: { id: `r${i}`, kind: 'reply', content: `reply ${i}`, blocks: [] }, status: i === 2 ? 'open' : 'stale' }));
    const { rerender } = render(<ConversationView session={undefined} units={units} actionsFor={() => actions} />);
    rendered.length = 0;
    const changed = { ...units[1], reply: { ...units[1].reply, content: 'reply 1 edited' } };
    rerender(<ConversationView session={undefined} units={[units[0], changed, units[2]]} actionsFor={() => actions} />);
    expect(rendered).toEqual(['r1']);
  });
});
