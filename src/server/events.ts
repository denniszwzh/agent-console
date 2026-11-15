import type { ServerEvent } from '../shared/types.js';

export class EventBus {
  private subscribers = new Set<(e: ServerEvent) => void>();

  emit(e: ServerEvent): void {
    for (const fn of [...this.subscribers]) {
      try {
        fn(e);
      } catch (err) {
        console.warn(`[events] subscriber failed: ${(err as Error).message}`);
      }
    }
  }

  subscriberCount(): number {
    return this.subscribers.size;
  }

  subscribe(fn: (e: ServerEvent) => void): () => void {
    this.subscribers.add(fn);
    return () => {
      this.subscribers.delete(fn);
    };
  }
}
