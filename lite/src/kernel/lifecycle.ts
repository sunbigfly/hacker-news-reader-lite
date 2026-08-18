export type Cleanup = () => void;

export class LifecycleScope {
  #cleanups: Cleanup[] = [];
  #destroyed = false;

  static ownedBy(parent?: LifecycleScope): LifecycleScope {
    return parent ? parent.child() : new LifecycleScope();
  }

  get destroyed(): boolean {
    return this.#destroyed;
  }

  add(cleanup: Cleanup): Cleanup {
    let active = true;
    const runOnce = (): void => {
      if (!active) return;
      active = false;
      const index = this.#cleanups.indexOf(runOnce);
      if (index >= 0) this.#cleanups.splice(index, 1);
      cleanup();
    };
    if (this.#destroyed) {
      runOnce();
      return runOnce;
    }
    this.#cleanups.push(runOnce);
    return runOnce;
  }

  child(): LifecycleScope {
    const child = new LifecycleScope();
    const detach = this.add(() => child.destroy());
    child.add(detach);
    return child;
  }

  abortController(destroyReason: unknown, upstream?: AbortSignal): AbortController {
    const controller = new AbortController();
    const abort = (reason: unknown): void => {
      if (!controller.signal.aborted) controller.abort(reason);
    };
    const forwardAbort = (): void => abort(upstream?.reason);
    if (upstream?.aborted) forwardAbort();
    else upstream?.addEventListener("abort", forwardAbort, { once: true });
    this.add(() => {
      upstream?.removeEventListener("abort", forwardAbort);
      abort(destroyReason);
    });
    return controller;
  }

  listen(
    target: EventTarget,
    type: string,
    listener: EventListenerOrEventListenerObject,
    options?: boolean | AddEventListenerOptions,
  ): Cleanup {
    target.addEventListener(type, listener, options);
    return this.add(() => target.removeEventListener(type, listener, options));
  }

  observe(observer: { disconnect(): void; observe?(target: Element, options?: unknown): void }, target?: Element, options?: unknown): Cleanup {
    if (target && observer.observe) {
      observer.observe(target, options);
    }
    return this.add(() => observer.disconnect());
  }

  timer(timerId: number, clear: (id: number) => void = clearTimeout): Cleanup {
    return this.add(() => clear(timerId));
  }

  destroy(): void {
    if (this.#destroyed) return;
    this.#destroyed = true;
    const errors: unknown[] = [];
    const cleanups = this.#cleanups.splice(0);
    for (let index = cleanups.length - 1; index >= 0; index -= 1) {
      try {
        cleanups[index]?.();
      } catch (error) {
        errors.push(error);
      }
    }
    if (errors.length > 0) throw new AggregateError(errors, "LifecycleScope cleanup failed");
  }
}
