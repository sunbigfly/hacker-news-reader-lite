import { LifecycleScope } from "../kernel/lifecycle";
import type { CommentId, StoryId } from "../thread/model";
import { findHnListTable, findHnMoreLink } from "./hn-list-dom";
import { parseHnRoute, type HnRoute } from "./hn-route";

const INTERACTIVE_TARGET_SELECTOR = [
  "a",
  "button",
  "input",
  "select",
  "textarea",
  "label",
  "[contenteditable='true']",
  "[role='button']",
  "[role='link']",
].join(",");

interface HnTopbarTab {
  readonly href: string;
  readonly label: string;
  readonly pathname: string;
  readonly requiresAccount?: boolean;
}

const HN_TOPBAR_TABS: readonly HnTopbarTab[] = [
  { href: "newswelcome.html", label: "welcome", pathname: "/newswelcome.html" },
  { href: "newest", label: "new", pathname: "/newest" },
  { href: "threads", label: "threads", pathname: "/threads", requiresAccount: true },
  { href: "front", label: "past", pathname: "/front" },
  { href: "newcomments", label: "comments", pathname: "/newcomments" },
  { href: "ask", label: "ask", pathname: "/ask" },
  { href: "show", label: "show", pathname: "/show" },
  { href: "jobs", label: "jobs", pathname: "/jobs" },
  { href: "submit", label: "submit", pathname: "/submit" },
];

const ORIGINAL_STORY_TOOLTIP = "Ctrl + 🖱️左键：打开原文";
const SVG_NAMESPACE = "http://www.w3.org/2000/svg";

function ownAttribute(
  scope: LifecycleScope,
  element: Element,
  name: string,
  value: string,
): void {
  const previous = element.getAttribute(name);
  element.setAttribute(name, value);
  scope.add(() => {
    if (previous === null) element.removeAttribute(name);
    else element.setAttribute(name, previous);
  });
}

function ownClass(scope: LifecycleScope, element: Element, name: string): void {
  const hadClass = element.classList.contains(name);
  element.classList.add(name);
  if (!hadClass) scope.add(() => element.classList.remove(name));
}

function installHnLogo(scope: LifecycleScope, logo: HTMLTableCellElement): void {
  const anchor = logo.querySelector<HTMLAnchorElement>("a");
  const image = anchor?.querySelector<HTMLImageElement>("img");
  if (!anchor || !image) return;

  const mark = logo.ownerDocument.createElementNS(SVG_NAMESPACE, "svg");
  mark.setAttribute("viewBox", "0 0 24 24");
  mark.setAttribute("aria-hidden", "true");
  mark.setAttribute("data-hnr-topbar-logo-mark", "true");
  const text = logo.ownerDocument.createElementNS(SVG_NAMESPACE, "text");
  text.setAttribute("x", "12");
  text.setAttribute("y", "12");
  text.setAttribute("dy", ".35em");
  text.setAttribute("text-anchor", "middle");
  text.textContent = "HN";
  mark.append(text);

  image.replaceWith(mark);
  ownAttribute(scope, anchor, "aria-label", "Hacker News");
  scope.add(() => {
    if (mark.isConnected) mark.replaceWith(image);
  });
}

/** Installs the paint-blocking host skin before the HN body is parsed. */
export function installHnHostAppearance(
  document: Document,
  route: HnRoute,
  hostCss: string,
  scope: LifecycleScope,
): void {
  const html = document.documentElement;
  ownClass(scope, html, "hnr-host-enhanced");
  if (route.kind === "list") ownClass(scope, html, "hnr-host-list");
  if (route.kind === "comments") ownClass(scope, html, "hnr-host-comments");
  if (!hostCss || document.querySelector("[data-hnr-host-style]")) return;
  const style = document.createElement("style");
  style.dataset.hnrHostStyle = "true";
  style.textContent = hostCss;
  (document.head ?? html).append(style);
  scope.add(() => style.remove());
}

export function markHnHostReady(document: Document, scope: LifecycleScope): void {
  ownClass(scope, document.documentElement, "hnr-host-ready");
}

export interface HnHostTitleInput {
  readonly id: StoryId;
  readonly title: string;
}

export interface HnHostCommentInput {
  readonly id: number;
  readonly html: string;
}

export interface HnHostTranslationUpdate {
  readonly id: number;
  readonly text: string;
  readonly html: string;
  readonly complete: boolean;
}

interface HnHostTitleTarget extends HnHostTitleInput {
  readonly row: HTMLTableRowElement;
}

