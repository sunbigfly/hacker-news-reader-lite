import { describe, expect, it } from "vitest";
import { assertSafeExternalUrl } from "../src/article/url-policy";

describe("article URL policy", () => {
  it.each([
    "http://localhost/a", "http://127.0.0.1/a", "http://10.0.0.1/a", "http://169.254.1.1/a",
    "http://172.16.0.1/a", "http://192.168.1.1/a", "http://[::1]/a", "http://service.local/a",
    "file:///tmp/a", "https://user:pass@example.com/a",
  ])("rejects unsafe target %s", (url) => {
    expect(() => assertSafeExternalUrl(url)).toThrow();
  });
  it("accepts public HTTP(S) and strips fragments", () => {
    expect(assertSafeExternalUrl("https://example.com/post#comments").href).toBe("https://example.com/post");
  });
});
