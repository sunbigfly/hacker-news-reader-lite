export interface RepeatActionGateOptions {
  readonly windowMs?: number;
  readonly now?: () => number;
}

export class RepeatActionGate {
  readonly #deadlines = new Map<string, number>();
  readonly #windowMs: number;
  readonly #now: () => number;

  constructor(options: RepeatActionGateOptions = {}) {
    const windowMs = options.windowMs ?? 1_500;
    if (!Number.isFinite(windowMs) || windowMs <= 0) {
      throw new RangeError("重复动作确认期限必须为正数");
    }
    this.#windowMs = windowMs;
    this.#now = options.now ?? Date.now;
  }

  confirm(rawKey: string): boolean {
    const key = rawKey.trim();
    if (!key) throw new TypeError("重复动作确认 key 不能为空");
    const now = this.#now();
    const confirmed = (this.#deadlines.get(key) ?? 0) >= now;
    this.#deadlines.clear();
    if (!confirmed) this.#deadlines.set(key, now + this.#windowMs);
    return confirmed;
  }

  clear(): void {
    this.#deadlines.clear();
  }
}