interface HnHostCommentTarget extends HnHostCommentInput {
  readonly content: HTMLElement;
}

export class HnHostController {
  readonly #scope: LifecycleScope;
  readonly #translationSignal: AbortSignal;
  #pageProjectionScope: LifecycleScope | null = null;
  #pageReplacementScope: LifecycleScope | null = null;
  #currentRoute: HnRoute;
  #currentUrl: URL;
  #activeStoryId: StoryId | null = null;
  #resumeStoryId: StoryId | null;
  #readerOpen = false;

  constructor(
    readonly document: Document,
    readonly route: HnRoute,
    readonly onOpen: (storyId: StoryId, commentId?: CommentId) => void,
    readonly hostCss: string,
    parentScope: LifecycleScope,
    readonly lastActiveStoryId: StoryId | null = null,
    readonly onTranslateTitles?: (
      titles: readonly HnHostTitleInput[],
      signal: AbortSignal,
      onTranslation: (output: HnHostTranslationUpdate) => void,
    ) => Promise<void>,
    readonly onTranslateComments?: (
      comments: readonly HnHostCommentInput[],
      signal: AbortSignal,
      onTranslation: (output: HnHostTranslationUpdate) => void,
    ) => Promise<void>,
  ) {
    this.#scope = parentScope.child();
    this.#translationSignal = this.#scope.abortController("宿主页面已关闭").signal;
    this.#currentRoute = route;
    this.#currentUrl = new URL(document.URL);
    this.#resumeStoryId = lastActiveStoryId;
    this.#scope.add(() => {
      for (const row of this.document.querySelectorAll("[data-hnr-card-active]")) {
        row.removeAttribute("data-hnr-card-active");
      }
    });
  }

  install(): void {
    this.#installHostAppearance();
    markHnHostReady(this.document, this.#scope);
    this.#installHostDelegates();
    this.#projectCurrentPage();
  }

  destroy(): void {
    this.#scope.destroy();
  }

  refreshPageProjection(): void {
    if (!this.#scope.destroyed) this.#projectCurrentPage();
  }

  setActiveStory(storyId: StoryId | null): void {
    if (this.#scope.destroyed) return;
    this.#activeStoryId = storyId;
    this.#readerOpen = storyId !== null;
    this.#syncActiveStoryRows();
    this.#syncResumeReaderCommand();
  }

  setLastReadStory(storyId: StoryId | null): void {
    if (this.#scope.destroyed) return;
    this.#resumeStoryId = storyId;
    this.#syncResumeReaderCommand();
  }

  nextPageUrl(): string | null {
    if (this.#currentRoute.kind !== "list") return null;
    return findHnMoreLink(this.document)?.href ?? null;
  }

  appendListPage(page: Document): number {
    if (this.#currentRoute.kind !== "list") return 0;
    const listScope = this.#pageProjectionScope;
    if (!listScope || listScope.destroyed) return 0;
    const targetBody = findHnListTable(this.document)?.tBodies[0] ?? null;
    const incomingBody = findHnListTable(page)?.tBodies[0] ?? null;
    if (!targetBody || !incomingBody) return 0;

    const existingIds = new Set(
      [...targetBody.querySelectorAll<HTMLTableRowElement>("tr.athing[id]")]
        .map((row) => row.id),
    );
    const incomingRows = [...incomingBody.children].filter(
      (element): element is HTMLTableRowElement => element.tagName === "TR",
    );
    const rowsToInsert: HTMLTableRowElement[] = [];
    let appendedStories = 0;
    for (let index = 0; index < incomingRows.length;) {
      const row = incomingRows[index];
      if (!row) break;
      if (row.matches("tr.athing[id]")) {
        const group = [row];
        index += 1;
        while (
          index < incomingRows.length
          && !incomingRows[index]?.matches("tr.athing[id]")
          && !incomingRows[index]?.querySelector("a.morelink")
        ) {
          const groupedRow = incomingRows[index];
          if (groupedRow) group.push(groupedRow);
          index += 1;
        }
        if (!existingIds.has(row.id)) {
          rowsToInsert.push(...group);
          existingIds.add(row.id);
          appendedStories += 1;
        }
        continue;
      }
      if (row.querySelector("a.morelink")) rowsToInsert.push(row);
      index += 1;
    }
    if (rowsToInsert.length === 0) return 0;

    const currentMoreRow = targetBody.querySelector("a.morelink")?.closest<HTMLTableRowElement>("tr") ?? null;
    const currentMoreNext = currentMoreRow?.nextSibling ?? null;
    currentMoreRow?.remove();
    if (currentMoreRow) {
      listScope.add(() => {
        targetBody.insertBefore(
          currentMoreRow,
          currentMoreNext?.parentNode === targetBody ? currentMoreNext : null,
        );
      });
    }

    const insertedRows = rowsToInsert.map((row) => this.document.importNode(row, true));
    targetBody.append(...insertedRows);
    listScope.add(() => insertedRows.forEach((row) => row.remove()));
    const storyRows = insertedRows.filter((row) => row.matches("tr.athing[id]"));
    this.#installListRows(storyRows, listScope);
    return appendedStories;
  }

  replaceHostPage(page: Document, finalUrl: string): boolean {
    const targetMain = this.document.querySelector<HTMLTableElement>("#hnmain");
    const incomingMain = page.querySelector<HTMLTableElement>("#hnmain");
    const targetBody = targetMain?.tBodies[0] ?? null;
    const incomingBody = incomingMain?.tBodies[0] ?? null;
    if (!targetBody) return false;

    const incomingRows = [...(incomingBody?.children ?? [])].filter(
      (element): element is HTMLTableRowElement => element.tagName === "TR",
    );
    const targetTopbar = targetBody.firstElementChild;
    if (!targetTopbar || (incomingBody && incomingRows.length < 1)) return false;

    let nextRoute: HnRoute;
    let nextUrl: URL;
    try {
      nextUrl = new URL(finalUrl, this.document.baseURI);
      nextRoute = parseHnRoute(nextUrl);
    } catch {
      return false;
    }

    const importedRows = incomingBody
      ? incomingRows.slice(1).map((row) => this.document.importNode(row, true))
      : this.#standaloneRows(page);
    if (importedRows.length === 0) return false;

    this.#pageProjectionScope?.destroy();
    this.#pageProjectionScope = null;
    this.#pageReplacementScope?.destroy();
    this.#pageReplacementScope = null;

    const replacementScope = this.#scope.child();
    const previousRows = [...targetBody.children].slice(1);
    const currentNavigation = this.document.querySelector<HTMLElement>(
      "[data-hnr-topbar-navigation]",
    );
    const currentAccount = this.document.querySelector<HTMLElement>(
      "[data-hnr-topbar-account]",
    );
    const incomingTopbarRow = incomingRows[0]?.querySelector("table > tbody > tr");
    const incomingNavigation = incomingTopbarRow?.children[1] ?? null;
    const incomingAccount = incomingTopbarRow?.lastElementChild ?? null;
    const previousNavigationNodes = currentNavigation
      ? [...currentNavigation.childNodes]
      : [];
    const previousAccountNodes = currentAccount
      ? [...currentAccount.childNodes]
      : [];
    const previousTitle = this.document.title;
    const previousRoute = this.#currentRoute;
    const previousUrl = this.#currentUrl;
    const previousOperation = this.document.documentElement.getAttribute("op");
    const incomingOperation = page.documentElement.getAttribute("op");

    previousRows.forEach((row) => row.remove());
    targetBody.append(...importedRows);
    if (currentNavigation && incomingNavigation) {
      currentNavigation.replaceChildren(
        ...[...incomingNavigation.childNodes]
          .map((node) => this.document.importNode(node, true)),
      );
    }
    if (currentAccount && incomingAccount && incomingAccount !== incomingNavigation) {
      currentAccount.replaceChildren(
        ...[...incomingAccount.childNodes]
          .map((node) => this.document.importNode(node, true)),
      );
    }
    this.document.title = page.title || previousTitle;
    this.#currentRoute = nextRoute;
    this.#currentUrl = nextUrl;
    this.document.documentElement.classList.toggle("hnr-host-list", nextRoute.kind === "list");
    this.document.documentElement.classList.toggle("hnr-host-comments", nextRoute.kind === "comments");
    if (incomingOperation === null) this.document.documentElement.removeAttribute("op");
    else this.document.documentElement.setAttribute("op", incomingOperation);
    replacementScope.add(() => {
      importedRows.forEach((row) => row.remove());
      targetBody.append(...previousRows);
      if (currentNavigation) currentNavigation.replaceChildren(...previousNavigationNodes);
      if (currentAccount) currentAccount.replaceChildren(...previousAccountNodes);
      this.document.title = previousTitle;
      this.#currentRoute = previousRoute;
      this.#currentUrl = previousUrl;
      this.document.documentElement.classList.toggle(
        "hnr-host-list",
        previousRoute.kind === "list",
      );
      this.document.documentElement.classList.toggle(
        "hnr-host-comments",
        previousRoute.kind === "comments",
      );
      if (previousOperation === null) this.document.documentElement.removeAttribute("op");
      else this.document.documentElement.setAttribute("op", previousOperation);
    });
    this.#pageReplacementScope = replacementScope;
    this.#projectCurrentPage();
    return true;
  }

  #standaloneRows(page: Document): HTMLTableRowElement[] {
    const contentNodes = [...page.body.childNodes].filter((node) => (
      node.nodeType === 1
        ? (node as Element).tagName !== "SCRIPT"
        : node.nodeType === 3 && Boolean(node.textContent?.trim())
    ));
    if (contentNodes.length === 0) return [];
    const row = this.document.createElement("tr");
    row.className = "hnr-host-standalone-row";
    const cell = this.document.createElement("td");
    cell.colSpan = 3;
    const content = this.document.createElement("main");
    content.className = "hnr-host-standalone";
    content.append(...contentNodes.map((node) => this.document.importNode(node, true)));
    cell.append(content);
    row.append(cell);
    return [row];
  }

  #installHostAppearance(): void {
    installHnHostAppearance(this.document, this.route, this.hostCss, this.#scope);

    const topbar = this.document.querySelector<HTMLElement>(
      "#hnmain > tbody > tr:first-child > td",
    );
    if (!topbar) return;
    ownAttribute(this.#scope, topbar, "data-hnr-topbar", "true");
    const topbarRow = topbar.querySelector<HTMLTableRowElement>("table > tbody > tr");
    if (!topbarRow) return;
    ownAttribute(this.#scope, topbarRow, "data-hnr-topbar-row", "true");
    const cells = [...topbarRow.children].filter(
      (element): element is HTMLTableCellElement => element instanceof HTMLTableCellElement,
    );
    const logo = cells[0];
    const navigation = cells[1];
    const account = cells.at(-1);
    if (logo) {
      ownAttribute(this.#scope, logo, "data-hnr-topbar-logo", "true");
      installHnLogo(this.#scope, logo);
    }
    if (navigation) ownAttribute(this.#scope, navigation, "data-hnr-topbar-navigation", "true");
    if (account && account !== navigation) {
      ownAttribute(this.#scope, account, "data-hnr-topbar-account", "true");
    }
  }

  #normalizeListTable(scope: LifecycleScope): void {
    const table = findHnListTable(this.document);
    if (table) ownClass(scope, table, "itemlist");
  }

  #installHostDelegates(): void {
    const listRoot = this.document.querySelector("#hnmain") ?? this.document;
    this.#scope.listen(listRoot, "click", (event) => this.#handleCardClick(event));
    this.#scope.listen(listRoot, "keydown", (event) => this.#handleCardKeydown(event as KeyboardEvent));
  }

  #projectCurrentPage(): void {
    this.#pageProjectionScope?.destroy();
    const scope = this.#scope.child();
    this.#pageProjectionScope = scope;
    this.#ensureTopbarTabs(scope);
    this.#syncTopbarSelection(scope);
    this.#installResumeReaderCommand(scope);
    if (this.#currentRoute.kind === "list") {
      this.#normalizeListTable(scope);
      this.#installListRows(
        [...this.document.querySelectorAll<HTMLTableRowElement>("tr.athing[id]")],
        scope,
      );
    } else if (this.#currentRoute.kind === "comments") {
      this.#installCommentRows(scope);
    }
    if (this.#currentUrl.pathname === "/reply") this.#installReplyBackCommand(scope);
  }

  #ensureTopbarTabs(scope: LifecycleScope): void {
    const navigation = this.document.querySelector<HTMLElement>(
      "[data-hnr-topbar-navigation]",
    );
    if (!navigation) return;
    const account = this.#topbarAccountName();
    const tabs = HN_TOPBAR_TABS.filter((tab) => !tab.requiresAccount || account !== null);
    const currentPaths = new Set<string>();
    for (const anchor of navigation.querySelectorAll<HTMLAnchorElement>("a[href]")) {
      try {
        currentPaths.add(new URL(anchor.href, this.document.baseURI).pathname);
      } catch {
        // A malformed native link does not satisfy a canonical tab.
      }
    }
    if (tabs.every((tab) => currentPaths.has(tab.pathname))) return;

    const previousNodes = [...navigation.childNodes];
    const strip = this.document.createElement("span");
    strip.className = "pagetop";
    tabs.forEach((tab, index) => {
      if (index > 0) strip.append(this.document.createTextNode(" | "));
      const anchor = this.document.createElement("a");
      anchor.href = tab.requiresAccount && account
        ? `threads?id=${encodeURIComponent(account)}`
        : tab.href;
      anchor.textContent = tab.label;
      strip.append(anchor);
    });
    navigation.replaceChildren(strip);
    scope.add(() => navigation.replaceChildren(...previousNodes));
  }

  #topbarAccountName(): string | null {
    const profile = this.document.querySelector<HTMLAnchorElement>(
      '[data-hnr-topbar-account] a[href^="user?id="], [data-hnr-topbar-account] a[href*="/user?id="]',
    );
    if (!profile) return null;
    try {
      return new URL(profile.href, this.document.baseURI).searchParams.get("id")?.trim() || null;
    } catch {
      return null;
    }
  }

  #installResumeReaderCommand(scope: LifecycleScope): void {
    const accountStrip = this.document.querySelector<HTMLElement>(
      "[data-hnr-topbar-account] .pagetop",
    );
    if (!accountStrip || accountStrip.querySelector("[data-hnr-resume-reader]")) return;

    const button = this.document.createElement("button");
    button.type = "button";
    button.dataset.hnrResumeReader = "true";
    button.className = "hnr-resume-reader-command";
    button.setAttribute("aria-label", "打开上次阅读的 Topic");
    const icon = this.document.createElementNS(SVG_NAMESPACE, "svg");
    icon.setAttribute("viewBox", "0 0 24 24");
    icon.setAttribute("aria-hidden", "true");
    icon.setAttribute("data-hnr-resume-reader-icon", "true");
    const upperRight = this.document.createElementNS(SVG_NAMESPACE, "path");
    upperRight.setAttribute("d", "M15 3h6v6M21 3l-7 7");
    const lowerLeft = this.document.createElementNS(SVG_NAMESPACE, "path");
    lowerLeft.setAttribute("d", "M9 21H3v-6M3 21l7-7");
    icon.append(upperRight, lowerLeft);
    const tooltip = this.document.createElement("span");
    tooltip.id = "hnr-host-resume-reader-tooltip";
    tooltip.className = "hnr-tooltip hnr-host-resume-tooltip";
    tooltip.setAttribute("role", "tooltip");
    tooltip.textContent = "打开上次阅读的 Topic";
    button.setAttribute("aria-describedby", tooltip.id);
    button.append(icon, tooltip);
    const separator = this.document.createTextNode(" | ");
    accountStrip.prepend(button, separator);
    scope.add(() => { button.remove(); separator.remove(); });
    scope.listen(button, "click", () => {
      const storyId = this.#resumeStoryId;
      if (storyId === null || this.#readerOpen) return;
      this.#revealStoryRow(storyId);
      this.onOpen(storyId);
    });
    this.#syncResumeReaderCommand();
  }

  #syncResumeReaderCommand(): void {
    const button = this.document.querySelector<HTMLButtonElement>("[data-hnr-resume-reader]");
    if (button) button.hidden = this.#resumeStoryId === null || this.#readerOpen;
  }

  #syncTopbarSelection(scope: LifecycleScope): void {
    const currentPath = this.#currentUrl.pathname;
    for (const anchor of this.document.querySelectorAll<HTMLAnchorElement>(
      "[data-hnr-topbar-navigation] a[href]",
    )) {
      try {
        const url = new URL(anchor.href, this.document.baseURI);
        if (url.hostname === "news.ycombinator.com" && url.pathname === currentPath) {
          ownAttribute(scope, anchor, "data-hnr-topbar-active", "true");
        }
      } catch {
        // Invalid native links retain their original appearance and behavior.
      }
    }
  }

  #installReplyBackCommand(scope: LifecycleScope): void {
    const form = this.document.querySelector<HTMLFormElement>(
      '#hnmain form[action="comment"], #hnmain form[action$="/comment"]',
    );
    const container = form?.parentElement;
    if (!container || container.querySelector("[data-hnr-host-back]")) return;
    const toolbar = this.document.createElement("div");
    toolbar.className = "hnr-host-native-toolbar";
    const button = this.document.createElement("button");
    button.type = "button";
    button.dataset.hnrHostBack = "true";
    button.className = "hnr-host-back-command";
    button.textContent = "← 返回讨论";
    toolbar.append(button);
    container.prepend(toolbar);
    scope.add(() => toolbar.remove());
  }

  #installCommentRows(scope: LifecycleScope): void {
    const firstContent = this.document.querySelector<HTMLElement>("tr.athing[id] .commtext");
    const table = firstContent?.closest("tr.athing[id]")?.closest<HTMLTableElement>("table") ?? null;
    if (!table) return;
    ownClass(scope, table, "hnr-comment-list");
    const translationTargets: HnHostCommentTarget[] = [];
    for (const row of table.querySelectorAll<HTMLTableRowElement>("tr.athing[id]")) {
      const id = Number.parseInt(row.id, 10);
      if (!Number.isSafeInteger(id) || id <= 0) continue;
      const content = row.querySelector<HTMLElement>("td.default .commtext");
      if (!content) continue;
      ownAttribute(scope, row, "data-hnr-comment-card", String(id));
      const storyId = this.#commentStoryId(row);
      if (storyId !== null) {
        ownAttribute(scope, row, "data-hnr-comment-story", String(storyId));
        ownAttribute(scope, row, "tabindex", "0");
        const author = row.querySelector<HTMLElement>(".comhead .hnuser")?.textContent?.trim();
        ownAttribute(
          scope,
          row,
          "aria-label",
          author ? `Open ${author}'s comment in Reader` : `Open comment ${id} in Reader`,
        );
      }
      const spacer = row.nextElementSibling;
      if (spacer?.matches("tr.spacer")) {
        ownAttribute(scope, spacer, "data-hnr-comment-card-spacer", String(id));
      }
      if (this.onTranslateComments) {
        translationTargets.push({ id, html: content.innerHTML, content });
      }
    }
    if (translationTargets.length > 0) void this.#translateComments(translationTargets, scope);
  }

  #installListRows(
    rows: readonly HTMLTableRowElement[],
    scope: LifecycleScope,
  ): void {
    const titleTargets: HnHostTitleTarget[] = [];
    for (const row of rows) {
      const id = Number.parseInt(row.id, 10) as StoryId;
      if (!Number.isSafeInteger(id)) continue;
      this.#installExternalStoryLink(row, scope);
      ownAttribute(scope, row, "data-hnr-card-open", String(id));
      ownAttribute(scope, row, "tabindex", "0");
      const titleLink = row.querySelector<HTMLAnchorElement>(".titleline > a");
      const title = titleLink?.textContent?.trim();
      ownAttribute(
        scope,
        row,
        "aria-label",
        title ? `Open comments: ${title}` : `Open comments for story ${id}`,
      );
      const metadataRow = row.nextElementSibling;
      const subtext = metadataRow?.querySelector<HTMLElement>(".subtext");
      if (metadataRow && subtext) {
        ownAttribute(scope, metadataRow, "data-hnr-card-meta", String(id));
      }
      if (title && this.onTranslateTitles) titleTargets.push({ id, title, row });
      if (!subtext || subtext.querySelector("[data-hnr-link]")) continue;
      this.#appendReaderCommand(subtext, id, scope);
    }
    this.#syncActiveStoryRows();
    if (titleTargets.length > 0) void this.#translateTitles(titleTargets, scope);
  }

  #syncActiveStoryRows(): void {
    for (const row of this.document.querySelectorAll<HTMLElement>(
      "[data-hnr-card-open],[data-hnr-card-meta]",
    )) {
      const active = this.#activeStoryId !== null
        && this.#storyIdFromCard(row) === this.#activeStoryId;
      if (active) row.dataset.hnrCardActive = "true";
      else row.removeAttribute("data-hnr-card-active");
    }
  }

  #revealStoryRow(storyId: StoryId): void {
    const card = [...this.document.querySelectorAll<HTMLElement>("[data-hnr-card-open]")]
      .find((row) => this.#storyIdFromCard(row) === storyId);
    card?.scrollIntoView?.({ block: "center", inline: "nearest" });
  }

  #handleCardClick(event: Event): void {
    if (event.defaultPrevented || !(event instanceof MouseEvent) || event.button !== 0) return;
    if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
    const target = event.target;
    if (!(target instanceof Element)) return;
    const commentCard = target.closest<HTMLElement>("[data-hnr-comment-card]");
    const commentStoryId = this.#storyIdFromCard(commentCard);
    const commentId = this.#commentIdFromCard(commentCard);
    const anchor = target.closest<HTMLAnchorElement>("a[href]");
    if (commentStoryId !== null && anchor && this.#isHnItemLink(anchor)) {
      event.preventDefault();
      if (commentId !== null) this.onOpen(commentStoryId, commentId);
      else this.onOpen(commentStoryId);
      return;
    }
    if (commentCard) {
      if (target.closest(INTERACTIVE_TARGET_SELECTOR)) return;
      const selection = this.document.defaultView?.getSelection();
      if (selection && !selection.isCollapsed) return;
      if (commentStoryId !== null && commentId !== null) this.onOpen(commentStoryId, commentId);
      else if (commentStoryId !== null) this.onOpen(commentStoryId);
      return;
    }
    const card = target.closest<HTMLElement>("[data-hnr-card-open],[data-hnr-card-meta]");
    const id = this.#storyIdFromCard(card);
    if (target.closest(".titleline > a") && id !== null) {
      event.preventDefault();
      this.onOpen(id);
      return;
    }
    if (target.closest(INTERACTIVE_TARGET_SELECTOR)) return;
    const selection = this.document.defaultView?.getSelection();
    if (selection && !selection.isCollapsed) return;
    if (id !== null) this.onOpen(id);
  }

  #appendReaderCommand(
    subtext: HTMLElement,
    id: StoryId,
    scope: LifecycleScope,
  ): void {
    const separator = this.document.createTextNode(" | ");
    const button = this.document.createElement("button");
    button.type = "button";
    button.textContent = "reader";
    button.dataset.hnrLink = String(id);
    button.className = "hnr-reader-command";
    subtext.append(separator, button);
    scope.add(() => { separator.remove(); button.remove(); });
    scope.listen(button, "click", () => this.onOpen(id));
  }

  async #translateTitles(
    targets: readonly HnHostTitleTarget[],
    scope: LifecycleScope,
  ): Promise<void> {
    if (!this.onTranslateTitles) return;
    const signal = scope.abortController("宿主标题投影已替换", this.#translationSignal).signal;
    const targetsById = new Map(targets.map((target) => [target.id, target]));
    const rendered = new Map<number, HTMLElement>();
    const render = (update: HnHostTranslationUpdate): void => {
      if (scope.destroyed) return;
      const target = targetsById.get(update.id as StoryId);
      if (!target) return;
      if (update.complete && update.text.trim() === target.title) {
        rendered.get(update.id)?.remove();
        rendered.delete(update.id);
        return;
      }
      let output = rendered.get(update.id);
      if (!output) {
        output = this.document.createElement("div");
        output.dataset.hnrTitleTranslation = String(update.id);
        output.className = "hnr-title-translation hnr-host-translation";
        output.lang = "zh-CN";
        target.row.querySelector("td.title:last-child")?.append(output);
        rendered.set(update.id, output);
        scope.add(() => output?.remove());
      }
      this.#renderTranslationUpdate(output, update);
    };
    try {
      await this.onTranslateTitles(
        targets.map(({ id, title }) => ({ id, title })),
        signal,
        render,
      );
    } catch {
      this.#discardPendingTranslations(rendered);
      // Automatic title translation is additive; keep the original titles on failure.
    }
  }

  async #translateComments(
    targets: readonly HnHostCommentTarget[],
    scope: LifecycleScope,
  ): Promise<void> {
    if (!this.onTranslateComments) return;
    const signal = scope.abortController("宿主评论投影已替换", this.#translationSignal).signal;
    const targetsById = new Map(targets.map((target) => [target.id, target]));
    const rendered = new Map<number, HTMLElement>();
    const ensureOutput = (target: HnHostCommentTarget): HTMLElement => {
      const existing = rendered.get(target.id);
      if (existing) return existing;
      const output = this.document.createElement("div");
      output.dataset.hnrCommentTranslation = String(target.id);
      output.className = "hnr-comment-translation hnr-host-translation";
      output.lang = "zh-CN";
      target.content.after(output);
      rendered.set(target.id, output);
      scope.add(() => output.remove());
      return output;
    };
    for (const target of targets) {
      const section = this.document.createElement("span");
      section.className = "hnr-translation-section is-loading";
      const placeholder = this.document.createElement("span");
      placeholder.className = "hnr-translation-placeholder";
      placeholder.setAttribute("role", "status");
      placeholder.setAttribute("aria-label", "正在加载译文");
      placeholder.append(
        this.document.createElement("span"),
        this.document.createElement("span"),
        this.document.createElement("span"),
      );
      section.append(placeholder);
      ensureOutput(target).replaceChildren(section);
    }
    const render = (update: HnHostTranslationUpdate): void => {
      if (scope.destroyed) return;
      const target = targetsById.get(update.id);
      if (!target) return;
      if (update.complete && update.text.trim() === target.content.textContent?.trim()) {
        rendered.get(update.id)?.remove();
        rendered.delete(update.id);
        return;
      }
      const output = ensureOutput(target);
      this.#renderTranslationUpdate(output, update);
    };
    try {
      await this.onTranslateComments(
        targets.map(({ id, html }) => ({ id, html })),
        signal,
        render,
      );
      this.#discardPendingTranslations(rendered);
    } catch {
      this.#discardPendingTranslations(rendered);
      // Host translation is additive; keep the native comments on failure.
    }
  }

  #renderTranslationUpdate(
    output: HTMLElement,
    update: HnHostTranslationUpdate,
  ): void {
    output.dataset.hnrTranslationComplete = String(update.complete);
    if (update.html) output.innerHTML = update.html;
    else output.textContent = update.text;
  }

  #discardPendingTranslations(rendered: Map<number, HTMLElement>): void {
    for (const [id, output] of rendered) {
      for (const pending of output.querySelectorAll(
        ".hnr-translation-section.is-loading, .hnr-translation-section.is-streaming",
      )) pending.remove();
      if (output.childElementCount > 0 || output.textContent?.trim()) continue;
      output.remove();
      rendered.delete(id);
    }
  }

  #handleCardKeydown(event: KeyboardEvent): void {
    if (event.key !== "Enter" && event.key !== " ") return;
    const target = event.target;
    if (!(target instanceof Element) || target.closest(INTERACTIVE_TARGET_SELECTOR)) return;
    const card = target.closest<HTMLElement>("[data-hnr-card-open],[data-hnr-comment-card]");
    const id = this.#storyIdFromCard(card);
    if (id === null) return;
    event.preventDefault();
    const commentId = this.#commentIdFromCard(card);
    if (commentId !== null) this.onOpen(id, commentId);
    else this.onOpen(id);
  }

  #storyIdFromCard(card: HTMLElement | null): StoryId | null {
    const raw = card?.dataset.hnrCardOpen
      ?? card?.dataset.hnrCardMeta
      ?? card?.dataset.hnrCommentStory;
    if (!raw) return null;
    const id = Number.parseInt(raw, 10);
    return Number.isSafeInteger(id) && id > 0 ? id as StoryId : null;
  }

  #commentIdFromCard(card: HTMLElement | null): CommentId | null {
    const raw = card?.dataset.hnrCommentCard;
    if (!raw) return null;
    const id = Number.parseInt(raw, 10);
    return Number.isSafeInteger(id) && id > 0 ? id as CommentId : null;
  }

  #commentStoryId(row: HTMLTableRowElement): StoryId | null {
    const link = row.querySelector<HTMLAnchorElement>(".onstory a[href]");
    if (!link) return null;
    try {
      const id = Number.parseInt(new URL(link.href, this.document.baseURI).searchParams.get("id") ?? "", 10);
      return Number.isSafeInteger(id) && id > 0 ? id as StoryId : null;
    } catch {
      return null;
    }
  }

  #isHnItemLink(anchor: HTMLAnchorElement): boolean {
    try {
      const url = new URL(anchor.href, this.document.baseURI);
      return url.hostname === "news.ycombinator.com" && url.pathname === "/item" && url.searchParams.has("id");
    } catch {
      return false;
    }
  }

  #installExternalStoryLink(
    row: HTMLTableRowElement,
    scope: LifecycleScope = this.#scope,
  ): void {
    const link = row.querySelector<HTMLAnchorElement>(".titleline > a");
    if (!link) return;
    let url: URL;
    try {
      url = new URL(link.href, this.document.baseURI);
    } catch {
      return;
    }
    if ((url.protocol !== "http:" && url.protocol !== "https:") || url.hostname === "news.ycombinator.com") return;
    const previousTarget = link.getAttribute("target");
    const previousRel = link.getAttribute("rel");
    link.target = "_blank";
    link.rel = "noopener noreferrer";

    const tooltip = this.document.createElement("span");
    tooltip.id = `hnr-host-title-tooltip-${row.id}`;
    tooltip.className = "hnr-tooltip hnr-host-title-tooltip";
    tooltip.setAttribute("role", "tooltip");
    tooltip.textContent = ORIGINAL_STORY_TOOLTIP;
    link.insertAdjacentElement("afterend", tooltip);
    const describedBy = link.getAttribute("aria-describedby")?.trim();
    ownAttribute(
      scope,
      link,
      "aria-describedby",
      describedBy ? `${describedBy} ${tooltip.id}` : tooltip.id,
    );
    scope.add(() => {
      tooltip.remove();
      if (previousTarget === null) link.removeAttribute("target");
      else link.setAttribute("target", previousTarget);
      if (previousRel === null) link.removeAttribute("rel");
      else link.setAttribute("rel", previousRel);
    });
  }
}
