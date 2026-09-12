export type ProbeDetail = Readonly<Record<string, string | number | boolean | null>>;
type ProbeStorage = Pick<Storage, "getItem" | "setItem">;
interface ProbeEntry { elapsedMs: number; type: string; detail: ProbeDetail }
interface ProbeSession {
  source: "hnr-settings-probe";
  schema: 1;
  startedAt: string;
  stoppedAt: string | null;
  stopReason: string | null;
  userAgent: string;
  meaningful: boolean;
  dropped: number;
  entries: ProbeEntry[];
}

const CURRENT_KEY = "hnr:settings-probe:current:v1";
const PREVIOUS_KEY = "hnr:settings-probe:previous:v1";
const MAX_ENTRIES = 200;
const MAX_SERIALIZED_LENGTH = 128_000;

/** Bounded local crash breadcrumbs. Callers pass metadata, never form values. */
export class SettingsProbeLog {
  readonly #started: number;
  readonly #current: ProbeSession;
  readonly #previous: ProbeSession | null;
  #storage: ProbeStorage | null = null;
  #pageStorage: ProbeStorage | null = null;
  #storageBackend: "userscript" | "page" | "none" = "none";
  #lastWrite = -Infinity;
  #stopped = false;

  constructor(readonly view: Window) {
    this.#started = view.performance.now();
    try { this.#pageStorage = view.localStorage; } catch { /* Error pages may deny origin storage. */ }
    if (typeof GM_getValue === "function" && typeof GM_setValue === "function") {
      this.#storage = {
        getItem: (key) => {
          const value = GM_getValue<unknown>(key, null);
          return typeof value === "string" ? value : null;
        },
        setItem: (key, value) => { GM_setValue(key, value); },
      };
      this.#storageBackend = "userscript";
    } else if (this.#pageStorage) {
      this.#storage = this.#pageStorage;
      this.#storageBackend = "page";
    }
    const last = this.#read(CURRENT_KEY);
    this.#previous = last?.meaningful ? last : this.#read(PREVIOUS_KEY);
    this.#current = {
      source: "hnr-settings-probe", schema: 1, startedAt: new Date().toISOString(),
      stoppedAt: null, stopReason: null, userAgent: view.navigator.userAgent.slice(0, 512),
      meaningful: false, dropped: 0, entries: [],
    };
    if (this.#previous && this.#storage) {
      this.#write(PREVIOUS_KEY, JSON.stringify(this.#previous));
    }
    this.append("start", {
      maxEntries: MAX_ENTRIES, sampleMs: 500, durationMs: 60_000,
      origin: view.location.origin, protocol: view.location.protocol, online: view.navigator.onLine,
    });
    this.persist(0);
  }

  get persistent(): boolean { return this.#storage !== null; }
  get storageBackend(): "userscript" | "page" | "none" { return this.#storageBackend; }

  append(type: string, detail: ProbeDetail = {}, meaningful = false): void {
    if (this.#stopped) return;
    const safe: Record<string, string | number | boolean | null> = {};
    for (const [key, value] of Object.entries(detail).slice(0, 24)) {
      safe[key.slice(0, 40)] = typeof value === "string" ? value.slice(0, 160) : value;
    }
    this.#current.entries.push({ elapsedMs: Math.round(this.view.performance.now() - this.#started), type, detail: safe });
    this.#current.meaningful ||= meaningful;
    if (this.#current.entries.length > MAX_ENTRIES) {
      this.#current.entries.shift();
      this.#current.dropped += 1;
    }
  }

  persist(minIntervalMs = 2000): void {
    const now = this.view.performance.now();
    if (!this.#storage || now - this.#lastWrite < minIntervalMs) return;
    this.#lastWrite = now;
    try {
      let serialized = JSON.stringify(this.#current);
      while (serialized.length > MAX_SERIALIZED_LENGTH && this.#current.entries.length > 1) {
        this.#current.entries.shift();
        this.#current.dropped += 1;
        serialized = JSON.stringify(this.#current);
      }
      this.#write(CURRENT_KEY, serialized);
    } catch { this.#storage = null; this.#storageBackend = "none"; }
  }

  stop(reason: string): void {
    if (this.#stopped) return;
    this.append("stop", { reason });
    this.#current.stoppedAt = new Date().toISOString();
    this.#current.stopReason = reason;
    this.#stopped = true;
    this.persist(0);
  }

  export(): string {
    return JSON.stringify({
      diagnosticVersion: "0.0.5", persistent: this.persistent, storageBackend: this.#storageBackend,
      notes: "No input values or page text. Heartbeat delays are observations, not an OOM diagnosis. A missing stopReason indicates an interrupted or unfinished recording.",
      current: this.#current, previous: this.#previous,
    }, null, 2);
  }

  #read(key: string): ProbeSession | null {
    for (const storage of new Set([this.#storage, this.#pageStorage])) {
      try {
        const text = storage?.getItem(key);
        if (!text || text.length > MAX_SERIALIZED_LENGTH) continue;
        const parsed = JSON.parse(text) as Partial<ProbeSession> | null;
        if (parsed?.source !== "hnr-settings-probe" || parsed.schema !== 1 || !Array.isArray(parsed.entries) || parsed.entries.length > MAX_ENTRIES) continue;
        return parsed as ProbeSession;
      } catch { /* Fall back to an older page-local recording when available. */ }
    }
    return null;
  }

  #write(key: string, value: string): void {
    try {
      this.#storage?.setItem(key, value);
      return;
    } catch { /* Some managers expose GM functions but reject storage access. */ }
    if (this.#storageBackend === "userscript" && this.#pageStorage) {
      try {
        this.#pageStorage.setItem(key, value);
        this.#storage = this.#pageStorage;
        this.#storageBackend = "page";
        return;
      } catch { /* Export from memory remains available. */ }
    }
    this.#storage = null;
    this.#storageBackend = "none";
  }
}
