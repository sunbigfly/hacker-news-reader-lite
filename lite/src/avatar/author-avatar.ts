const AVATAR_SEED_PREFIX = "hnr-avatar-v1:";
const AVATAR_CACHE_LIMIT = 256;
const SVG_DATA_URI_PREFIX = "data:image/svg+xml;charset=utf-8,";
const SVG_NAMESPACE = "http://www.w3.org/2000/svg";

const ALLOWED_SVG_ELEMENTS = new Set(["line", "path", "polygon", "rect", "svg"]);
const ALLOWED_SVG_ATTRIBUTES = new Set([
  "d", "height", "points", "ry", "style", "transform", "viewBox", "width", "x", "x1", "x2", "xmlns", "y", "y1", "y2",
]);
const ALLOWED_STYLE_PROPERTIES = new Set(["fill", "opacity", "stroke", "stroke-linecap", "stroke-linejoin", "stroke-width"]);

type MultiavatarGenerator = (seed: string, sansEnvironment?: boolean, version?: string) => string;

declare const multiavatar: MultiavatarGenerator | undefined;

const avatarCache = new Map<string, string>();

function generator(): MultiavatarGenerator | null {
  if (typeof multiavatar === "function") return multiavatar;
  const candidate = (globalThis as typeof globalThis & { readonly multiavatar?: unknown }).multiavatar;
  return typeof candidate === "function" ? candidate as MultiavatarGenerator : null;
}

function normalizedAuthor(author: string | null): string | null {
  const value = author?.trim().toLowerCase() ?? "";
  return value.length > 0 ? value : null;
}

function cacheAvatar(seed: string, source: string): void {
  avatarCache.set(seed, source);
  if (avatarCache.size <= AVATAR_CACHE_LIMIT) return;
  const oldest = avatarCache.keys().next();
  if (!oldest.done) avatarCache.delete(oldest.value);
}

function authorAvatarSvg(author: string | null): string | null {
  const value = normalizedAuthor(author);
  const createAvatar = generator();
  if (!value || !createAvatar) return null;
  const seed = `${AVATAR_SEED_PREFIX}${value}`;
  const cached = avatarCache.get(seed);
  if (cached) return cached;
  try {
    const svg = createAvatar(seed);
    if (!svg.startsWith("<svg") || !svg.endsWith("</svg>")) return null;
    cacheAvatar(seed, svg);
    return svg;
  } catch {
    return null;
  }
}

export function authorAvatarDataUri(author: string | null): string | null {
  const svg = authorAvatarSvg(author);
  return svg ? `${SVG_DATA_URI_PREFIX}${encodeURIComponent(svg)}` : null;
}

function hasAllowedStyle(element: Element): boolean {
  const source = element.getAttribute("style");
  if (!source) return true;
  return source.split(";").every((declaration) => {
    const value = declaration.trim();
    if (!value) return true;
    const separator = value.indexOf(":");
    if (separator <= 0) return false;
    const property = value.slice(0, separator).trim().toLowerCase();
    const propertyValue = value.slice(separator + 1).trim();
    return ALLOWED_STYLE_PROPERTIES.has(property)
      && propertyValue.length > 0
      && !/(?:url\s*\(|expression\s*\(|@import|javascript:|data:)/i.test(propertyValue);
  });
}

function isAllowedSvg(root: Element): root is SVGSVGElement {
  if (root.namespaceURI !== SVG_NAMESPACE || root.localName !== "svg") return false;
  return [root, ...root.querySelectorAll("*")].every((element) => (
    element.namespaceURI === SVG_NAMESPACE
    && ALLOWED_SVG_ELEMENTS.has(element.localName)
    && [...element.attributes].every((attribute) => ALLOWED_SVG_ATTRIBUTES.has(attribute.name))
    && hasAllowedStyle(element)
  ));
}

export function createAuthorAvatarElement(document: Document, author: string | null): SVGSVGElement | null {
  const source = authorAvatarSvg(author);
  const DOMParserConstructor = document.defaultView?.DOMParser;
  if (!source || !DOMParserConstructor) return null;
  const parsed = new DOMParserConstructor().parseFromString(source, "image/svg+xml");
  if (!isAllowedSvg(parsed.documentElement)) return null;
  const avatar = document.importNode(parsed.documentElement, true);
  avatar.classList.add("hnr-author-avatar");
  avatar.setAttribute("width", "32");
  avatar.setAttribute("height", "32");
  avatar.setAttribute("aria-hidden", "true");
  avatar.setAttribute("focusable", "false");
  return avatar;
}

export function authorAvatarLibrarySource(): string | null {
  const createAvatar = generator();
  if (!createAvatar) return null;
  const source = Function.prototype.toString.call(createAvatar);
  if (!source.startsWith("function multiavatar(") || !source.includes("</svg>")) return null;
  return source.replace(/<\/script/gi, "<\\/script");
}
