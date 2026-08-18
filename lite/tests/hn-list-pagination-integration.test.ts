// @vitest-environment jsdom

import { describe, expect, it, vi } from "vitest";
import { HnHostController } from "../src/host/hn-host-controller";
import { HnListPageAdapter } from "../src/host/hn-list-page-adapter";
import { HnListPaginationController } from "../src/host/hn-list-pagination-controller";
import { LifecycleScope } from "../src/kernel/lifecycle";
import { RequestScheduler } from "../src/network/request-scheduler";

describe("HN host list pagination integration", () => {
  it("fetches and mounts the next page behind the existing embedded list", async () => {
    document.documentElement.innerHTML = `<head><base href="https://news.ycombinator.com/front"></head><body><center>
      <table><tbody>
        <tr class="athing" id="42"><td class="title"></td><td class="votelinks"></td><td class="title"><span class="titleline"><a href="https://example.com/one">One</a></span></td></tr>
        <tr><td></td><td class="subtext">1 comment</td></tr>
        <tr><td><a class="morelink" href="front?p=2">More</a></td></tr>
      </tbody></table>
      <footer id="native-footer">Guidelines · FAQ</footer>
    </center></body>`;
    document.documentElement.classList.add("hnr-reader-embedded-right");
    const center = document.querySelector<HTMLElement>("body > center");
    if (!center) throw new Error("embedded host scroller was not created");
    let scrollHeight = 2_000;
    Object.defineProperties(center, {
      scrollHeight: { configurable: true, get: () => scrollHeight },
      clientHeight: { configurable: true, value: 800 },
      scrollTop: { configurable: true, value: 1_000, writable: true },
    });
    const nextPage = `<html><head></head><body><table><tbody>
      <tr class="athing" id="43"><td class="title"></td><td class="votelinks"></td><td class="title"><span class="titleline"><a href="https://example.com/two">Two</a></span></td></tr>
      <tr><td></td><td class="subtext">2 comments</td></tr>
      <tr><td><a class="morelink" href="front?p=3">More</a></td></tr>
    </tbody></table></body></html>`;
    const fetchPage = vi.fn(() => {
      scrollHeight = 4_000;
      return Promise.resolve(new Response(nextPage, { status: 200 }));
    });
    const scheduler = new RequestScheduler(1);
    const scope = new LifecycleScope();
    const host = new HnHostController(document, { kind: "list" }, vi.fn(), "", scope);
    host.install();
    expect(document.querySelector("tr.athing")?.closest("table")?.classList.contains("itemlist"))
      .toBe(true);
    const pagination = new HnListPaginationController(
      document,
      new HnListPageAdapter(document, scheduler, fetchPage),
      host,
      scope,
    );
    pagination.install();

    center.dispatchEvent(new Event("scroll"));

    await vi.waitFor(() => {
      expect(document.querySelector('[data-hnr-card-open="43"]')).not.toBeNull();
    });
    expect(fetchPage).toHaveBeenCalledOnce();
    expect([...document.querySelectorAll("tr.athing")].map((row) => row.id)).toEqual(["42", "43"]);
    expect(host.nextPageUrl()).toBe("https://news.ycombinator.com/front?p=3");
    expect(document.querySelectorAll("#native-footer")).toHaveLength(1);
    expect(document.querySelector("table.itemlist")?.nextElementSibling?.id).toBe("native-footer");

    scope.destroy();
    scheduler.destroy();
    document.documentElement.classList.remove("hnr-reader-embedded-right");
  });
});
