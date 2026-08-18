// @vitest-environment jsdom

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { HnPageFetchAdapter } from "../src/host/hn-page-fetch-adapter";
import { RequestScheduler } from "../src/network/request-scheduler";

describe("HnPageFetchAdapter", () => {
  it("loads a detached host comment page with anonymous native fetch and a stable HN base URL", async () => {
    const scheduler = new RequestScheduler(1);
    const body = readFileSync(resolve("lite/fixtures/hn-item.html"), "utf8");
    const fetchPage = vi.fn(() => Promise.resolve(new Response(body, {
      status: 200,
      headers: { "content-type": "text/html" },
    })));

    const page = await new HnPageFetchAdapter(document, scheduler, fetchPage).load(100 as never);

    expect(fetchPage).toHaveBeenCalledWith(
      "https://news.ycombinator.com/item?id=100",
      expect.objectContaining({ credentials: "omit", cache: "no-store" }),
    );
    expect(page.document).not.toBe(document);
    expect(page.document.baseURI).toBe("https://news.ycombinator.com/item?id=100");
    expect(page.document.querySelectorAll("tr.athing.comtr")).toHaveLength(4);
    scheduler.destroy();
  });
});
