import type { ArticleSnapshot } from "../article/article-extractor";
import { authorAvatarLibrarySource } from "../avatar/author-avatar";
import { nativeHnItemUrl } from "../host/hn-native-bypass";
import {
  readerFontFamilyCss,
  type ReaderSettings,
  type TranslationDisplayMode,
} from "../settings/settings-store";
import type { ReaderTranslationTheme } from "../translation/translation-presentation";
import type { ArticleSummary, DiscussionSummary } from "../summary/summary-service";
import type { CommentId, ThreadSnapshot } from "../thread/model";

export interface OfflineTranslation {
  readonly text: string;
  readonly html: string;
  readonly bilingualHtml?: string;
}

export interface OfflineArticle {
  readonly article: ArticleSnapshot;
  readonly translationHtml?: string;
  readonly summary?: ArticleSummary;
}

export type OfflineFontSettings = Pick<
  ReaderSettings,
  | "titleFontFamily"
  | "titleCustomFontFamily"
  | "fontFamily"
  | "customFontFamily"
  | "fontScale"
>;

export interface OfflineDocumentInput {
  readonly snapshot: ThreadSnapshot;
  readonly translations: ReadonlyMap<CommentId, OfflineTranslation>;
  readonly titleTranslation?: string | null;
  readonly translationMode: TranslationDisplayMode;
  readonly translationTheme: ReaderTranslationTheme;
  readonly fontSettings: OfflineFontSettings;
  readonly readerCss: string;
  readonly discussionSummary?: DiscussionSummary | null;
  readonly articles?: readonly OfflineArticle[];
  readonly generatedAt?: number;
}

