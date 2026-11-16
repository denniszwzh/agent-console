// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { nearBottom, scrollToAnchor, topAnchor } from '../../src/web/scroll.js';

function stream(tops: number[], height = 100) {
  const el = document.createElement('div');
  for (const [i, top] of tops.entries()) {
    const s = document.createElement('section');
    s.setAttribute('data-unit-id', `u${i}`);
    Object.defineProperty(s, 'offsetTop', { value: top });
    Object.defineProperty(s, 'offsetHeight', { value: height });
    el.appendChild(s);
  }
  return el;
}

describe('nearBottom', () => {
  it('counts 100px from the bottom as the bottom', () => {
    expect(nearBottom({ scrollTop: 600, clientHeight: 300, scrollHeight: 1000 })).toBe(true);
    expect(nearBottom({ scrollTop: 599, clientHeight: 300, scrollHeight: 1000 })).toBe(false);
  });
});

describe('topAnchor', () => {
  it('names the turn at the top edge and how far into it the view is', () => {
    const el = stream([50, 150, 250]);
    el.scrollTop = 170;
    expect(topAnchor(el)).toEqual({ unitId: 'u1', offset: 20 });
    el.scrollTop = 0;
    expect(topAnchor(el)).toEqual({ unitId: 'u0', offset: -50 });
  });

  it('returns null without turns', () => {
    expect(topAnchor(document.createElement('div'))).toBeNull();
  });
});

describe('scrollToAnchor', () => {
  it('scrolls to the turn plus the offset', () => {
    const el = stream([50, 150, 250]);
    expect(scrollToAnchor(el, { unitId: 'u2', offset: 30 })).toBe(true);
    expect(el.scrollTop).toBe(280);
  });

  it('reports a missing turn', () => {
    const el = stream([50]);
    el.scrollTop = 7;
    expect(scrollToAnchor(el, { unitId: 'gone', offset: 0 })).toBe(false);
    expect(el.scrollTop).toBe(7);
  });
});
