declare const __HN_READER_CSS__: string;
declare const __HN_HOST_CSS__: string;
declare const __HN_READER_BUILD__: "local" | "production";

interface GmRequestResponse {
  readonly status: number;
  readonly statusText: string;
  readonly responseHeaders: string;
  readonly responseText?: string;
  readonly response?: unknown;
  readonly finalUrl?: string;
}

interface GmRequestProgress {
  readonly status?: number;
  readonly statusText?: string;
  readonly responseHeaders?: string;
  readonly responseText?: string;
  readonly response?: unknown;
  readonly finalUrl?: string;
  readonly target?: {
    readonly status?: number;
    readonly statusText?: string;
    readonly responseHeaders?: string;
    readonly responseText?: string;
    readonly response?: unknown;
    readonly responseURL?: string;
  };
}

interface GmRequestOptions {
  readonly method: "GET" | "POST";
  readonly url: string;
  readonly headers?: Readonly<Record<string, string>>;
  readonly data?: string;
  readonly timeout?: number;
  readonly anonymous?: boolean;
  readonly redirect?: "follow" | "error" | "manual";
  readonly responseType?: "text" | "stream";
  readonly onloadstart?: (response: GmRequestProgress) => void;
  readonly onprogress?: (response: GmRequestProgress) => void;
  readonly onload: (response: GmRequestResponse) => void;
  readonly onerror: (error: unknown) => void;
  readonly ontimeout: () => void;
  readonly onabort: () => void;
}

interface GmRequestHandle {
  abort(): void;
}

declare function GM_xmlhttpRequest(options: GmRequestOptions): GmRequestHandle;
declare function GM_getValue<T>(key: string, fallback: T): T;
declare function GM_setValue(key: string, value: unknown): void;
declare function GM_deleteValue(key: string): void;
declare function GM_listValues(): string[];
