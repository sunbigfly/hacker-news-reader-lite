import { readFile, readdir, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import ts from "typescript";
import process from "node:process";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const readerOnly = process.argv.includes("--reader-only");
const sourceRoot = path.join(root, "lite/src");
const traceModule = path.join(sourceRoot, "debug/phone-call-probe.ts");
const nativeCalls = new Set(["GM_xmlhttpRequest", "GM_getValue", "GM_setValue", "GM_deleteValue", "GM_listValues"]);
const methods = new Set(["focus", "scrollIntoView", "openSettings"]);
let instrumented = 0;
const styles = (await readdir(path.join(root, "lite/styles"))).filter((name) => name.endsWith(".css")).sort();
const styleText = await Promise.all(styles.map((name) => readFile(path.join(root, "lite/styles", name), "utf8")));
const metadata = (await readFile(path.join(root, "lite/userscript.meta.txt"), "utf8"))
  .replace(/^\/\/ @version.*$/m, "// @version      0.1.4.5")
  .replace(/^\/\/ @description.*$/gm, "")
  .replace("// ==UserScript==", `// ==UserScript==\n// @description  ${readerOnly ? "X 浏览器同步流读取兼容修复，本地验证版。" : "手机调用诊断版，内置 60 秒日志；替换原阅读器使用，停用独立日志脚本。"}`);
const result = await build({
  stdin: {
    contents: readerOnly ? 'import "./lite/src/userscript/main.ts";' : 'import { installSettingsInteractionProbe } from "./lite/src/debug/settings-interaction-probe.ts"; import { bootstrapHackerNewsReader } from "./lite/src/app/bootstrap.ts"; if (document.body) installSettingsInteractionProbe(window); else document.addEventListener("DOMContentLoaded", () => installSettingsInteractionProbe(window), { once: true }); bootstrapHackerNewsReader();',
    resolveDir: root,
  },
  bundle: true, format: "iife", platform: "browser", target: "chrome120", minify: true, write: false,
  define: {
    __HN_HOST_CSS__: JSON.stringify(styleText[styles.indexOf("05-host.css")]),
    __HN_READER_CSS__: JSON.stringify(styleText.filter((_, index) => styles[index] !== "05-host.css").join("\n")),
    __HN_READER_BUILD__: JSON.stringify(readerOnly ? "production" : "local"),
  },
  plugins: readerOnly ? [] : [{
    name: "phone-call-timing",
    setup(builder) {
      builder.onLoad({ filter: /\.ts$/ }, async ({ path: filename }) => {
        if (!filename.startsWith(`${sourceRoot}${path.sep}`) || filename.startsWith(`${sourceRoot}/debug/`)) return undefined;
        const source = ts.createSourceFile(filename, await readFile(filename, "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
        let count = 0;
        const transformed = ts.transform(source, [(context) => {
          const visit = (node) => {
            const visited = ts.visitEachChild(node, visit, context);
            if (!ts.isCallExpression(visited)) return visited;
            const expression = visited.expression;
            const name = ts.isIdentifier(expression) && nativeCalls.has(expression.text) ? expression.text
              : ts.isPropertyAccessExpression(expression) && methods.has(expression.name.text) ? expression.name.text : null;
            if (!name) return visited;
            count += 1;
            return ts.factory.createCallExpression(ts.factory.createIdentifier("__hnrPhoneCall"), undefined, [
              ts.factory.createStringLiteral(`${path.basename(filename, ".ts")}:${name}`),
              ts.factory.createArrowFunction(undefined, undefined, [], undefined, ts.factory.createToken(ts.SyntaxKind.EqualsGreaterThanToken), visited),
            ]);
          };
          return (node) => ts.visitNode(node, visit);
        }]);
        try {
          if (!count) return undefined;
          instrumented += count;
          return {
            contents: `import { tracePhoneCall as __hnrPhoneCall } from ${JSON.stringify(traceModule)};\n${ts.createPrinter().printFile(transformed.transformed[0])}`,
            loader: "ts", resolveDir: path.dirname(filename),
          };
        } finally { transformed.dispose(); }
      });
    },
  }],
});
const output = path.join(root, readerOnly ? "work/hnr-phone-fix.user.js" : "work/hnr-phone-debug.user.js");
await mkdir(path.dirname(output), { recursive: true });
await writeFile(output, `${metadata}\n${result.outputFiles[0].text}\n//# sourceURL=hnr-phone-debug.js\n`);
console.log(JSON.stringify({ output, instrumented, bytes: (await readFile(output)).length }));
