import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, URL } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const directPath = path.join(root, "work/hacker-news-reader-lite.local.user.js");
const reportPath = `${directPath}.build.json`;
const resourcePath = path.join(root, "work/hacker-news-reader-lite.local.js");
const loaderPath = path.join(root, "work/hacker-news-reader-lite.local-debug.user.js");
const expectedExternalRequires = [
  "https://cdn.jsdelivr.net/npm/@multiavatar/multiavatar@1.0.7/multiavatar.min.js#sha256=c9d10f8a91ef3e2b9dceda9a9d5cb87fb61eb9f6dd67c0f4a478a7363587aaae",
];

const [direct, reportSource, resource, loader] = await Promise.all([
  readFile(directPath, "utf8"),
  readFile(reportPath, "utf8"),
  readFile(resourcePath, "utf8"),
  readFile(loaderPath, "utf8"),
]);
const report = JSON.parse(reportSource);
const digest = (value) => createHash("sha256").update(value).digest("hex");

if (report.mode !== "local" || !report.localDebug) {
  throw new Error("local build report is missing localDebug metadata");
}
if (!direct.startsWith("// ==UserScript==")) {
  throw new Error("direct local userscript is missing metadata");
}
if (resource.includes("// ==UserScript==")) {
  throw new Error("local resource must be a metadata-free JavaScript bundle");
}
if (!resource.includes("sourceMappingURL=data:application/json")) {
  throw new Error("local resource is missing its inline source map");
}

const resourceSha256 = digest(resource);
const loaderSha256 = digest(loader);
if (
  report.localDebug.resourceSha256 !== resourceSha256
  || report.localDebug.resourceBytes !== Buffer.byteLength(resource)
  || report.localDebug.loaderSha256 !== loaderSha256
  || report.localDebug.loaderBytes !== Buffer.byteLength(loader)
) {
  throw new Error("local debug files do not match the build report");
}

const requires = [...loader.matchAll(/^\/\/ @require\s+(\S+)$/gm)].map((match) => match[1]);
const localRequires = requires.filter((value) => value?.startsWith("file:///"));
const externalRequires = requires.filter((value) => !value?.startsWith("file:///"));
const resourceValue = localRequires[0];
if (localRequires.length !== 1 || resourceValue !== report.localDebug.resourceUrl) {
  throw new Error("loader @require does not match the build report");
}
if (JSON.stringify(externalRequires) !== JSON.stringify(expectedExternalRequires)) {
  throw new Error(`local loader external requires drifted: ${JSON.stringify(externalRequires)}`);
}
const resourceUrl = new URL(resourceValue);
if (resourceUrl.protocol !== "file:" || resourceUrl.searchParams.get("v") !== resourceSha256) {
  throw new Error("loader @require must be a content-versioned file:// URL");
}

const matches = [...loader.matchAll(/^\/\/ @match\s+(.+)$/gm)].map((match) => match[1]?.trim());
if (matches.length !== 1 || matches[0] !== "https://news.ycombinator.com/*") {
  throw new Error(`local loader @match drifted: ${JSON.stringify(matches)}`);
}
if (!loader.includes("// @run-at       document-start")) {
  throw new Error("local loader must run at document-start");
}
const grants = [...loader.matchAll(/^\/\/ @grant\s+(.+)$/gm)].map((match) => match[1]?.trim()).sort();
const expectedGrants = [
  "GM_deleteValue",
  "GM_getValue",
  "GM_listValues",
  "GM_setValue",
  "GM_xmlhttpRequest",
].sort();
if (JSON.stringify(grants) !== JSON.stringify(expectedGrants)) {
  throw new Error(`local loader grants drifted: ${JSON.stringify(grants)}`);
}
for (const directive of ["// @updateURL    none", "// @downloadURL  none"]) {
  if (!loader.includes(directive)) throw new Error(`local loader is missing ${directive}`);
}
if (/GM_getResourceText|\beval\s*\(/.test(loader)) {
  throw new Error("local loader must delegate JavaScript execution to @require");
}
if (Buffer.byteLength(loader) > 10_000) {
  throw new Error("local loader unexpectedly contains the application bundle");
}

console.log(JSON.stringify({
  loader: report.localDebug.loader,
  loaderBytes: report.localDebug.loaderBytes,
  loaderSha256,
  resource: report.localDebug.resource,
  resourceBytes: report.localDebug.resourceBytes,
  resourceSha256,
  resourceUrl: report.localDebug.resourceUrl,
  sourceMap: "inline",
}));
