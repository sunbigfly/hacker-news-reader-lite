import type { RequestLane } from "./request-contract";

export interface ScheduledRequest<T> {
  readonly key: string;
  readonly lane: RequestLane;
  readonly priority?: number;
  readonly signal?: AbortSignal;
  readonly run: (signal: AbortSignal) => Promise<T>;
}

interface QueueEntry<T> {
  readonly key: string;
  readonly lane: RequestLane;
  readonly priority: number;
  readonly sequence: number;
  readonly controller: AbortController;
  readonly run: (signal: AbortSignal) => Promise<T>;
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
  readonly reject: (reason: Error) => void;
  subscribers: number;
  started: boolean;
  settled: boolean;
}

const LANE_PRIORITY: Readonly<Record<RequestLane, number>> = {
  "hn-interactive": 0,
  translation: 1,
  ai: 2,
  article: 3,
  "hn-supplement": 4,
};

function errorReason(reason: unknown, message = "Request failed"): Error {
  return reason instanceof Error ? reason : new Error(message);
}

function abortReason(signal: AbortSignal): Error {
  return signal.reason instanceof Error ? signal.reason : new DOMException("Request aborted", "AbortError");
}

export class RequestScheduler {
  readonly #maxConcurrent: number;
  readonly #queue: Array<QueueEntry<unknown>> = [];
  readonly #entries = new Map<string, QueueEntry<unknown>>();
  readonly #idleWaiters = new Set<() => void>();
  #activeCount = 0;
  #sequence = 0;
  #destroyed = false;

  constructor(maxConcurrent = 4) {
    if (!Number.isSafeInteger(maxConcurrent) || maxConcurrent < 1) {
      throw new RangeError("maxConcurrent must be a positive integer");
    }
    this.#maxConcurrent = maxConcurrent;
  }

  get activeCount(): number {
    return this.#activeCount;
  }

  get pendingCount(): number {
    return this.#queue.length;
  }

  get size(): number {
    return this.#entries.size;
  }

  schedule<T>(request: ScheduledRequest<T>): Promise<T> {
    if (this.#destroyed) return Promise.reject(new Error("RequestScheduler is destroyed"));
    if (!request.key.trim()) return Promise.reject(new TypeError("request key cannot be empty"));
    if (request.signal?.aborted) return Promise.reject(abortReason(request.signal));

    const existing = this.#entries.get(request.key) as QueueEntry<T> | undefined;
    if (existing && !existing.settled && !existing.controller.signal.aborted) {
      return this.#subscribe(existing, request.signal);
    }

    let resolve!: (value: T) => void;
    let reject!: (reason: Error) => void;
    const promise = new Promise<T>((resolvePromise, rejectPromise) => {
      resolve = resolvePromise;
      reject = rejectPromise;
    });
    const entry: QueueEntry<T> = {
      key: request.key,
      lane: request.lane,
      priority: request.priority ?? 0,
      sequence: this.#sequence,
      controller: new AbortController(),
      run: request.run,
      promise,
      resolve,
      reject,
      subscribers: 0,
      started: false,
      settled: false,
    };
    this.#sequence += 1;
    this.#entries.set(entry.key, entry as QueueEntry<unknown>);
    this.#queue.push(entry as QueueEntry<unknown>);
    this.#queue.sort((left, right) => {
      const laneDifference = LANE_PRIORITY[left.lane] - LANE_PRIORITY[right.lane];
      return laneDifference || left.priority - right.priority || left.sequence - right.sequence;
    });
    queueMicrotask(() => this.#drain());
    return this.#subscribe(entry, request.signal);
  }

  cancelAll(reason: unknown = new DOMException("Scheduler cancelled", "AbortError")): void {
    for (const entry of [...this.#entries.values()]) this.#cancelEntry(entry, reason);
  }

  destroy(reason: unknown = new DOMException("Scheduler destroyed", "AbortError")): void {
    if (this.#destroyed) return;
    this.#destroyed = true;
    this.cancelAll(reason);
  }

  whenIdle(): Promise<void> {
    if (this.#entries.size === 0 && this.#activeCount === 0) return Promise.resolve();
    return new Promise<void>((resolve) => this.#idleWaiters.add(resolve));
  }

  #subscribe<T>(entry: QueueEntry<T>, signal?: AbortSignal): Promise<T> {
    entry.subscribers += 1;
    return new Promise<T>((resolve, reject) => {
      let active = true;
      const finish = (callback: () => void): void => {
        if (!active) return;
        active = false;
        signal?.removeEventListener("abort", onAbort);
        entry.subscribers = Math.max(0, entry.subscribers - 1);
        callback();
      };
      const onAbort = (): void => {
        const reason = signal ? abortReason(signal) : new DOMException("Aborted", "AbortError");
        finish(() => reject(reason));
        if (entry.subscribers === 0 && !entry.settled) this.#cancelEntry(entry, reason);
      };
      signal?.addEventListener("abort", onAbort, { once: true });
      entry.promise.then(
        (value) => finish(() => resolve(value)),
        (error: unknown) => finish(() => reject(errorReason(error))),
      );
    });
  }

  #cancelEntry<T>(entry: QueueEntry<T>, reason: unknown): void {
    if (entry.settled) return;
    if (entry.started) {
      if (this.#entries.get(entry.key) === entry) this.#entries.delete(entry.key);
      entry.controller.abort(reason);
      this.#notifyIdle();
      return;
    }
    const index = this.#queue.indexOf(entry as QueueEntry<unknown>);
    if (index >= 0) this.#queue.splice(index, 1);
    this.#settle(entry, false, reason);
  }

  #drain(): void {
    while (!this.#destroyed && this.#activeCount < this.#maxConcurrent) {
      const entry = this.#queue.shift();
      if (!entry) break;
      if (entry.settled) continue;
      entry.started = true;
      this.#activeCount += 1;
      void this.#execute(entry);
    }
    this.#notifyIdle();
  }

  async #execute(entry: QueueEntry<unknown>): Promise<void> {
    const aborted = new Promise<never>((_resolve, reject) => {
      entry.controller.signal.addEventListener(
        "abort",
        () => reject(abortReason(entry.controller.signal)),
        { once: true },
      );
    });
    try {
      const value = await Promise.race([entry.run(entry.controller.signal), aborted]);
      this.#settle(entry, true, value);
    } catch (error) {
      this.#settle(entry, false, error);
    } finally {
      this.#activeCount -= 1;
      this.#drain();
    }
  }

  #settle<T>(entry: QueueEntry<T>, success: boolean, value: unknown): void {
    if (entry.settled) return;
    entry.settled = true;
    if (this.#entries.get(entry.key) === entry) this.#entries.delete(entry.key);
    if (success) entry.resolve(value as T);
    else entry.reject(errorReason(value));
    this.#notifyIdle();
  }

  #notifyIdle(): void {
    if (this.#entries.size > 0 || this.#activeCount > 0) return;
    for (const resolve of this.#idleWaiters) resolve();
    this.#idleWaiters.clear();
  }
}
