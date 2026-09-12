/** X Browser's ReadableStream.pull calls a synchronous Android bridge read. */
export function supportsGmResponseStreams(view: (Window & { mbrowser?: { GM_readStream?: unknown } }) | null = typeof window === "undefined" ? null : window): boolean {
  const bridge = view?.mbrowser;
  return typeof bridge?.GM_readStream !== "function";
}
