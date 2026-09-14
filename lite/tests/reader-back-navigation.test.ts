// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";
import { LifecycleScope } from "../src/kernel/lifecycle";
import { ReaderBackNavigation } from "../src/shell/reader-back-navigation";

const scopes: LifecycleScope[] = [];
afterEach(() => {
  for (const scope of scopes.splice(0)) scope.destroy();
  vi.restoreAllMocks();
});

function setup() {
  history.replaceState({ host: "preserved" }, "", "/news?p=3#story");
  history.scrollRestoration = "auto";
  const scope = new LifecycleScope();
  scopes.push(scope);
  const hostNavigation = vi.fn();
  scope.listen(window, "popstate", hostNavigation);
  const onBack = vi.fn();
  const navigation = new ReaderBackNavigation(window, scope, onBack);
  return { navigation, onBack, hostNavigation };
}

describe("mobile Reader back navigation", () => {
  it("closes Reader with one back step, preserving host URL/state and suppressing host navigation", async () => {
    const { navigation, onBack, hostNavigation } = setup();
    const url = location.href;
    const length = history.length;
    navigation.setActive(true);
    navigation.setActive(true);
    expect(history.length).toBe(length + 1);
    expect(location.href).toBe(url);
    history.back();
    await vi.waitFor(() => expect(onBack).toHaveBeenCalledOnce());
    expect(hostNavigation).not.toHaveBeenCalled();
    expect(location.href).toBe(url);
    expect(history.state).toEqual({ host: "preserved" });
    expect(history.scrollRestoration).toBe("auto");
    window.dispatchEvent(new PopStateEvent("popstate"));
    expect(hostNavigation).toHaveBeenCalledOnce();
  });

  it("removes the extra step after the close button without reloading the host", async () => {
    const { navigation, onBack, hostNavigation } = setup();
    navigation.setActive(true);
    navigation.setActive(false);
    await vi.waitFor(() => expect(history.state).toEqual({ host: "preserved" }));
    expect(onBack).not.toHaveBeenCalled();
    expect(hostNavigation).not.toHaveBeenCalled();
  });

  it("keeps a quickly reopened Reader protected while its previous close is still traversing history", async () => {
    const { navigation, onBack, hostNavigation } = setup();
    navigation.setActive(true);
    const firstState: unknown = history.state;
    navigation.setActive(false);
    navigation.setActive(true);
    await vi.waitFor(() => expect(history.state).not.toEqual(firstState));
    expect(history.state).not.toEqual({ host: "preserved" });
    expect(onBack).not.toHaveBeenCalled();
    history.back();
    await vi.waitFor(() => expect(onBack).toHaveBeenCalledOnce());
    expect(hostNavigation).not.toHaveBeenCalled();
  });

  it("leaves desktop and native form navigation alone", () => {
    const { navigation, onBack, hostNavigation } = setup();
    const push = vi.spyOn(history, "pushState");
    navigation.setActive(false);
    window.dispatchEvent(new PopStateEvent("popstate"));
    expect(push).not.toHaveBeenCalled();
    expect(hostNavigation).toHaveBeenCalledOnce();
    expect(onBack).not.toHaveBeenCalled();
  });
});
