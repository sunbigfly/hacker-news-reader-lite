// @vitest-environment jsdom

import { describe, expect, it, vi } from "vitest";
import { HnHostPageAdapter } from "../src/host/hn-host-page-adapter";
import { RequestScheduler } from "../src/network/request-scheduler";

const HOST_PAGE = `<html><head><title>Submit</title></head><body><center>
  <table id="hnmain"><tbody><tr><td>topbar</td></tr><tr><td id="submit-page">submit</td></tr></tbody></table>
</center></body></html>`;
const STANDALONE_PAGE = "<html><head><title>Welcome</title></head><body><main id='welcome-copy'>Welcome</main></body></html>";

describe("HnHostPageAdapter", () => {
  it("loads any read-only same-origin HN page with the signed-in native fetch", async () => {
    document.documentElement.innerHTML = "<head><base href='https://news.ycombinator.com/news'></head><body></body>";
    const scheduler = new RequestScheduler(1);
    const fetchPage = vi.fn(() => Promise.resolve(new Response(HOST_PAGE, { status: 200 })));

    const page = await new HnHostPageAdapter(document, scheduler, fetchPage).load("submit");

    expect(fetchPage).toHaveBeenCalledWith(
      "https://news.ycombinator.com/submit",
      expect.objectContaining({ credentials: "same-origin", cache: "no-store" }),
    );
    expect(page.document.getElementById("submit-page")).not.toBeNull();
    expect(page.document.baseURI).toBe("https://news.ycombinator.com/submit");
    scheduler.destroy();
  });

  it("accepts standalone HN documents that do not use #hnmain", async () => {
    document.documentElement.innerHTML = "<head><base href='https://news.ycombinator.com/news'></head><body></body>";
    const scheduler = new RequestScheduler(1);
    const fetchPage = vi.fn(() => Promise.resolve(new Response(STANDALONE_PAGE, { status: 200 })));

    const page = await new HnHostPageAdapter(document, scheduler, fetchPage)
      .load("newswelcome.html");

    expect(page.document.getElementById("welcome-copy")?.textContent).toBe("Welcome");
    expect(page.document.baseURI).toBe("https://news.ycombinator.com/newswelcome.html");
    scheduler.destroy();
  });

  it("keeps a comment hash for host positioning without sending it over HTTP", async () => {
    document.documentElement.innerHTML = "<head><base href='https://news.ycombinator.com/news'></head><body></body>";
    const scheduler = new RequestScheduler(1);
    const fetchPage = vi.fn(() => Promise.resolve(new Response(HOST_PAGE, { status: 200 })));

    const page = await new HnHostPageAdapter(document, scheduler, fetchPage)
      .load("item?id=42#101");

    expect(fetchPage).toHaveBeenCalledWith(
      "https://news.ycombinator.com/item?id=42",
      expect.any(Object),
    );
    expect(page.finalUrl).toBe("https://news.ycombinator.com/item?id=42#101");
    scheduler.destroy();
  });

  it("rejects external pages and malformed HN documents", async () => {
    document.documentElement.innerHTML = "<head><base href='https://news.ycombinator.com/news'></head><body></body>";
    const scheduler = new RequestScheduler(1);
    const fetchPage = vi.fn(() => Promise.resolve(new Response("<html></html>", { status: 200 })));
    const adapter = new HnHostPageAdapter(document, scheduler, fetchPage);

    expect(() => adapter.load("https://example.com/submit")).toThrow("不在允许范围");
    await expect(adapter.load("submit")).rejects.toThrow("缺少可呈现内容");
    scheduler.destroy();
  });
});
