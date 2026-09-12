// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";
import { LifecycleScope } from "../src/kernel/lifecycle";
import { readerEmbedWidth, ReaderWorkspace } from "../src/shell/reader-workspace";

describe("ReaderWorkspace", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
    document.documentElement.removeAttribute("op");
  });

  function mockViewport(width: number): MediaQueryList {
    const query = Object.assign(new EventTarget(), { matches: width <= 900, media: "(max-width: 900px)" });
    vi.stubGlobal("matchMedia", vi.fn(() => query));
    vi.stubGlobal("scrollTo", vi.fn());
    return query as MediaQueryList;
  }

  it.each([320, 390, 768, 820, 900])("opens a full-screen reader at %s px and restores host state on close", (width) => {
    mockViewport(width);
    document.documentElement.innerHTML = "<head></head><body style='width:85%'><center><table id='hnmain'></table></center></body>";
    const onReaderRatioChange = vi.fn();
    const scope = new LifecycleScope();
    const workspace = new ReaderWorkspace(document, scope, { readerRatio: 0.7, onReaderRatioChange });
    const center = document.querySelector<HTMLElement>("body > center");
    expect(workspace.root.dataset.layout).toBe("compact");
    expect(workspace.root.style.width).toBe("100%");
    expect(workspace.root.getAttribute("aria-modal")).toBe("true");
    expect(document.body.hasAttribute("inert")).toBe(true);
    expect(workspace.divider.hidden).toBe(true);
    workspace.divider.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowLeft" }));
    expect(onReaderRatioChange).not.toHaveBeenCalled();
    if (center) center.scrollTop = 256;
    scope.destroy();
    expect(document.body.style.width).toBe("85%");
    expect(document.body.hasAttribute("inert")).toBe(false);
    expect(center?.scrollTop).toBe(256);
    expect(document.querySelector(".hnr-workspace-return")).toBeNull();
  });

  it("restores the preferred split after rotating and removes its media listener", () => {
    const media = mockViewport(820);
    const removeListener = vi.spyOn(media, "removeEventListener");
    document.documentElement.innerHTML = "<head></head><body inert='original'><center></center></body>";
    const onReaderRatioChange = vi.fn();
    const scope = new LifecycleScope();
    const workspace = new ReaderWorkspace(document, scope, { readerRatio: 0.7, onReaderRatioChange });
    Object.assign(media, { matches: false });
    media.dispatchEvent(new Event("change"));
    expect(workspace.root.style.width).toBe("70%");
    expect(document.body.style.width).toBe("30%");
    expect(document.body.getAttribute("inert")).toBe("original");
    expect(workspace.divider.hidden).toBe(false);
    Object.assign(media, { matches: true });
    media.dispatchEvent(new Event("change"));
    expect(workspace.root.style.width).toBe("100%");
    expect(onReaderRatioChange).not.toHaveBeenCalled();
    scope.destroy();
    expect(removeListener).toHaveBeenCalledWith("change", expect.any(Function), undefined);
    expect(document.body.getAttribute("inert")).toBe("original");
  });

  it("shows native forms at full width and returns to the same reader", () => {
    mockViewport(390);
    document.documentElement.innerHTML = "<head></head><body><center></center></body>";
    const scope = new LifecycleScope();
    const onReaderRatioChange = vi.fn();
    const workspace = new ReaderWorkspace(document, scope, { onReaderRatioChange });
    workspace.mount.textContent = "保留当前讨论";
    document.documentElement.setAttribute("op", "reply");
    workspace.syncHostPageLayout();
    expect(workspace.root.style.display).toBe("none");
    expect(document.body.style.width).toBe("100%");
    expect(document.body.hasAttribute("inert")).toBe(false);
    const returnButton = document.querySelector<HTMLButtonElement>(".hnr-workspace-return");
    expect(returnButton?.hidden).toBe(false);
    returnButton?.click();
    expect(workspace.root.style.display).toBe("block");
    expect(document.body.hasAttribute("inert")).toBe(true);
    expect(workspace.mount.textContent).toBe("保留当前讨论");
    expect(returnButton?.hidden).toBe(true);
    workspace.syncHostPageLayout();
    workspace.showReader();
    expect(workspace.root.style.display).toBe("block");
    document.documentElement.setAttribute("op", "news");
    workspace.syncHostPageLayout();
    expect(workspace.root.style.display).toBe("block");
    expect(onReaderRatioChange).not.toHaveBeenCalled();
    scope.destroy();
  });

  it("fits the visible viewport for the keyboard while preserving pinch zoom and clearing pending frames", () => {
    vi.useFakeTimers();
    mockViewport(390);
    const viewport = Object.assign(new EventTarget(), { height: 600, offsetTop: 0, scale: 1 });
    vi.stubGlobal("visualViewport", viewport);
    document.documentElement.innerHTML = "<head></head><body><center></center></body>";
    const scope = new LifecycleScope();
    const workspace = new ReaderWorkspace(document, scope);
    expect(workspace.root.style.height).toBe("600px");
    Object.assign(viewport, { height: 340, offsetTop: 12 });
    viewport.dispatchEvent(new Event("resize"));
    viewport.dispatchEvent(new Event("scroll"));
    vi.advanceTimersByTime(20);
    expect(workspace.root.style.height).toBe("340px");
    expect(workspace.root.style.top).toBe("12px");
    viewport.scale = 2;
    viewport.dispatchEvent(new Event("resize"));
    vi.advanceTimersByTime(20);
    expect(workspace.root.style.height).toBe("100dvh");
    expect(workspace.root.style.top).toBe("0px");
    viewport.scale = 1;
    viewport.dispatchEvent(new Event("resize"));
    scope.destroy();
    vi.advanceTimersByTime(20);
    expect(workspace.root.style.height).toBe("100dvh");
  });

  it("truncates the HN host on the left and restores it exactly on close", () => {
    document.documentElement.innerHTML = "<head></head><body style='background:red'><center><table id='hnmain' width='85%' style='color:blue'><tbody><tr><td data-hnr-topbar></td></tr></tbody></table></center></body>";
    document.documentElement.style.setProperty("--hnr-reader-workspace-width", "40px");
    const scope = new LifecycleScope();
    const workspace = new ReaderWorkspace(document, scope);
    const hnMain = document.querySelector<HTMLElement>("#hnmain");
    expect(document.documentElement.classList.contains("hnr-reader-embedded-right")).toBe(true);
    expect(document.documentElement.style.getPropertyValue("--hnr-reader-workspace-width")).toBe("52%");
    expect(document.body.style.getPropertyValue("width")).toBe("48%");
    expect(document.body.style.getPropertyPriority("width")).toBe("important");
    expect(document.body.style.getPropertyValue("overflow-y")).toBe("hidden");
    expect(document.body.style.getPropertyValue("height")).toBe("100dvh");
    expect(document.documentElement.style.getPropertyValue("overflow-y")).toBe("hidden");
    expect(document.documentElement.style.getPropertyValue("--hnr-host-topbar-height")).toBe("48px");
    expect(document.querySelector<HTMLElement>("body > center")?.style.getPropertyValue("overflow-y")).toBe("auto");
    expect(document.querySelector<HTMLElement>("body > center")?.style.getPropertyValue("top")).toBe("var(--hnr-host-topbar-height)");
    expect(hnMain?.style.getPropertyValue("min-width")).toBe("0");
    expect(workspace.root.style.getPropertyValue("width")).toBe("52%");
    expect(workspace.root.style.getPropertyPriority("width")).toBe("important");
    expect(workspace.root.parentElement).toBe(document.documentElement);
    expect(document.querySelector("#hn-reader-workspace")).toBe(workspace.root);
    expect(workspace.divider.getAttribute("role")).toBe("separator");
    const workspaceStyle = document.querySelector("[data-hnr-workspace-style]")?.textContent;
    expect(workspaceStyle).toContain("width: var(--hnr-host-workspace-width) !important");
    expect(workspaceStyle).toContain("scrollbar-width: thin !important");
    expect(workspaceStyle).toContain("padding-left: 5px !important");
    expect(workspaceStyle).toContain("body > center::-webkit-scrollbar { width: 5px");
    expect(workspaceStyle).toContain("border-left: 0");
    expect(workspaceStyle).toContain("box-shadow: none");
    expect(workspaceStyle).toContain(".hnr-workspace-divider::before");
    expect(workspaceStyle).toMatch(/\.hnr-workspace-divider\s*\{[^}]*z-index: 6;/);
    workspace.destroy();
    expect(document.documentElement.classList.contains("hnr-reader-embedded-right")).toBe(false);
    expect(document.querySelector("#hn-reader-workspace")).toBeNull();
    expect(document.documentElement.style.getPropertyValue("--hnr-reader-workspace-width")).toBe("40px");
    expect(document.body.getAttribute("style")).toBe("background: red;");
    expect(hnMain?.getAttribute("style")).toBe("color: blue;");
  });

  it("starts at 52 percent and supports other persisted ratios", () => {
    expect(readerEmbedWidth(2048)).toBe(1065);
    expect(readerEmbedWidth(1440)).toBe(749);
    expect(readerEmbedWidth(1100)).toBe(572);
    expect(readerEmbedWidth(900)).toBe(900);
    expect(readerEmbedWidth(390, 0.7)).toBe(390);
    expect(readerEmbedWidth(1_000, 0.6)).toBe(600);
    expect(readerEmbedWidth(1_000, 1)).toBe(900);
  });

  it("temporarily widens the host for native reply and submit forms", () => {
    document.documentElement.innerHTML = "<head></head><body><center><table id='hnmain'></table></center></body>";
    const onReaderRatioChange = vi.fn();
    const scope = new LifecycleScope();
    const workspace = new ReaderWorkspace(document, scope, { onReaderRatioChange });

    document.documentElement.setAttribute("op", "reply");
    workspace.syncHostPageLayout();
    expect(workspace.root.style.getPropertyValue("width")).toBe("38%");
    expect(document.body.style.getPropertyValue("width")).toBe("62%");
    expect(onReaderRatioChange).not.toHaveBeenCalled();

    document.documentElement.setAttribute("op", "news");
    workspace.syncHostPageLayout();
    expect(workspace.root.style.getPropertyValue("width")).toBe("52%");
    expect(document.body.style.getPropertyValue("width")).toBe("48%");
    expect(onReaderRatioChange).not.toHaveBeenCalled();
    scope.destroy();
  });

  it("releases the automatic form width as soon as the divider is dragged", () => {
    document.documentElement.innerHTML = "<head></head><body><center><table id='hnmain'></table></center></body>";
    const onReaderRatioChange = vi.fn();
    const scope = new LifecycleScope();
    const workspace = new ReaderWorkspace(document, scope, { onReaderRatioChange });
    const viewportWidth = window.innerWidth;

    document.documentElement.setAttribute("op", "reply");
    workspace.syncHostPageLayout();
    expect(workspace.root.style.getPropertyValue("width")).toBe("38%");

    workspace.divider.dispatchEvent(new MouseEvent("pointerdown", {
      bubbles: true,
      button: 0,
      clientX: viewportWidth * 0.62,
    }));
    window.dispatchEvent(new MouseEvent("pointermove", {
      bubbles: true,
      clientX: viewportWidth / 2,
    }));
    window.dispatchEvent(new MouseEvent("pointerup", {
      bubbles: true,
      clientX: viewportWidth / 2,
    }));

    expect(workspace.root.style.getPropertyValue("width")).toBe("50%");
    expect(document.body.style.getPropertyValue("width")).toBe("50%");
    expect(onReaderRatioChange).toHaveBeenCalledOnce();
    expect(onReaderRatioChange).toHaveBeenCalledWith(0.5);
    scope.destroy();
  });

  it("resizes from the divider and commits the ratio when the pointer is released", () => {
    document.documentElement.innerHTML = "<head></head><body><center><table id='hnmain'></table></center></body>";
    const onReaderRatioChange = vi.fn();
    const scope = new LifecycleScope();
    const workspace = new ReaderWorkspace(document, scope, { onReaderRatioChange });
    const viewportWidth = window.innerWidth;

    workspace.divider.dispatchEvent(new MouseEvent("pointerdown", {
      bubbles: true,
      button: 0,
      clientX: viewportWidth / 2,
    }));
    window.dispatchEvent(new MouseEvent("pointermove", {
      bubbles: true,
      clientX: viewportWidth / 4,
    }));
    window.dispatchEvent(new MouseEvent("pointerup", {
      bubbles: true,
      clientX: viewportWidth / 4,
    }));

    expect(workspace.root.style.getPropertyValue("width")).toBe("75%");
    expect(document.body.style.getPropertyValue("width")).toBe("25%");
    expect(workspace.divider.getAttribute("aria-valuenow")).toBe("75");
    expect(onReaderRatioChange).toHaveBeenCalledOnce();
    expect(onReaderRatioChange).toHaveBeenCalledWith(0.75);
    scope.destroy();
  });

  it("lets the host collapse to ten percent without losing persistence", () => {
    document.documentElement.innerHTML = "<head></head><body><center><table id='hnmain'></table></center></body>";
    const onReaderRatioChange = vi.fn();
    const scope = new LifecycleScope();
    const workspace = new ReaderWorkspace(document, scope, { onReaderRatioChange });
    const viewportWidth = window.innerWidth;

    workspace.divider.dispatchEvent(new MouseEvent("pointerdown", {
      bubbles: true,
      button: 0,
      clientX: viewportWidth / 2,
    }));
    window.dispatchEvent(new MouseEvent("pointermove", {
      bubbles: true,
      clientX: viewportWidth * 0.05,
    }));
    window.dispatchEvent(new MouseEvent("pointerup", {
      bubbles: true,
      clientX: viewportWidth * 0.05,
    }));

    expect(workspace.root.style.getPropertyValue("width")).toBe("90%");
    expect(document.body.style.getPropertyValue("width")).toBe("10%");
    expect(workspace.divider.getAttribute("aria-valuemax")).toBe("90");
    expect(onReaderRatioChange).toHaveBeenCalledWith(0.9);
    scope.destroy();
  });
});
