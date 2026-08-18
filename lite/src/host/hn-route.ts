export type HnRoute =
  | { readonly kind: "item"; readonly itemId: number }
  | { readonly kind: "list" }
  | { readonly kind: "comments" }
  | { readonly kind: "other" };

const LIST_PATHS = new Set(["/", "/news", "/newest", "/front", "/ask", "/show", "/jobs", "/best", "/active"]);

export function isHnListPath(pathname: string): boolean {
  return LIST_PATHS.has(pathname);
}

export function parseHnRoute(location: Pick<Location, "hostname" | "pathname" | "search">): HnRoute {
  if (location.hostname !== "news.ycombinator.com") return { kind: "other" };
  if (location.pathname === "/item") {
    const raw = new URLSearchParams(location.search).get("id");
    if (raw) {
      const itemId = Number(raw);
      if (Number.isSafeInteger(itemId) && itemId > 0) return { kind: "item", itemId };
      return { kind: "other" };
    }
  }
  if (location.pathname === "/newcomments" || location.pathname === "/threads") {
    return { kind: "comments" };
  }
  return isHnListPath(location.pathname) ? { kind: "list" } : { kind: "other" };
}
