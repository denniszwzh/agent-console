// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { VIEW_STATE_KEY, loadViewState, saveViewState } from '../../src/web/view-state.js';

beforeEach(() => {
  localStorage.clear();
  sessionStorage.clear();
});
afterEach(() => vi.restoreAllMocks());

describe('view state', () => {
  it('reads back what was saved', () => {
    saveViewState({ session: 's1', anchor: { unitId: 'u1', offset: 12 } });
    expect(loadViewState()).toEqual({ session: 's1', anchor: { unitId: 'u1', offset: 12 } });
  });

  it('is empty when nothing or garbage is stored', () => {
    expect(loadViewState()).toEqual({ session: null, anchor: null });
    localStorage.setItem(VIEW_STATE_KEY, '{not json');
    expect(loadViewState()).toEqual({ session: null, anchor: null });
    localStorage.setItem(VIEW_STATE_KEY, JSON.stringify({ session: 3, anchor: { unitId: 'u', offset: 'x' } }));
    expect(loadViewState()).toEqual({ session: null, anchor: null });
  });

  it('each tab keeps its own place when another tab saves a different one', () => {
    saveViewState({ session: 'mine', anchor: { unitId: 'u1', offset: 3 } });
    // Another tab of the same panel writes the shared copy.
    localStorage.setItem(VIEW_STATE_KEY, JSON.stringify({ session: 'other', anchor: null }));
    expect(loadViewState()).toEqual({ session: 'mine', anchor: { unitId: 'u1', offset: 3 } });
  });

  it('a new tab starts where any tab last was', () => {
    localStorage.setItem(VIEW_STATE_KEY, JSON.stringify({ session: 'other', anchor: { unitId: 'u2', offset: 0 } }));
    expect(loadViewState()).toEqual({ session: 'other', anchor: { unitId: 'u2', offset: 0 } });
  });

  it('never throws when storage fails', () => {
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('quota');
    });
    expect(() => saveViewState({ session: 's1', anchor: null })).not.toThrow();
  });
});
