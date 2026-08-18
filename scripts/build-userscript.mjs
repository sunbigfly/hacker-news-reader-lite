import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath, pathToFileURL, URL } from "node:url";
import { build } from "esbuild";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const local = process.argv.includes("--local");
const outputDirectory = path.join(root, local ? "work" : "dist");
const outputName = local
  ? "hacker-news-reader-lite.local.user.js"
  : "hacker-news-reader-lite.user.js";
const outputPath = path.join(outputDirectory, outputName);
const localResourcePath = path.join(root, "work/hacker-news-reader-lite.local.js");
const localLoaderPath = path.join(root, "work/hacker-news-reader-lite.local-debug.user.js");

const styleDirectory = path.join(root, "lite/styles");
const styleFiles = (await readdir(styleDirectory))
  .filter((name) => name.endsWith(".css"))
  .sort();
const hostStyleFiles = styleFiles.filter((name) => name === "05-host.css");
const readerStyleFiles = styleFiles.filter((name) => !hostStyleFiles.includes(name));
if (hostStyleFiles.length !== 1) {
  throw new Error("exactly one host stylesheet named 05-host.css is required");
}
const readStyles = async (names) => (
  await Promise.all(
    names.map((name) => readFile(path.join(styleDirectory, name), "utf8")),
  )
).join("\n");
const [hostCss, readerCss] = await Promise.all([
  readStyles(hostStyleFiles),
  readStyles(readerStyleFiles),
]);

const result = await build({
  entryPoints: [path.join(root, "lite/src/userscript/main.ts")],
  bundle: true,
  format: "iife",
  platform: "browser",
  target: ["chrome120", "edge120"],
  treeShaking: true,
  minify: !local,
  sourcemap: local ? "inline" : false,
  legalComments: "inline",
  charset: "utf8",
  write: false,
  define: {
    __HN_HOST_CSS__: JSON.stringify(hostCss),
    __HN_READER_CSS__: JSON.stringify(readerCss),
    __HN_READER_BUILD__: JSON.stringify(local ? "local" : "production"),
  },
});

const bundled = result.outputFiles.at(0)?.text;
if (!bundled) {
  throw new Error("esbuild produced no userscript output");
}

function browserFileUrl(filePath) {
  const normalized = filePath.replaceAll("\\", "/");
  const windowsMount = normalized.match(/^\/mnt\/([a-z])\/(.+)$/i);
  if (!windowsMount) return pathToFileURL(filePath).href;
  const [, drive, relativePath] = windowsMount;
  return `file:///${drive.toUpperCase()}:/`
    + relativePath.split("/").map(encodeURIComponent).join("/");
}

function versionedLocalFileUrl(filePath, digest) {
  if (!/^[0-9a-f]{64}$/.test(digest)) {
    throw new Error("local resource SHA-256 is invalid");
  }
  const url = new URL(browserFileUrl(filePath));
  url.searchParams.set("v", digest);
  return url.href;
}

function renderLocalResourceLoader(metadata, resourceUrl, digest) {
  const inherited = metadata.split(/\r?\n/).filter((line) => {
    const match = line.match(/^\/\/\s+@(\S+)/);
    if (!match) return false;
    const key = match[1].toLowerCase();
    return !(
      key === "name"
      || key.startsWith("name:")
      || key === "description"
      || key.startsWith("description:")
      || key === "version"
      || key === "updateurl"
      || key === "installurl"
      || key === "downloadurl"
    );
  });
  return [
    "// ==UserScript==",
    "// @name         Hacker News Reader Lite（本地资源调试）",
    `// @version      0.0.1-local.${digest.slice(0, 12)}`,
    "// @description  由 Tampermonkey 原生执行带内容指纹的本地资源；重新构建并导入 Loader 后刷新 HN 生效。",
    ...inherited,
    "// @updateURL    none",
    "// @downloadURL  none",
    `// @require      ${resourceUrl}`,
    "// ==/UserScript==",
    "",
  ].join("\n");
}

const metadata = (await readFile(path.join(root, "lite/userscript.meta.txt"), "utf8")).trimEnd();
const output = `${metadata}\n\n${bundled.trim()}\n`;
const sha256 = createHash("sha256").update(output).digest("hex");
const localResource = `${bundled.trim()}\n//# sourceURL=hacker-news-reader-lite.local.js\n`;
const localResourceSha256 = createHash("sha256").update(localResource).digest("hex");
const localResourceUrl = versionedLocalFileUrl(localResourcePath, localResourceSha256);
const localLoader = local
  ? renderLocalResourceLoader(metadata, localResourceUrl, localResourceSha256)
  : null;
const report = {
  mode: local ? "local" : "production",
  artifact: path.relative(root, outputPath).replaceAll(path.sep, "/"),
  bytes: Buffer.byteLength(output),
  sha256,
  styles: styleFiles,
  hostStyles: hostStyleFiles,
  readerStyles: readerStyleFiles,
  ...(localLoader
    ? {
        localDebug: {
          resource: path.relative(root, localResourcePath).replaceAll(path.sep, "/"),
          resourceBytes: Buffer.byteLength(localResource),
          resourceSha256: localResourceSha256,
          resourceUrl: localResourceUrl,
          loader: path.relative(root, localLoaderPath).replaceAll(path.sep, "/"),
          loaderBytes: Buffer.byteLength(localLoader),
          loaderSha256: createHash("sha256").update(localLoader).digest("hex"),
        },
      }
    : {}),
};

await mkdir(outputDirectory, { recursive: true });
await writeFile(outputPath, output, "utf8");
if (localLoader) {
  await writeFile(localResourcePath, localResource, "utf8");
  await writeFile(localLoaderPath, localLoader, "utf8");
}
await writeFile(
  path.join(outputDirectory, `${outputName}.build.json`),
  `${JSON.stringify(report, null, 2)}\n`,
  "utf8",
);

console.log(JSON.stringify(report));
