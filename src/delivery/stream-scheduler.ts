/** Only fields used by scheduling; callers retain their full projection type. */
export interface StreamView {
  turn: number;
  final?: boolean;
}

export interface StreamSchedulerOptions<Id, View extends StreamView, Timer> {
  deliver: (id: Id, view: View) => unknown | PromiseLike<unknown>;
  onError?: (error: unknown) => void;
  intervalMs?: number;
  setTimer: (callback: () => void, delay: number) => Timer;
  clearTimer: (timer: Timer) => unknown;
}

export interface StreamScheduler<Id, View extends StreamView> {
  push(id: Id, view: View, options?: { immediate?: boolean }): void;
  close(): void;
}

interface Cell<View, Timer> {
  timer: Timer | null;
  pending: View | null;
  boundaries: View[];
  inFlight: boolean;
  final: boolean;
  turn?: number;
}

type NativeTimer = ReturnType<typeof setTimeout>;
type NativeOptions<Id, View extends StreamView> = Omit<
  StreamSchedulerOptions<Id, View, NativeTimer>,
  "setTimer" | "clearTimer"
> & {
  setTimer?: typeof setTimeout;
  clearTimer?: typeof clearTimeout;
};

export function createStreamScheduler<Id, View extends StreamView>(
  options: NativeOptions<Id, View>,
): StreamScheduler<Id, View>;
export function createStreamScheduler<Id, View extends StreamView, Timer>(
  options: StreamSchedulerOptions<Id, View, Timer>,
): StreamScheduler<Id, View>;
/** Coalesce fast tokens without waiting for silence. Slow delivery never builds a queue. */
export function createStreamScheduler<
  Id,
  View extends StreamView,
  Timer = NativeTimer,
>({
  deliver,
  onError = () => {},
  intervalMs = 250,
  setTimer = setTimeout,
  clearTimer = clearTimeout,
}: Omit<StreamSchedulerOptions<Id, View, Timer>, "setTimer" | "clearTimer"> & {
  setTimer?: (callback: () => void, delay: number) => Timer | NativeTimer;
  clearTimer?: (timer: Timer & NativeTimer) => unknown;
}): StreamScheduler<Id, View> {
  type Handle = Timer | NativeTimer;
  const cells = new Map<Id, Cell<View, Handle>>();
  let closed = false;

  function cell(id: Id): Cell<View, Handle> {
    const existing = cells.get(id);
    if (existing) return existing;
    const created: Cell<View, Handle> = {
      timer: null,
      pending: null,
      boundaries: [],
      inFlight: false,
      final: false,
    };
    cells.set(id, created);
    return created;
  }

  async function drain(id: Id, c: Cell<View, Handle>): Promise<void> {
    c.timer = null;
    if (closed || c.inFlight || (!c.pending && !c.boundaries.length)) return;
    const boundary = c.boundaries.shift();
    const view = boundary ?? c.pending;
    if (!boundary) c.pending = null;
    // The admission condition above guarantees one of these slots is populated.
    if (!view) return;
    c.inFlight = true;
    try {
      await deliver(id, view);
    } catch (error: unknown) {
      onError(error);
    } finally {
      c.inFlight = false;
      if ((c.pending || c.boundaries.length) && !closed)
        arm(id, c, c.boundaries.length || c.pending?.final ? 0 : intervalMs);
    }
  }

  function arm(id: Id, c: Cell<View, Handle>, delay: number): void {
    if (c.timer !== null || c.inFlight || closed) return;
    c.timer = setTimer(() => void drain(id, c), delay);
  }

  function cancel(timer: Handle): void {
    // A handle is always returned by this instance's paired timer factory.
    clearTimer(timer as Timer & NativeTimer);
  }

  return {
    push(id, view, { immediate = false } = {}) {
      if (closed) return;
      const c = cell(id);
      // A newer turn can reopen a finalized lane; stale callbacks cannot overwrite it.
      if (c.turn !== undefined && view.turn < c.turn) return;
      if (view.turn !== c.turn) {
        if (c.pending?.final) c.boundaries.push(c.pending);
        c.pending = null;
        c.turn = view.turn;
        c.final = false;
      }
      if (c.final && !view.final) return;
      c.pending = view;
      if (view.final) c.final = true;
      if (immediate || view.final) {
        if (c.timer !== null) {
          cancel(c.timer);
          c.timer = null;
        }
        arm(id, c, 0);
      } else arm(id, c, intervalMs);
    },
    close() {
      closed = true;
      for (const c of cells.values()) if (c.timer !== null) cancel(c.timer);
      cells.clear();
    },
  };
}
