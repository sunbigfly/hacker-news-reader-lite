const BLOCKED_HOST_SUFFIXES = [".localhost", ".local", ".internal", ".home", ".lan"];

function blockedIpv4(hostname: string): boolean {
  const parts = hostname.split(".").map(Number);
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return false;
  const [a = 0, b = 0] = parts;
  return a === 0
    || a === 10
    || a === 127
    || (a === 100 && b >= 64 && b <= 127)
    || (a === 169 && b === 254)
    || (a === 172 && b >= 16 && b <= 31)
    || (a === 192 && (b === 0 || b === 168))
    || (a === 198 && (b === 18 || b === 19 || b === 51))
    || (a === 203 && b === 0)
    || a >= 224;
}

function blockedIpv6(hostname: string): boolean {
  const host = hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (!host.includes(":")) return false;
  return host === "::" || host === "::1" || host.startsWith("fc") || host.startsWith("fd") || host.startsWith("fe8") || host.startsWith("fe9") || host.startsWith("fea") || host.startsWith("feb") || host.startsWith("2001:db8");
}

export function assertSafeExternalUrl(rawUrl: string): URL {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new Error("文章 URL 无效");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("文章 URL 只允许 HTTP(S)");
  if (url.username || url.password) throw new Error("文章 URL 不允许包含用户信息");
  const hostname = url.hostname.toLowerCase().replace(/\.$/, "");
  if (hostname === "localhost" || BLOCKED_HOST_SUFFIXES.some((suffix) => hostname.endsWith(suffix)) || blockedIpv4(hostname) || blockedIpv6(hostname)) {
    throw new Error("文章 URL 指向本机、私网或保留地址");
  }
  url.hash = "";
  return url;
}
