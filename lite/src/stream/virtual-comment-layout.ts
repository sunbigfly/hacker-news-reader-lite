export interface VirtualRange {
  readonly start: number;
  readonly end: number;
  readonly viewportStart: number;
  readonly viewportEnd: number;
  readonly topSpacer: number;
  readonly bottomSpacer: number;
  readonly totalHeight: number;
}

export interface VirtualScrollAnchor {
  readonly index: number;
  readonly offset: number;
}

export interface VirtualCommentLayoutOptions {
  readonly defaultHeight?: number;
  readonly overscanPx?: number;
  readonly maxMounted?: number;
}

export class VirtualCommentLayout {
  readonly #defaultHeight: number;
  readonly #overscanPx: number;
  readonly #maxMounted: number;
  #heights: number[] = [];
  #prefix: number[] = [0];
  #dirtyFrom = 0;

  constructor(options: VirtualCommentLayoutOptions = {}) {
    this.#defaultHeight = options.defaultHeight ?? 112;
    this.#overscanPx = options.overscanPx ?? 960;
    this.#maxMounted = options.maxMounted ?? 120;
    if (this.#defaultHeight <= 0 || this.#overscanPx < 0 || this.#maxMounted < 1) {
      throw new RangeError("invalid virtual layout options");
    }
  }

  get count(): number {
    return this.#heights.length;
  }

  setCount(count: number): void {
    if (!Number.isSafeInteger(count) || count < 0) throw new RangeError("count must be a non-negative integer");
    if (count === this.#heights.length) return;
    if (count > this.#heights.length) {
      this.#heights.push(...Array.from({ length: count - this.#heights.length }, () => this.#defaultHeight));
    } else {
      this.#heights.length = count;
    }
    this.#dirtyFrom = Math.min(this.#dirtyFrom, count);
    this.#prefix.length = Math.min(this.#prefix.length, count + 1);
  }

  updateHeight(index: number, rawHeight: number): boolean {
    if (index < 0 || index >= this.#heights.length) return false;
    const height = Math.max(24, Math.ceil(rawHeight));
    if (this.#heights[index] === height) return false;
    this.#heights[index] = height;
    this.#dirtyFrom = Math.min(this.#dirtyFrom, index);
    return true;
  }

  seedHeights(heights: readonly number[]): void {
    for (const [index, height] of heights.entries()) this.updateHeight(index, height);
  }

  range(scrollTop: number, viewportHeight: number): VirtualRange {
    this.#ensurePrefix();
    const totalHeight = this.#prefix.at(-1) ?? 0;
    const visibleHeight = Math.max(1, viewportHeight);
    const overscanPx = Math.max(this.#overscanPx, visibleHeight);
    const viewportTop = Math.max(0, scrollTop);
    const viewportStart = this.#indexAt(viewportTop);
    const viewportEnd = Math.min(this.count, this.#indexAt(Math.max(viewportTop, viewportTop + visibleHeight - 0.01)) + 1);
    const startTarget = Math.max(0, scrollTop - overscanPx);
    const endTarget = Math.max(startTarget, scrollTop + visibleHeight + overscanPx);
    const start = this.#indexAt(startTarget);
    let end = Math.min(this.count, this.#indexAt(endTarget) + 1);
    if (end - start > this.#maxMounted) end = start + this.#maxMounted;
    return {
      start,
      end,
      viewportStart,
      viewportEnd,
      topSpacer: this.#prefix[start] ?? 0,
      bottomSpacer: Math.max(0, totalHeight - (this.#prefix[end] ?? totalHeight)),
      totalHeight,
    };
  }

  offsetFor(index: number): number {
    this.#ensurePrefix();
    return this.#prefix[Math.max(0, Math.min(index, this.count))] ?? 0;
  }

  anchorAt(scrollTop: number): VirtualScrollAnchor | null {
    if (this.count === 0) return null;
    this.#ensurePrefix();
    const top = Math.max(0, scrollTop);
    const index = this.#indexAt(top);
    return { index, offset: top - (this.#prefix[index] ?? 0) };
  }

  #ensurePrefix(): void {
    const start = Math.max(0, Math.min(this.#dirtyFrom, this.#heights.length));
    if (this.#prefix.length < start + 1) this.#prefix.length = start + 1;
    if (start === 0) this.#prefix[0] = 0;
    for (let index = start; index < this.#heights.length; index += 1) {
      this.#prefix[index + 1] = (this.#prefix[index] ?? 0) + (this.#heights[index] ?? this.#defaultHeight);
    }
    this.#prefix.length = this.#heights.length + 1;
    this.#dirtyFrom = this.#heights.length;
  }

  #indexAt(offset: number): number {
    if (this.count === 0) return 0;
    let low = 0;
    let high = this.count;
    while (low < high) {
      const middle = Math.floor((low + high) / 2);
      if ((this.#prefix[middle + 1] ?? 0) <= offset) low = middle + 1;
      else high = middle;
    }
    return Math.min(low, this.count - 1);
  }
}
