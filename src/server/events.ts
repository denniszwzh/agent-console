export type ServerEvent = {
  type: 'unit.created' | 'unit.updated';
  unitId: string;
  sessionId: string;
};

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

  subscribe(fn: (e: ServerEvent) => void): () => void {
    this.subscribers.add(fn);
    return () => {
      this.subscribers.delete(fn);
    };
  }
}
