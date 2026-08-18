// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";
import {
  authorAvatarDataUri,
  authorAvatarLibrarySource,
  createAuthorAvatarElement,
} from "../src/avatar/author-avatar";

const previousGenerator = (globalThis as typeof globalThis & { readonly multiavatar?: unknown }).multiavatar;

afterEach(() => {
  if (previousGenerator === undefined) Reflect.deleteProperty(globalThis, "multiavatar");
  else Reflect.set(globalThis, "multiavatar", previousGenerator);
});

describe("author avatar", () => {
  it("uses a normalized versioned author seed and caches a deterministic data URI", () => {
    const generate = vi.fn((seed: string) => `<svg xmlns="http://www.w3.org/2000/svg"><text>${seed.length}</text></svg>`);
    Reflect.set(globalThis, "multiavatar", generate);

    const first = authorAvatarDataUri("  Stable-User-101  ");
    const second = authorAvatarDataUri("stable-user-101");

    expect(first).toBe(second);
    expect(first).toMatch(/^data:image\/svg\+xml;charset=utf-8,/);
    expect(generate).toHaveBeenCalledTimes(1);
    expect(generate).toHaveBeenCalledWith("hnr-avatar-v1:stable-user-101");
  });

  it("keeps the monogram fallback when the library or author is unavailable", () => {
    Reflect.deleteProperty(globalThis, "multiavatar");
    expect(authorAvatarDataUri("fallback-user-102")).toBeNull();
    expect(authorAvatarDataUri(null)).toBeNull();
    expect(authorAvatarDataUri("   ")).toBeNull();

    Reflect.set(globalThis, "multiavatar", () => "not-svg");
    expect(authorAvatarDataUri("invalid-user-103")).toBeNull();
  });

  it("creates a decorative inline SVG that is not subject to the host image CSP", () => {
    Reflect.set(globalThis, "multiavatar", () => '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 8 8"><path d="M0 0h8v8z" style="fill:#f60"/></svg>');
    const avatar = createAuthorAvatarElement(document, "image-user-104");

    expect(avatar?.classList.contains("hnr-author-avatar")).toBe(true);
    expect(avatar?.tagName.toLowerCase()).toBe("svg");
    expect(avatar?.hasAttribute("src")).toBe(false);
    expect(avatar?.getAttribute("aria-hidden")).toBe("true");
    expect(avatar?.getAttribute("focusable")).toBe("false");
    expect(avatar?.outerHTML).not.toContain("image-user-104");
  });

  it("rejects generated SVG outside the avatar allowlist", () => {
    Reflect.set(globalThis, "multiavatar", () => '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>');
    expect(createAuthorAvatarElement(document, "unsafe-user-105")).toBeNull();
  });

  it("exports a script-safe copy of the loaded generator for offline HTML", () => {
    function multiavatar(seed: string): string {
      return `<svg><text>${seed}</text></svg><!-- </script> -->`;
    }
    Reflect.set(globalThis, "multiavatar", multiavatar);

    const source = authorAvatarLibrarySource();
    expect(source).toContain("function multiavatar(");
    expect(source).not.toContain("</script>");
    expect(source).toContain("<\\/script>");
  });
});
