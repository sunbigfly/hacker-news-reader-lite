const ALLOWED_ELEMENTS = new Set([
  "a", "b", "blockquote", "br", "code", "del", "em", "figcaption", "figure",
  "h1", "h2", "h3", "h4", "h5", "h6", "hr", "i", "img", "li", "ol", "p",
  "pre", "s", "small", "span", "strong", "sub", "sup", "table", "tbody", "td",
  "th", "thead", "tr", "u", "ul",
]);
const DROP_WITH_CONTENT = new Set(["audio", "button", "canvas", "embed", "form", "iframe", "input", "object", "script", "select", "style", "svg", "textarea", "video"]);

function safeUrl(raw: string, baseUrl: string, kind: "link" | "image"): string | null {
  try {
    const url = new URL(raw, baseUrl);
    const protocols = kind === "link" ? new Set(["http:", "https:", "mailto:"]) : new Set(["http:", "https:"]);
    return protocols.has(url.protocol) ? url.href : null;
  } catch {
    return null;
  }
}

export function sanitizeHtml(rawHtml: string, document: Document, baseUrl: string): string {
  const template = document.createElement("template");
  template.innerHTML = rawHtml;
  for (const element of [...template.content.querySelectorAll("*")]) {
    const tagName = element.localName.toLowerCase();
    if (!ALLOWED_ELEMENTS.has(tagName)) {
      if (DROP_WITH_CONTENT.has(tagName)) element.remove();
      else element.replaceWith(...element.childNodes);
      continue;
    }
    const originalHref = element.getAttribute("href");
    const originalSrc = element.getAttribute("src");
    for (const attribute of [...element.attributes]) element.removeAttribute(attribute.name);
    if (tagName === "a") {
      const href = originalHref ? safeUrl(originalHref, baseUrl, "link") : null;
      if (href) {
        element.setAttribute("href", href);
        element.setAttribute("target", "_blank");
        element.setAttribute("rel", "noopener noreferrer");
      }
    }
    if (tagName === "img") {
      const src = originalSrc ? safeUrl(originalSrc, baseUrl, "image") : null;
      if (!src) {
        element.remove();
        continue;
      }
      element.setAttribute("src", src);
      element.setAttribute("alt", "");
      element.setAttribute("loading", "lazy");
      element.setAttribute("decoding", "async");
    }
  }
  return template.innerHTML;
}

export function textFromHtml(html: string, document: Document): string {
  const template = document.createElement("template");
  template.innerHTML = html;
  return (template.content.textContent ?? "").replace(/\s+/g, " ").trim();
}
