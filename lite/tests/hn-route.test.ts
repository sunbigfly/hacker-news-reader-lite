import { describe, expect, it } from "vitest";
import { parseHnRoute } from "../src/host/hn-route";

describe("HN route", () => {
  it("recognizes item and list routes without broad host matching", () => {
    expect(parseHnRoute({ hostname: "news.ycombinator.com", pathname: "/item", search: "?id=123" })).toEqual({ kind: "item", itemId: 123 });
    for (const pathname of ["/", "/news", "/newest", "/front", "/ask", "/show", "/jobs", "/best", "/active"]) {
      expect(parseHnRoute({ hostname: "news.ycombinator.com", pathname, search: "" })).toEqual({ kind: "list" });
    }
    expect(parseHnRoute({ hostname: "news.ycombinator.com", pathname: "/newcomments", search: "" })).toEqual({ kind: "comments" });
    expect(parseHnRoute({ hostname: "news.ycombinator.com", pathname: "/threads", search: "?id=tester" })).toEqual({ kind: "comments" });
    expect(parseHnRoute({ hostname: "example.com", pathname: "/item", search: "?id=123" })).toEqual({ kind: "other" });
  });
});
