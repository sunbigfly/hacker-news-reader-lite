const HN_ORIGIN = "https://news.ycombinator.com";
const HN_NATIVE_BYPASS_PARAM = "hnr_native";
const HN_NATIVE_BYPASS_TAB_KEY = "hnr:native-tab:v1";

interface NativeTabWindow {
  readonly sessionStorage: Pick<Storage, "getItem" | "setItem">;
  readonly history: Pick<History, "replaceState" | "state">;
}

export function nativeHnItemUrl(itemId: number): string {
  if (!Number.isSafeInteger(itemId) || itemId <= 0) throw new RangeError("HN item id must be a positive safe integer");
  const url = new URL("/item", HN_ORIGIN);
  url.searchParams.set("id", String(itemId));
  url.searchParams.set(HN_NATIVE_BYPASS_PARAM, "1");
  return url.href;
}

export function activateHnNativeTabBypass(
  rawUrl: string,
  pageWindow: NativeTabWindow,
): boolean {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return false;
  }
  const requested = url.origin === HN_ORIGIN
    && url.searchParams.get(HN_NATIVE_BYPASS_PARAM) === "1";
  let persisted = false;
  try {
    if (requested) pageWindow.sessionStorage.setItem(HN_NATIVE_BYPASS_TAB_KEY, "1");
    persisted = pageWindow.sessionStorage.getItem(HN_NATIVE_BYPASS_TAB_KEY) === "1";
  } catch {
    // Keep the query marker when session storage is unavailable so reload remains native.
  }
  if (requested && persisted) {
    url.searchParams.delete(HN_NATIVE_BYPASS_PARAM);
    try {
      pageWindow.history.replaceState(pageWindow.history.state, "", url.href);
    } catch {
      // The active tab is still native even if the address bar cannot be cleaned.
    }
  }
  return requested || persisted;
}
