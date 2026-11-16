/** A resource cleanup may complete synchronously or asynchronously. */
export type RuntimeCleanup = () => unknown | PromiseLike<unknown>;
export type RuntimeErrorHandler = (error: unknown) => void;

/** Own asynchronous work for exactly one plugin activation. */
export class RuntimeLifecycle {
  readonly #tasks = new Set<Promise<unknown>>();
  readonly #cleanups: RuntimeCleanup[] = [];
  #closing: Promise<void> | undefined;
  readonly controller: AbortController;
  onError: RuntimeErrorHandler;

  constructor(onError: RuntimeErrorHandler = () => {}) {
    this.controller = new AbortController();
    this.onError = onError;
  }

  get signal(): AbortSignal {
    return this.controller.signal;
  }

  own(cleanup: RuntimeCleanup): void {
    if (this.signal.aborted) {
      cleanup();
      return;
    }
    this.#cleanups.push(cleanup);
  }

  launch<T>(operation: T | PromiseLike<T>): Promise<T | void> {
    if (this.signal.aborted) return Promise.resolve();
    const task = Promise.resolve(operation)
      .catch((error: unknown) => {
        if (!this.signal.aborted) this.onError(error);
      })
      .finally(() => this.#tasks.delete(task));
    this.#tasks.add(task);
    return task;
  }

  close(): Promise<void> {
    if (this.#closing) return this.#closing;
    // Abort BEFORE awaiting resources, so a blocked getUpdates cannot outlive unload.
    this.controller.abort();
    const cleanups = this.#cleanups
      .splice(0)
      .reverse()
      .map((fn) => {
        try {
          return Promise.resolve(fn());
        } catch (error: unknown) {
          return Promise.reject(error);
        }
      });
    this.#closing = Promise.allSettled([...cleanups, ...this.#tasks]).then(
      () => {},
    );
    return this.#closing;
  }
}
