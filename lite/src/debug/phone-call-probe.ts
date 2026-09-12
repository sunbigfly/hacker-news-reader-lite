/** Only imported by the explicitly installed phone diagnostic build. */
let sequence = 0;

export function tracePhoneCall<T>(owner: string, call: () => T): T {
  const id = ++sequence;
  const start = performance.now();
  const emit = (phase: "start" | "end", failed = false): void => {
    document.dispatchEvent(new CustomEvent("hnr:probe-call", {
      detail: { id, owner, phase, failed, durationMs: Math.round(performance.now() - start) },
    }));
  };
  emit("start");
  let failed = true;
  try {
    const value = call();
    failed = false;
    return value;
  } finally { emit("end", failed); }
}
