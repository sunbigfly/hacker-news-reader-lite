import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const metadata = await readFile(path.join(root, "lite/userscript.meta.txt"), "utf8");
const artifactPath = path.join(root, "dist/hacker-news-reader-lite.user.js");
const reportPath = `${artifactPath}.build.json`;
const artifact = await readFile(artifactPath, "utf8");
const report = JSON.parse(await readFile(reportPath, "utf8"));
const reuseManifest = JSON.parse(await readFile(path.join(root, "reuse-manifest.json"), "utf8"));
const expectedRequires = [
  "https://cdn.jsdelivr.net/npm/@multiavatar/multiavatar@1.0.7/multiavatar.min.js#sha256=c9d10f8a91ef3e2b9dceda9a9d5cb87fb61eb9f6dd67c0f4a478a7363587aaae",
];

const matches = [...metadata.matchAll(/^\/\/ @match\s+(.+)$/gm)].map((match) => match[1]?.trim());
if (matches.length !== 1 || matches[0] !== "https://news.ycombinator.com/*") {
  throw new Error(`metadata @match must be HN-only; received ${JSON.stringify(matches)}`);
}
if (!metadata.includes("// @run-at       document-start")) {
  throw new Error("metadata must run at document-start");
}
const requires = [...metadata.matchAll(/^\/\/ @require\s+(.+)$/gm)].map((match) => match[1]?.trim());
if (JSON.stringify(requires) !== JSON.stringify(expectedRequires)) {
  throw new Error(`metadata requires changed; received ${JSON.stringify(requires)}`);
}
const grants = [...metadata.matchAll(/^\/\/ @grant\s+(.+)$/gm)].map((match) => match[1]?.trim()).sort();
const expectedGrants = ["GM_deleteValue", "GM_getValue", "GM_listValues", "GM_setValue", "GM_xmlhttpRequest"].sort();
if (JSON.stringify(grants) !== JSON.stringify(expectedGrants)) {
  throw new Error(`metadata grants changed; received ${JSON.stringify(grants)}`);
}
if (!artifact.startsWith("// ==UserScript==")) {
  throw new Error("production artifact is missing userscript metadata");
}
const forbidden = ["linuxdo", "MessageBus", "WebDAV", "Composer", "discourse/"];
const sourceDirectory = path.join(root, "lite/src");
const sourceFiles = (await readdir(sourceDirectory, { recursive: true }))
  .filter((name) => name.endsWith(".ts"));
const source = (await Promise.all(sourceFiles.map((name) => readFile(path.join(sourceDirectory, name), "utf8")))).join("\n");
for (const token of forbidden) {
  if (`${source}\n${artifact}`.toLowerCase().includes(token.toLowerCase())) {
    throw new Error(`source or production artifact contains forbidden token: ${token}`);
  }
}
const secretPatterns = [
  /sk-[A-Za-z0-9_-]{24,}/,
  /AIza[0-9A-Za-z_-]{30,}/,
  /-----BEGIN (?:RSA |EC )?PRIVATE KEY-----/,
];
for (const pattern of secretPatterns) {
  if (pattern.test(`${source}\n${artifact}`)) {
    throw new Error(`source or production artifact contains a secret-like value: ${pattern.source}`);
  }
}
if (reuseManifest.schemaVersion !== 1 || !Array.isArray(reuseManifest.entries) || reuseManifest.entries.length < 1) {
  throw new Error("reuse manifest schema is invalid or empty");
}
if (
  typeof reuseManifest.source?.repository !== "string"
  || !/^https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(reuseManifest.source.repository)
  || typeof reuseManifest.source?.commit !== "string"
  || !/^[0-9a-f]{40}$/.test(reuseManifest.source.commit)
  || reuseManifest.source?.license !== "MIT"
) {
  throw new Error("reuse manifest source repository or commit is invalid");
}
for (const entry of reuseManifest.entries) {
  const targetPath = path.join(root, entry.target);
  await readFile(targetPath);
  if (typeof entry.source !== "string" || !/^[0-9a-f]{64}$/.test(entry.sourceSha256)) {
    throw new Error(`reuse source record is invalid: ${entry.target}`);
  }
  if (!Array.isArray(entry.tests) || entry.tests.length < 1) throw new Error(`reuse entry has no tests: ${entry.target}`);
  for (const test of entry.tests) await readFile(path.join(root, test));
}
const sha256 = createHash("sha256").update(artifact).digest("hex");
if (report.sha256 !== sha256 || report.bytes !== Buffer.byteLength(artifact)) {
  throw new Error("production artifact does not match its build report");
}
console.log(JSON.stringify({
  metadata: "ok",
  requires: "ok",
  grants: "ok",
  forbiddenTokens: "ok",
  secrets: "ok",
  reuseEntries: reuseManifest.entries.length,
  sha256,
}));
