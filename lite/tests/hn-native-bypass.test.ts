import { describe, expect, it, vi } from "vitest";
import { activateHnNativeTabBypass, nativeHnItemUrl } from "../src/host/hn-native-bypass";

function tabWindow(storage = new Map<string, string>()) {
  return {
    storage,
    window: {
      sessionStorage: {
        getItem: (key: string) => storage.get(key) ?? null,
        setItem: (key: string, value: string) => { storage.set(key, value); },
      },
      history: {
        state: { route: "native" },
        replaceState: vi.fn(),
      },
    },
  };
}

describe("HN native tab bypass", () => {
  it("marks original-item URLs for a native HN tab", () => {
    const url = new URL(nativeHnItemUrl(42));
    expect(url.origin).toBe("https://news.ycombinator.com");
    expect(url.pathname).toBe("/item");
    expect(url.searchParams.get("id")).toBe("42");
    expect(url.searchParams.get("hnr_native")).toBe("1");
  });

  it("persists native mode per tab and removes the one-time query marker", () => {
    const nativeTab = tabWindow();
    expect(activateHnNativeTabBypass(nativeHnItemUrl(42), nativeTab.window)).toBe(true);
    expect(nativeTab.window.history.replaceState).toHaveBeenCalledWith(
      { route: "native" },
      "",
      "https://news.ycombinator.com/item?id=42",
    );
    expect(activateHnNativeTabBypass("https://news.ycombinator.com/news", nativeTab.window)).toBe(true);
  });

  it("does not bypass ordinary Reader tabs", () => {
    const readerTab = tabWindow();
    expect(activateHnNativeTabBypass("https://news.ycombinator.com/item?id=42", readerTab.window)).toBe(false);
    expect(readerTab.window.history.replaceState).not.toHaveBeenCalled();
  });

  it("keeps the query marker when session storage is unavailable", () => {
    const replaceState = vi.fn();
    const unavailableTab = {
      sessionStorage: {
        getItem: () => { throw new Error("blocked"); },
        setItem: () => { throw new Error("blocked"); },
      },
      history: { state: null, replaceState },
    };
    expect(activateHnNativeTabBypass(nativeHnItemUrl(42), unavailableTab)).toBe(true);
    expect(replaceState).not.toHaveBeenCalled();
  });
});