function escapeHtml(value: string): string {
  const replacements: Readonly<Record<string, string>> = {
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  };
  return value.replace(/[&<>"']/g, (character) => replacements[character] ?? character);
}

function safeJson(value: unknown): string {
  return JSON.stringify(value).replace(/[<>&\u2028\u2029]/g, (character) => {
    if (character === "<") return "\\u003c";
    if (character === ">") return "\\u003e";
    if (character === "&") return "\\u0026";
    if (character === "\u2028") return "\\u2028";
    return "\\u2029";
  });
}

function safeStyle(value: string): string {
  return value.replace(/<\/style/gi, "<\\/style");
}

function offlineFontStyle(settings: OfflineFontSettings): string {
  const titleFont = readerFontFamilyCss(
    settings.titleFontFamily,
    settings.titleCustomFontFamily,
  );
  const contentFont = readerFontFamilyCss(settings.fontFamily, settings.customFontFamily);
  return `:host{--hnr-title-font-family:${titleFont};--hnr-content-font-family:${contentFont};--hnr-font-scale:${settings.fontScale}}`;
}

function fileSlug(title: string): string {
  let portable = "";
  for (const character of title.normalize("NFKC")) {
    portable += character.charCodeAt(0) < 32 || "\\/:*?\"<>|".includes(character) ? " " : character;
  }
  const value = portable.replace(/\s+/g, " ").trim();
  return (value || "hacker-news-thread").slice(0, 80);
}

const OUTER_STYLE = "html,body,#hn-reader-root{width:100%;height:100%;margin:0;overflow:hidden}";

const OFFLINE_STYLE = String.raw`
.hnr-offline-shell { grid-template-rows: auto auto minmax(0, 1fr) auto; box-shadow: none; }
.hnr-offline-shell .hnr-header { grid-row: 1; grid-template-columns: minmax(0, 1fr) auto auto; grid-template-rows: auto auto; gap: 3px 12px; height: auto; min-height: 58px; padding-block: 7px; }
.hnr-offline-shell .hnr-identity { display: block; grid-column: 1; grid-row: 1 / 3; min-width: 0; }
.hnr-offline-shell .hnr-title { display: block; min-width: 0; overflow-wrap: anywhere; white-space: normal; }
.hnr-offline-shell .hnr-coverage { grid-column: 3; grid-row: 2; }
.hnr-offline-shell .hnr-header-actions { grid-column: 3; grid-row: 1; }
.hnr-offline-badge { color: var(--hnr-muted); font-size: 10px; font-weight: 750; letter-spacing: .08em; white-space: nowrap; }
.hnr-offline-summary-toggle svg { transition: transform .12s ease; }
.hnr-offline-summary-toggle[aria-expanded="false"] svg { transform: rotate(180deg); }
.hnr-offline-shell > .hnr-summary { grid-row: 2; }
.hnr-offline-shell .hnr-summary[hidden] { display: none; }
.hnr-offline-shell > .hnr-comments { grid-row: 3; }
.hnr-offline-shell > .hnr-footer { grid-row: 4; }
.hnr-offline-toolbar { display: grid; grid-column: 2; grid-row: 1 / 3; grid-template-columns: minmax(180px, 1fr) auto auto auto; gap: 7px; align-items: center; justify-self: end; width: clamp(430px, 46cqi, 760px); max-width: 100%; min-width: 0; }
.hnr-offline-toolbar input, .hnr-offline-toolbar select, .hnr-offline-toolbar button { min-width: 0; min-height: 30px; padding: 4px 8px; border: 1px solid var(--hnr-line); border-radius: 5px; background: var(--hnr-paper-raised); color: var(--hnr-ink); font: 11px/1.35 ui-sans-serif, system-ui, sans-serif; }
.hnr-offline-toolbar button { cursor: pointer; user-select: none; }
.hnr-offline-items { min-height: 100%; }
.hnr-offline-shell.mode-original .hnr-translated-text, .hnr-offline-shell.mode-original .hnr-bilingual-text, .hnr-offline-shell.mode-translated .hnr-comment[data-has-translation="true"] .hnr-original-text, .hnr-offline-shell.mode-translated .hnr-bilingual-text, .hnr-offline-shell.mode-bilingual .hnr-comment[data-has-translation="true"] .hnr-original-text, .hnr-offline-shell.mode-bilingual .hnr-translated-text { display: none; }
.hnr-offline-article { margin-top: 10px; padding: 20px 39px 30px; border-top: 1px solid var(--hnr-line); }
.hnr-offline-article h2 { margin: 0 0 6px; font: 720 20px/1.25 ui-serif, Georgia, serif; }
.hnr-offline-article .hnr-article-body { overflow: visible; padding: 14px 0 0; }
.hnr-offline-empty { padding: 28px; color: var(--hnr-muted); text-align: center; }
@container hnr-reader (max-width: 1040px) {
  .hnr-offline-shell .hnr-header { grid-template-columns: minmax(0, 1fr) auto; grid-template-rows: auto auto auto; }
  .hnr-offline-shell .hnr-coverage { grid-column: 2; grid-row: 2; }
  .hnr-offline-shell .hnr-header-actions { grid-column: 2; grid-row: 1; }
  .hnr-offline-toolbar { grid-column: 1 / -1; grid-row: 3; width: 100%; }
}
@container hnr-reader (max-width: 620px) {
  .hnr-offline-toolbar { grid-template-columns: minmax(0, 1fr) auto auto; }
  .hnr-offline-toolbar input { grid-column: 1 / -1; }
  .hnr-offline-toolbar select { grid-column: 1; grid-row: 2; }
}
`;

const RUNTIME = String.raw`
(()=>{"use strict";
const data=JSON.parse(document.getElementById("hnr-data").textContent);
const host=document.getElementById("hn-reader-root");
let root=host.shadowRoot;
if(!root){const template=host.querySelector("template");root=host.attachShadow({mode:"open"});if(template){root.append(template.content.cloneNode(true));template.remove()}}
const shell=root.querySelector(".hnr-offline-shell");
const thread=root.getElementById("thread");
const search=root.getElementById("search");
const mode=root.getElementById("mode");
const summaryPanel=root.getElementById("offline-summary");
const summaryToggle=root.getElementById("summary-toggle");
const byId=new Map(data.comments.map(comment=>[comment.id,comment]));
const byParent=new Map();
const collapsed=new Set();
for(const comment of data.comments){const list=byParent.get(comment.parentId)||[];list.push(comment);byParent.set(comment.parentId,list)}
const appendHtml=(element,html)=>{const template=document.createElement("template");template.innerHTML=html;element.append(template.content.cloneNode(true))};
const icon=(paths)=>{const svg=document.createElementNS("http://www.w3.org/2000/svg","svg");svg.setAttribute("viewBox","0 0 24 24");svg.setAttribute("aria-hidden","true");for(const data of paths){const path=document.createElementNS("http://www.w3.org/2000/svg","path");path.setAttribute("d",data);svg.append(path)}return svg};
const attachTooltip=(element,label,id)=>{const tooltip=document.createElement("span");tooltip.id=id;tooltip.className="hnr-tooltip";tooltip.setAttribute("role","tooltip");tooltip.textContent=label;element.setAttribute("aria-describedby",id);element.append(tooltip);return tooltip};
const avatarDataUri=(author)=>{if(!author||typeof globalThis.multiavatar!=="function")return null;try{const svg=globalThis.multiavatar("hnr-avatar-v1:"+author.trim().toLowerCase());return svg.startsWith("<svg")&&svg.endsWith("</svg>")?"data:image/svg+xml;charset=utf-8,"+encodeURIComponent(svg):null}catch{return null}};
const action=(tag,label,paths,id)=>{const element=document.createElement(tag);element.className="hnr-comment-action";element.setAttribute("aria-label",label);element.append(icon(paths));attachTooltip(element,label,id);return element};
const setSummaryExpanded=(expanded)=>{if(!summaryPanel||!summaryToggle)return;summaryPanel.hidden=!expanded;summaryToggle.setAttribute("aria-expanded",String(expanded));const label=expanded?"收起摘要":"展开摘要";summaryToggle.setAttribute("aria-label",label);const tooltip=summaryToggle.querySelector(".hnr-tooltip");if(tooltip)tooltip.textContent=label};
summaryToggle?.addEventListener("click",()=>setSummaryExpanded(summaryToggle.getAttribute("aria-expanded")!=="true"));
const matchingIds=()=>{const query=search.value.trim().toLocaleLowerCase();if(!query)return null;const visible=new Set();for(const comment of data.comments){const translation=comment.translation?comment.translation.text:"";if((comment.text+" "+translation+" "+(comment.author||"")).toLocaleLowerCase().includes(query)){let current=comment;while(current){visible.add(current.id);current=byId.get(current.parentId)}}}return visible};
const makeRow=(comment,depth,path)=>{
  const row=document.createElement("article");row.className="hnr-comment";row.id="comment-"+comment.id;row.dataset.commentId=String(comment.id);row.dataset.depth=String(depth);row.dataset.hasChildren=String(comment.childIds.length>0);row.dataset.hasTranslation=String(Boolean(comment.translation));row.dataset.collapsed=String(collapsed.has(comment.id));row.style.setProperty("--hnr-depth",String(Math.min(depth,12)));row.setAttribute("role","treeitem");row.setAttribute("aria-level",String(depth+1));
  const rails=document.createElement("span");rails.className="hnr-tree-rails";rails.setAttribute("aria-hidden","true");
  for(let level=0;level<Math.min(depth,12);level+=1){const parent=byId.get(path[level]);const childId=path[level+1];const childIndex=parent?parent.childIds.indexOf(childId):-1;if(parent&&childIndex>=0&&childIndex<parent.childIds.length-1){const rail=document.createElement("span");rail.className="hnr-tree-rail hnr-tree-collapse-hit";rail.dataset.continues="true";rail.dataset.action="toggle-comment";rail.dataset.commentId=String(parent.id);rail.style.setProperty("--hnr-rail-level",String(level));rail.addEventListener("click",()=>toggleBranch(parent.id));rails.append(rail)}}
  if(depth>0){const elbow=document.createElement("span");elbow.className="hnr-tree-elbow";rails.append(elbow)}
  if(comment.childIds.length>0&&!collapsed.has(comment.id)){const stem=document.createElement("span");stem.className="hnr-tree-stem hnr-tree-collapse-hit";stem.dataset.action="toggle-comment";stem.dataset.commentId=String(comment.id);stem.addEventListener("click",()=>toggleBranch(comment.id));rails.append(stem)}
  const head=document.createElement("div");head.className="hnr-comment-head";
  const marker=document.createElement("span");marker.className="hnr-author-marker";marker.textContent=(comment.author||"?").slice(0,1).toLocaleUpperCase();marker.setAttribute("aria-hidden","true");
  const avatarSource=avatarDataUri(comment.author);if(avatarSource){const avatar=document.createElement("img");avatar.className="hnr-author-avatar";avatar.src=avatarSource;avatar.alt="";avatar.width=32;avatar.height=32;avatar.draggable=false;avatar.setAttribute("aria-hidden","true");marker.append(avatar)}
  const author=document.createElement("strong");author.className="hnr-author";author.textContent=comment.author||"unknown";
  const permalink=document.createElement("a");permalink.className="hnr-permalink";permalink.href="#comment-"+comment.id;permalink.textContent="#"+comment.id;
  head.append(marker,author,permalink);
  const body=document.createElement("div");body.className="hnr-comment-body";
  const original=document.createElement("div");original.className="hnr-original-text";appendHtml(original,comment.html||"");body.append(original);
  if(comment.translation){const translated=document.createElement("div");translated.className="hnr-translated-text";appendHtml(translated,comment.translation.html||"");if(!translated.textContent.trim())translated.textContent=comment.translation.text;body.append(translated)}
  if(comment.translation){const bilingual=document.createElement("div");bilingual.className="hnr-bilingual-text";appendHtml(bilingual,comment.translation.bilingualHtml||comment.translation.html||"");body.append(bilingual)}body.hidden=collapsed.has(comment.id);
  const actions=document.createElement("div");actions.className="hnr-comment-actions";actions.setAttribute("aria-label","评论 #"+comment.id+" 操作");
  if(comment.childIds.length>0){const fold=action("button",collapsed.has(comment.id)?"展开此分支":"收起此分支",collapsed.has(comment.id)?["m7 13 5 5 5-5","m7 6 5 5 5-5"]:["m17 11-5-5-5 5","m17 18-5-5-5 5"],"hnr-tooltip-offline-fold-"+comment.id);fold.type="button";fold.addEventListener("click",()=>toggleBranch(comment.id));actions.append(fold)}
  const copy=action("button","复制评论链接",["M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71","M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"],"hnr-tooltip-offline-copy-"+comment.id);copy.type="button";copy.addEventListener("click",async()=>{const url="https://news.ycombinator.com/item?id="+comment.id;try{if(navigator.clipboard)await navigator.clipboard.writeText(url);else{const input=document.createElement("textarea");input.value=url;document.body.append(input);input.select();if(!document.execCommand("copy"))throw new Error("copy failed");input.remove()}}catch{const input=document.createElement("textarea");input.value=url;document.body.append(input);input.select();document.execCommand("copy");input.remove()}});
  const translate=action("button",comment.translation?"切换翻译显示":"此评论没有离线译文",["m5 8 6 6","m4 14 6-6 2-3","M2 5h12","M7 2h1","m22 22-5-10-5 10","M14 18h6"],"hnr-tooltip-offline-translate-"+comment.id);translate.type="button";translate.disabled=!comment.translation;translate.addEventListener("click",()=>{mode.value=mode.value==="original"?"bilingual":"original";setMode()});
  const summary=action("button",summaryPanel?"查看已保存摘要":"没有离线摘要",["M15 12H3","M17 18H3","M21 6H3"],"hnr-tooltip-offline-summary-"+comment.id);summary.type="button";summary.disabled=!summaryPanel;summary.addEventListener("click",()=>{if(!summaryPanel)return;setSummaryExpanded(true);summaryPanel.scrollTop=0});
  const reply=action("a","在 HN 回复",["m9 17-5-5 5-5","M4 12h12a4 4 0 0 1 4 4v1"],"hnr-tooltip-offline-reply-"+comment.id);reply.href="https://news.ycombinator.com/reply?id="+comment.id;reply.target="_blank";reply.rel="noopener noreferrer";
  actions.append(copy,translate,summary,reply);actions.hidden=collapsed.has(comment.id);
  row.append(rails,head,body,actions);
  if(comment.childIds.length>0){const toggle=document.createElement("button");const label=collapsed.has(comment.id)?"展开分支":"收起分支";toggle.className="hnr-branch-toggle";toggle.type="button";toggle.dataset.toggleSymbol=collapsed.has(comment.id)?"+":"−";toggle.setAttribute("aria-label",label);attachTooltip(toggle,label,"hnr-tooltip-offline-branch-"+comment.id);toggle.addEventListener("click",()=>toggleBranch(comment.id));row.append(toggle)}
  return row;
};
const render=()=>{const visible=matchingIds();const fragment=document.createDocumentFragment();const visited=new Set();const visit=(comment,depth,path)=>{if(visited.has(comment.id)||visible&&!visible.has(comment.id))return;visited.add(comment.id);const nextPath=[...path,comment.id];fragment.append(makeRow(comment,depth,nextPath));if(visible||!collapsed.has(comment.id))for(const child of byParent.get(comment.id)||[])visit(child,depth+1,nextPath)};for(const comment of byParent.get(data.story.id)||[])visit(comment,0,[]);for(const comment of data.comments)if(!visited.has(comment.id)&&!byId.has(comment.parentId))visit(comment,0,[]);thread.replaceChildren(fragment);if(!thread.childElementCount){const empty=document.createElement("div");empty.className="hnr-offline-empty";empty.textContent="没有匹配的评论";thread.append(empty)}};
const toggleBranch=(id)=>{const viewport=thread.closest(".hnr-comments");const before=root.getElementById("comment-"+id)?.getBoundingClientRect().top;if(collapsed.has(id))collapsed.delete(id);else collapsed.add(id);render();const after=root.getElementById("comment-"+id)?.getBoundingClientRect().top;if(viewport&&before!==undefined&&after!==undefined&&Math.abs(after-before)>.5)viewport.scrollTop+=after-before};
const setMode=()=>{shell.classList.remove("mode-original","mode-bilingual","mode-translated");shell.classList.add("mode-"+mode.value)};
mode.value=data.translationMode;mode.addEventListener("change",setMode);setMode();search.addEventListener("input",render);
root.getElementById("collapse").addEventListener("click",()=>{for(const comment of data.comments)if(comment.childIds.length)collapsed.add(comment.id);render()});
root.getElementById("expand").addEventListener("click",()=>{collapsed.clear();render()});
render();
})();
`;

export function buildOfflineHtml(input: OfflineDocumentInput): string {
  const translations = input.translations;
  const payload = {
    schemaVersion: 1,
    story: input.snapshot.story,
    complete: input.snapshot.complete,
    generatedAt: input.generatedAt ?? Date.now(),
    translationMode: input.translationMode,
    comments: input.snapshot.comments.map((comment) => ({
      id: comment.id,
      parentId: comment.parentId,
      childIds: comment.childIds,
      author: comment.author,
      html: comment.html,
      text: comment.text,
      translation: translations.get(comment.id) ?? null,
    })),
  };
  const summary = input.discussionSummary
    ? `<div class="hnr-summary-header"><h2 id="hnr-offline-summary-title">阅读摘要</h2></div><div class="hnr-summary-content"><p>${escapeHtml(input.discussionSummary.overview)}</p>${input.discussionSummary.consensus.length > 0 ? `<h3>共识</h3><ul>${input.discussionSummary.consensus.map((item) => `<li>${escapeHtml(item)}</li>`).join("")}</ul>` : ""}${input.discussionSummary.disputes.length > 0 ? `<h3>分歧</h3><ul>${input.discussionSummary.disputes.map((item) => `<li>${escapeHtml(item)}</li>`).join("")}</ul>` : ""}<p>${escapeHtml(input.discussionSummary.coverageNote)}</p></div>`
    : "";
  const articles = (input.articles ?? []).map(({ article, translationHtml, summary: articleSummary }) => `<section class="hnr-offline-article"><h2>${escapeHtml(article.title)}</h2><p class="hnr-coverage"><a class="hnr-original" href="${escapeHtml(article.canonicalUrl)}" target="_blank" rel="noopener noreferrer">${escapeHtml(article.siteName)}</a></p>${articleSummary ? `<div class="hnr-summary-content"><h3>文章摘要</h3><p>${escapeHtml(articleSummary.overview)}</p><ul>${articleSummary.keyPoints.map((item) => `<li>${escapeHtml(item)}</li>`).join("")}</ul></div>` : ""}<div class="hnr-article-body hnr-original-text"><article>${article.html}</article></div>${translationHtml ? `<div class="hnr-article-body hnr-translated-text"><article>${translationHtml}</article></div>` : ""}</section>`).join("");
  const title = escapeHtml(input.snapshot.story.title);
  const titleTranslation = escapeHtml(input.titleTranslation?.trim() ?? "");
  const originalUrl = nativeHnItemUrl(input.snapshot.story.id);
  const fontStyle = offlineFontStyle(input.fontSettings);
  const summaryToggle = summary ? `<button id="summary-toggle" class="hnr-original-control hnr-offline-summary-toggle" type="button" aria-label="收起摘要" aria-describedby="hnr-tooltip-offline-summary-toggle" aria-controls="offline-summary" aria-expanded="true"><svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="m18 15-6-6-6 6"></path></svg><span id="hnr-tooltip-offline-summary-toggle" class="hnr-tooltip" role="tooltip">收起摘要</span></button>` : "";
  const summaryPanel = summary ? `<aside id="offline-summary" class="hnr-summary" aria-labelledby="hnr-offline-summary-title">${summary}</aside>` : "";
  const avatarLibrary = authorAvatarLibrarySource();
  const runtime = avatarLibrary ? `${avatarLibrary}\n${RUNTIME}` : RUNTIME;
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; style-src 'unsafe-inline'; script-src 'nonce-hnr-offline-v1'; base-uri 'none'; form-action 'none'"><title>${title} · HN Reader 离线版</title><style>${OUTER_STYLE}</style></head><body><div id="hn-reader-root" data-translation-theme="${input.translationTheme}"><template shadowrootmode="open"><style>${safeStyle(input.readerCss)}\n${safeStyle(fontStyle)}\n${OFFLINE_STYLE}</style><section class="hnr-shell hnr-offline-shell" role="region" aria-labelledby="hnr-reader-title"><header class="hnr-header"><div class="hnr-identity"><div class="hnr-eyebrow">HN READER</div><h1 id="hnr-reader-title" class="hnr-title"><span class="hnr-title-original">${title}</span>${titleTranslation ? `<span class="hnr-title-subtitle" lang="zh-CN">${titleTranslation}</span>` : ""}</h1></div><div class="hnr-offline-toolbar" role="search" aria-label="离线评论工具"><input id="search" type="search" placeholder="搜索评论" aria-label="搜索评论"><select id="mode" aria-label="翻译显示"><option value="original">仅原文</option><option value="bilingual">双语</option><option value="translated">仅译文</option></select><button id="collapse" type="button">全部收起</button><button id="expand" type="button">全部展开</button></div><span class="hnr-coverage">${input.snapshot.comments.length} 条评论 · ${input.snapshot.complete ? "完整" : "当前快照"}</span><div class="hnr-header-actions"><span class="hnr-offline-badge">OFFLINE</span>${summaryToggle}<a class="hnr-original-control" href="${escapeHtml(originalUrl)}" target="_blank" rel="noopener noreferrer" aria-label="回到原帖" aria-describedby="hnr-tooltip-offline-original"><svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="M21 15a4 4 0 0 1-4 4H8l-5 3V7a4 4 0 0 1 4-4h10a4 4 0 0 1 4 4z"></path></svg><span id="hnr-tooltip-offline-original" class="hnr-tooltip" role="tooltip">回到原帖</span></a></div></header>${summaryPanel}<div class="hnr-comments" role="tree" aria-label="Hacker News 评论树"><div id="thread" class="hnr-virtual-items hnr-offline-items"></div>${articles}</div><footer class="hnr-footer">离线副本 · 可搜索、折叠并切换原文与译文 · 不含 API Key、Cookie 或登录状态</footer></section></template></div><script id="hnr-data" type="application/json">${safeJson(payload)}</script><script nonce="hnr-offline-v1">${runtime}</script></body></html>`;
}

export function offlineFilename(input: OfflineDocumentInput): string {
  return `${fileSlug(input.snapshot.story.title)}-hn-${input.snapshot.story.id}.html`;
}

export function downloadOfflineHtml(document: Document, html: string, filename: string): void {
  const url = URL.createObjectURL(new Blob([html], { type: "text/html;charset=utf-8" }));
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.hidden = true;
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  document.defaultView?.setTimeout(() => URL.revokeObjectURL(url), 1_000);
}
