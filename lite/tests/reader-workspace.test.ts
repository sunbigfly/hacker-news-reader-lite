// @vitest-environment jsdom

import { describe, expect, it, vi } from "vitest";
import { LifecycleScope } from "../src/kernel/lifecycle";
import { readerEmbedWidth, ReaderWorkspace } from "../src/shell/reader-workspace";

describe("ReaderWorkspace", () => {
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
    expect(readerEmbedWidth(900)).toBe(468);
    expect(readerEmbedWidth(1_000, 0.6)).toBe(600);
    expect(readerEmbedWidth(1_000, 1)).toBe(750);
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
});
