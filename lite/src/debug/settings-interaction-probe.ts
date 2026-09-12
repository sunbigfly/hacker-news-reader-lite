import { SettingsProbeLog } from "./settings-probe-log";

/** Explicitly installed diagnostic companion; never imported by the reader. */
export function installSettingsInteractionProbe(view: Window): { destroy(): void; stop(): void; exportLog(): string } {
  const document = view.document;
  const log = new SettingsProbeLog(view);
  const persistLog = (interval?: number): void => {
    const start = view.performance.now();
    log.persist(interval);
    const durationMs = Math.round(view.performance.now() - start);
    if (durationMs >= 50) log.append("log-storage-delay", { durationMs }, true);
  };
  const host = document.createElement("div");
  host.id = "hnr-interaction-probe";
  host.style.cssText = "position:fixed!important;bottom:0!important;left:0!important;right:0!important;z-index:2147483647!important;pointer-events:none!important;";
  const shadow = host.attachShadow({ mode: "open" });
  const output = document.createElement("pre");
  output.hidden = true;
  output.style.cssText = "margin:0;padding:6px;background:#17212b;color:#fff;font:11px/1.4 monospace;white-space:pre-wrap;overflow-wrap:anywhere;pointer-events:none;";
  const toolbar = document.createElement("div");
  toolbar.style.cssText = "display:flex;align-items:center;gap:4px;padding:4px;background:#17212b;color:white;font:12px/1.3 system-ui;pointer-events:auto;";
  const status = document.createElement("span");
  status.style.cssText = "flex:1;min-width:0;";
  toolbar.append(status);
  const button = (label: string, action: () => void): HTMLButtonElement => {
    const element = document.createElement("button");
    element.type = "button";
    element.textContent = label;
    element.style.cssText = "min-height:44px;min-width:44px;padding:6px;border:1px solid #64748b;border-radius:6px;background:#263747;color:white;font:12px system-ui;touch-action:manipulation;";
    element.addEventListener("click", action);
    toolbar.append(element);
    return element;
  };
  const exportText = document.createElement("textarea");
  exportText.readOnly = true;
  exportText.hidden = true;
  exportText.setAttribute("aria-label", "诊断日志，可全选复制");
  exportText.style.cssText = "box-sizing:border-box;width:100%;height:160px;font:12px monospace;pointer-events:auto;";
  const showExport = (): void => {
    exportText.value = log.export();
    exportText.hidden = false;
    exportText.focus();
    exportText.select();
    status.textContent = "日志已显示，可全选复制";
  };
  const downloads = new Map<number, string>();
  const clearDownloads = (): void => {
    for (const [timer, url] of downloads) { view.clearTimeout(timer); URL.revokeObjectURL(url); }
    downloads.clear();
  };
  button("导出", () => {
    if (typeof URL.createObjectURL !== "function") { showExport(); return; }
    let url: string;
    try { url = URL.createObjectURL(new Blob([log.export()], { type: "application/json;charset=utf-8" })); }
    catch { showExport(); return; }
    const link = document.createElement("a");
    link.href = url;
    link.download = `hnr-phone-log-${Date.now()}.json`;
    shadow.append(link);
    link.click();
    link.remove();
    const timer = view.setTimeout(() => { URL.revokeObjectURL(url); downloads.delete(timer); }, 10_000);
    downloads.set(timer, url);
    status.textContent = "已请求下载日志";
  });
  button("复制", () => {
    if (!view.navigator.clipboard?.writeText) { showExport(); return; }
    void view.navigator.clipboard.writeText(log.export()).then(() => {
      status.textContent = "日志已复制";
    }).catch(showExport);
  });
  const stopButton = button("停止", () => { stop("manual"); });
  button("详情", () => { output.hidden = !output.hidden; });
  shadow.append(output, exportText, toolbar);
  const mountHost = (): void => {
    const parent = document.querySelector("#hn-reader-workspace") ?? document.body;
    if (host.parentNode !== parent) { host.removeAttribute("inert"); parent.append(host); }
  };
  mountHost();
  // Only track direct workspace insertion/removal, not the comment DOM.
  const mountObserver = new MutationObserver(mountHost);
  mountObserver.observe(document.body, { childList: true });
  mountObserver.observe(document.documentElement, { childList: true });
  const reader = (): ShadowRoot | null => document.querySelector("#hn-reader-root")?.shadowRoot ?? null;
  const nameOf = (node: EventTarget | null): string => {
    if (!(node instanceof Element)) return "-";
    const type = node instanceof HTMLInputElement ? `/${node.type}` : "";
    const role = node.getAttribute("role");
    return `${node.tagName.toLowerCase()}${type}${role ? `/${role}` : ""}`;
  };
  const active = (): string => {
    let element = document.activeElement;
    while (element?.shadowRoot?.activeElement) element = element.shadowRoot.activeElement;
    return nameOf(element);
  };
  const counts = { touch: 0, pointer: 0, click: 0, focus: 0, input: 0, scroll: 0, prevented: 0, errors: 0 };
  let target = "-";
  let hit = "-";
  let flags = "-";
  let maxDelay = 0;
  let ticks = 0;
  let stopped = false;
  const started = view.performance.now();
  let lastTick = started;
  let observedRoot: ShadowRoot | null = null;
  let settingsVisible = false;
  let viewportIdentity = "";
  let lastScrollLog = -Infinity;
  const pendingEvents: Event[] = [];
  const listeners: Array<readonly [string, EventListener]> = [];
  const sampleEvent = (kind: "touch" | "pointer" | "click" | "focus" | "input" | "scroll"): EventListener => (event) => {
    const root = reader();
    if (!root?.querySelector(".hnr-settings") || event.composedPath().includes(host)) return;
    counts[kind] += 1;
    const element = event.composedPath().find((node): node is Element => node instanceof Element);
    let x: number | null = null;
    let y: number | null = null;
    flags = element ? `disabled=${Number(element.matches(":disabled"))},readonly=${Number(element.hasAttribute("readonly"))},inert=${Number(event.composedPath().some((node) => node instanceof Element && node.hasAttribute("inert")))}` : "-";
    if (kind === "touch" || kind === "pointer" || kind === "click") {
      target = nameOf(element ?? null);
      const touch = "touches" in event ? (event as TouchEvent).touches[0] ?? (event as TouchEvent).changedTouches?.[0] : undefined;
      const point = touch ?? ("clientX" in event ? event as MouseEvent : null);
      x = point?.clientX ?? null;
      y = point?.clientY ?? null;
      hit = point ? nameOf(root.elementFromPoint?.(point.clientX, point.clientY) ?? null) : "-";
      // Inspect on the next timer tick, after all native event handlers finish.
      if (pendingEvents.length < 16) pendingEvents.push(event);
    }
    const now = view.performance.now();
    if (kind !== "scroll" || now - lastScrollLog >= 500) {
      if (kind === "scroll") lastScrollLog = now;
      log.append("interaction", {
        kind, event: event.type, target: nameOf(element ?? null), hit: kind === "touch" || kind === "pointer" || kind === "click" ? hit : "-",
        field: element?.getAttribute("name") ?? element?.closest(".hnr-select")?.querySelector("select")?.name ?? "",
        active: active(), flags, x, y,
      }, true);
    }
    // Keep a bounded breadcrumb before the reader's own gesture handler runs.
    if (kind === "touch" || kind === "pointer" || kind === "click") persistLog(300);
  };
  const listen = (type: string, handler: EventListener): void => {
    document.addEventListener(type, handler, { capture: true, passive: true });
    listeners.push([type, handler]);
  };
  listen("touchstart", sampleEvent("touch"));
  listen("touchend", sampleEvent("touch"));
  listen("touchcancel", sampleEvent("touch"));
  listen("pointerdown", sampleEvent("pointer"));
  listen("pointerup", sampleEvent("pointer"));
  listen("pointercancel", sampleEvent("pointer"));
  listen("click", sampleEvent("click"));
  listen("focusin", sampleEvent("focus"));
  listen("focusout", sampleEvent("focus"));
  listen("beforeinput", sampleEvent("input"));
  listen("input", sampleEvent("input"));
  listen("scroll", sampleEvent("scroll"));
  const onReaderScroll = sampleEvent("scroll");
  const onRuntimeCall = (event: Event): void => {
    const detail: unknown = event instanceof CustomEvent ? event.detail : null;
    if (!detail || typeof detail !== "object") return;
    const record = detail as Record<string, unknown>;
    if (typeof record.owner !== "string" || !/^[a-z-]+:(GM_xmlhttpRequest|GM_getValue|GM_setValue|GM_deleteValue|GM_listValues|focus|scrollIntoView|openSettings)$/.test(record.owner)) return;
    if (record.phase !== "start" && record.phase !== "end") return;
    if (typeof record.durationMs !== "number" || !Number.isFinite(record.durationMs)) return;
    // Do not persist from this listener: a synchronous GM write could itself
    // block the very native call we are measuring. The normal sampler saves it.
    if (record.phase === "start" || record.durationMs >= 50 || record.failed === true) {
      log.append("reader-call", {
        owner: record.owner, phase: record.phase, durationMs: record.durationMs,
        failed: record.failed === true,
      }, record.durationMs >= 50 || record.failed === true);
    }
  };
  document.addEventListener("hnr:probe-call", onRuntimeCall);
  let longTasks: PerformanceObserver | null = null;
  let longFrames: PerformanceObserver | null = null;
  try {
    if (typeof PerformanceObserver !== "undefined" && PerformanceObserver.supportedEntryTypes.includes("longtask")) {
      longTasks = new PerformanceObserver((entries) => {
        if (stopped) return;
        for (const entry of entries.getEntries()) {
          log.append("long-task", { durationMs: Math.round(entry.duration), startMs: Math.round(entry.startTime - started) }, true);
        }
      });
      longTasks.observe({ type: "longtask" });
    }
  } catch { longTasks?.disconnect(); longTasks = null; }
  try {
    if (typeof PerformanceObserver !== "undefined" && PerformanceObserver.supportedEntryTypes.includes("long-animation-frame")) {
      longFrames = new PerformanceObserver((entries) => {
        if (stopped) return;
        for (const entry of entries.getEntries()) {
          const frame = entry as PerformanceEntry & { scripts?: readonly { duration: number; sourceURL?: string; sourceCharPosition?: number; forcedStyleAndLayoutDuration?: number }[] };
          for (const script of frame.scripts ?? []) {
            if (script.duration < 50) continue;
            log.append("long-frame-script", {
              durationMs: Math.round(script.duration),
              source: script.sourceURL?.endsWith("hnr-phone-debug.js") ? "reader-debug" : "other",
              position: script.sourceCharPosition ?? null,
              layoutMs: Math.round(script.forcedStyleAndLayoutDuration ?? 0),
            }, true);
          }
        }
      });
      longFrames.observe({ type: "long-animation-frame" });
    }
  } catch { longFrames?.disconnect(); longFrames = null; }
  const onError = (event: Event): void => {
    counts.errors += 1;
    const reason: unknown = event.type === "unhandledrejection" ? (event as PromiseRejectionEvent).reason : event instanceof ErrorEvent ? event.error : null;
    const error = reason instanceof Error ? reason : null;
    const message = error?.message ?? (event instanceof ErrorEvent ? event.message : "");
    // Only known API identifiers, never arbitrary message text, URLs or stacks.
    const apis = ["GM_xmlhttpRequest", "GM_getValue", "GM_setValue", "GM_deleteValue", "GM_listValues", "getReader", "abort", "focus", "scrollIntoView", "requestIdleCallback", "queryLocalFonts", "showPicker"];
    const api = apis.filter((name) => new RegExp(`\\b${name}\\b`).test(message)).join(",");
    const missingMethod = /^([A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*){0,5}) is not a function$/.exec(message)?.[1] ?? "";
    const category = /out of memory|allocation failed/i.test(message) ? "memory-error"
      : /call stack|recursion/i.test(message) ? "recursion"
      : /not a function/i.test(message) ? "missing-function"
      : /undefined|null/i.test(message) ? "missing-value" : "other";
    log.append("error", {
      event: event.type, name: error && /^(Error|TypeError|RangeError|ReferenceError|SyntaxError|SecurityError)$/.test(error.name) ? error.name : "unknown",
      category, api, missingMethod, line: event instanceof ErrorEvent ? event.lineno : 0, column: event instanceof ErrorEvent ? event.colno : 0,
    }, true);
    persistLog(300);
  };
  view.addEventListener("error", onError);
  view.addEventListener("unhandledrejection", onError);
  const render = (state: string): void => {
    output.textContent = [
      `HN 诊断 ${state} 心跳=${ticks} 最大延迟=${Math.round(maxDelay)}ms`,
      `触摸=${counts.touch} 指针=${counts.pointer} 点击=${counts.click} 焦点=${counts.focus} 输入=${counts.input} 滚动=${counts.scroll} 拦截=${counts.prevented} 错误=${counts.errors}`,
      `目标=${target} 命中=${hit} 活动=${active()} ${flags}`,
      `菜单=${reader()?.querySelectorAll(".hnr-select-menu").length ?? 0} 设置=${Number(Boolean(reader()?.querySelector(".hnr-settings")))}`,
      view.navigator.userAgent,
    ].join("\n");
    const storageLabel = log.storageBackend === "userscript" ? "脚本暂存" : log.storageBackend === "page" ? "页面暂存" : "暂存不可用";
    status.textContent = `HN 日志 0.0.5 ${state} ${Math.round((view.performance.now() - started) / 1000)}s · ${storageLabel}`;
  };
  const stop = (reason = "manual"): void => {
    if (stopped) return;
    stopped = true;
    pendingEvents.length = 0;
    view.clearInterval(timer);
    longTasks?.disconnect();
    longFrames?.disconnect();
    document.removeEventListener("hnr:probe-call", onRuntimeCall);
    for (const [type, handler] of listeners) document.removeEventListener(type, handler, true);
    observedRoot?.removeEventListener("scroll", onReaderScroll, true);
    view.removeEventListener("error", onError);
    view.removeEventListener("unhandledrejection", onError);
    document.removeEventListener("visibilitychange", onVisibility);
    log.append("summary", { ...counts, maxDelay: Math.round(maxDelay) });
    log.stop(reason);
    stopButton.disabled = true;
    render("已停止");
  };
  const onVisibility = (): void => { if (document.hidden) stop("hidden"); };
  const onPageHide = (): void => { stop("pagehide"); mountHost(); mountObserver.disconnect(); clearDownloads(); };
  const timer = view.setInterval(() => {
    for (const event of pendingEvents.splice(0)) if (event.defaultPrevented) {
      counts.prevented += 1;
      log.append("prevented", { event: event.type }, true);
    }
    const root = reader();
    if (root !== observedRoot) {
      observedRoot?.removeEventListener("scroll", onReaderScroll, true);
      observedRoot = root;
      observedRoot?.addEventListener("scroll", onReaderScroll, { capture: true, passive: true });
    }
    const now = view.performance.now();
    const delay = Math.max(0, now - lastTick - 500);
    maxDelay = Math.max(maxDelay, delay);
    if (delay >= 200) log.append("heartbeat-delay", { delayMs: Math.round(delay) }, true);
    lastTick = now;
    ticks += 1;
    const visible = Boolean(root?.querySelector(".hnr-settings"));
    if (visible !== settingsVisible) {
      settingsVisible = visible;
      log.append(visible ? "settings-open" : "settings-close", { active: active() }, true);
    }
    const viewport = view.visualViewport;
    const identity = `${view.innerWidth},${view.innerHeight},${viewport?.height},${viewport?.offsetTop},${viewport?.scale}`;
    if (identity !== viewportIdentity) {
      viewportIdentity = identity;
      log.append("viewport", {
        width: view.innerWidth, height: view.innerHeight,
        visibleHeight: viewport?.height ?? null, offsetTop: viewport?.offsetTop ?? null, scale: viewport?.scale ?? null,
      });
    }
    if (ticks % 4 === 0) {
      const memory = (view.performance as Performance & { memory?: { usedJSHeapSize: number; jsHeapSizeLimit: number } }).memory;
      log.append("heartbeat", {
        ticks, active: active(), menuCount: root?.querySelectorAll(".hnr-select-menu").length ?? 0,
        readerCount: document.querySelectorAll("#hn-reader-root").length,
        heapUsedBytes: memory?.usedJSHeapSize ?? null, heapLimitBytes: memory?.jsHeapSizeLimit ?? null,
      });
    }
    persistLog();
    render("运行中");
    if (now - started >= 60_000) stop("timeout");
  }, 500);
  view.addEventListener("pagehide", onPageHide);
  document.addEventListener("visibilitychange", onVisibility);
  render("运行中");
  return {
    stop: () => { stop("manual"); }, exportLog: () => log.export(),
    destroy: () => { stop("destroy"); mountObserver.disconnect(); clearDownloads(); view.removeEventListener("pagehide", onPageHide); host.remove(); },
  };
}
