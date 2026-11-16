/** Within this many pixels of the bottom counts as "at the bottom" (a new turn is followed). */
export const NEAR_BOTTOM_PX = 100;

export interface StreamAnchor {
  /** The turn at the top edge of the view. */
  unitId: string;
  /** How far the view's top edge is below that turn's top edge, in pixels. */
  offset: number;
}

export function nearBottom(el: { scrollTop: number; clientHeight: number; scrollHeight: number }): boolean {
  return el.scrollHeight - el.clientHeight - el.scrollTop <= NEAR_BOTTOM_PX;
}

function turns(stream: HTMLElement): HTMLElement[] {
  return [...stream.querySelectorAll<HTMLElement>('section[data-unit-id]')];
}

/**
 * Where the view is, as a turn and an offset into it rather than a pixel position, so the same text
 * can be found again after content above it changed height. Turns are positioned against the stream.
 */
export function topAnchor(stream: HTMLElement): StreamAnchor | null {
  const list = turns(stream);
  if (list.length === 0) return null;
  const top = stream.scrollTop;
  const hit = list.find((s) => s.offsetTop + s.offsetHeight > top) ?? list[list.length - 1];
  return { unitId: hit.dataset.unitId!, offset: top - hit.offsetTop };
}

/** The scroll position for an anchor, or null when its turn is not rendered. */
export function anchorTop(stream: HTMLElement, anchor: StreamAnchor): number | null {
  const hit = turns(stream).find((s) => s.dataset.unitId === anchor.unitId);
  return hit ? hit.offsetTop + anchor.offset : null;
}

export function scrollToAnchor(stream: HTMLElement, anchor: StreamAnchor): boolean {
  const top = anchorTop(stream, anchor);
  if (top === null) return false;
  stream.scrollTop = top;
  return true;
}
