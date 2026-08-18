// @vitest-environment jsdom

import { describe, expect, it, vi } from "vitest";
import { HnListPageAdapter } from "../src/host/hn-list-page-adapter";
import { RequestScheduler } from "../src/network/request-scheduler";

const PAGE_HTML = `<html><head></head><body><table><tbody>
  <tr class="athing" id="43"><td class="title">Next story</td></tr>
</tbody></table></body></html>`;

describe("HnListPageAdapter", () => {
  it("loads a signed-in same-origin HN list page with native fetch", async () => {
    document.documentElement.innerHTML = "<head><base href='https://news.ycombinator.com/front'></head><body></body>";
    const scheduler = new RequestScheduler(1);
    const fetchPage = vi.fn(() => Promise.resolve(new Response(PAGE_HTML, {
      status: 200,
      headers: { "content-type": "text/html" },
    })));
    const page = await new HnListPageAdapter(document, scheduler, fetchPage).load("?p=2");

    expect(fetchPage).toHaveBeenCalledWith(
      "https://news.ycombinator.com/front?p=2",
      expect.objectContaining({ credentials: "same-origin", cache: "no-store" }),
    );
    expect(page.document).not.toBe(document);
    expect(page.document.baseURI).toBe("https://news.ycombinator.com/front?p=2");
    expect(page.document.querySelector("tr.athing")?.id).toBe("43");
    expect(page.document.querySelector("tr.athing")?.closest("table")?.classList.contains("itemlist"))
      .toBe(true);
    scheduler.destroy();
  });

  it("rejects non-HN and non-list pagination URLs before requesting", () => {
    document.documentElement.innerHTML = "<head><base href='https://news.ycombinator.com/front'></head><body></body>";
    const scheduler = new RequestScheduler(1);
    const fetchPage = vi.fn<typeof fetch>();
    const adapter = new HnListPageAdapter(document, scheduler, fetchPage);

    expect(() => adapter.load("https://example.com/front?p=2")).toThrow("不在允许范围");
    expect(() => adapter.load("https://news.ycombinator.com/logout")).toThrow("不在允许范围");
    expect(fetchPage).not.toHaveBeenCalled();
    scheduler.destroy();
  });
});
