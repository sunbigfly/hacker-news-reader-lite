export type RequestLane =
  | "hn-interactive"
  | "hn-supplement"
  | "translation"
  | "ai"
  | "article";

export type HttpMethod = "GET" | "POST";

export interface HttpResponse {
  readonly status: number;
  readonly statusText: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: string;
  readonly finalUrl: string;
}

export interface RequestDescriptor<T> {
  readonly key: string;
  readonly lane: RequestLane;
  readonly method: HttpMethod;
  readonly url: string;
  readonly headers?: Readonly<Record<string, string>>;
  readonly body?: string;
  readonly timeoutMs?: number;
  readonly anonymous?: boolean;
  readonly parallel?: boolean;
  readonly stream?: boolean;
  readonly onProgress?: (response: HttpResponse) => boolean | undefined;
  readonly decode: (response: HttpResponse) => T;
}

export interface HttpClient {
  request<T>(descriptor: RequestDescriptor<T>, signal?: AbortSignal): Promise<T>;
}

export class RequestError extends Error {
  constructor(
    message: string,
    readonly kind: "network" | "timeout" | "aborted" | "http" | "decode",
    readonly status?: number,
  ) {
    super(message);
    this.name = "RequestError";
  }
}
