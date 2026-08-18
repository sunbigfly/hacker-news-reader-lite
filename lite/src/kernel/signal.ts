import type { Cleanup, LifecycleScope } from "./lifecycle";

export type SignalListener<T> = (value: T) => void;

export class Signal<T> {
  #listeners = new Set<SignalListener<T>>();

  get size(): number {
    return this.#listeners.size;
  }

  subscribe(listener: SignalListener<T>, scope?: LifecycleScope): Cleanup {
    this.#listeners.add(listener);
    const unsubscribe = (): void => {
      this.#listeners.delete(listener);
    };
    if (scope) scope.add(unsubscribe);
    return unsubscribe;
  }

  emit(value: T): readonly unknown[] {
    const errors: unknown[] = [];
    for (const listener of [...this.#listeners]) {
      try {
        listener(value);
      } catch (error) {
        errors.push(error);
      }
    }
    return Object.freeze(errors);
  }

  clear(): void {
    this.#listeners.clear();
  }
}
