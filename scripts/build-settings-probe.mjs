import { build } from "esbuild";

await build({
  stdin: {
    contents: 'import { installSettingsInteractionProbe } from "./lite/src/debug/settings-interaction-probe.ts"; installSettingsInteractionProbe(window);',
    resolveDir: process.cwd(),
  },
  bundle: true,
  format: "iife",
  target: "es2022",
  outfile: "work/hnr-settings-interaction-probe.user.js",
  banner: { js: `// ==UserScript==
// @name         HN Settings Interaction Probe (60 seconds)
// @namespace    https://github.com/sunbigfly/hacker-news-reader-lite/debug
// @version      0.0.5
// @description  Exportable on-device interaction logs with local crash recovery; stops recording after 60 seconds. No form values or network requests.
// @match        https://news.ycombinator.com/*
// @run-at       document-idle
// @grant        GM_getValue
// @grant        GM_setValue
// ==/UserScript==` },
});
console.log("work/hnr-settings-interaction-probe.user.js");
