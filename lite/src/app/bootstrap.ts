import {
  HnHostController,
  installHnHostAppearance,
  markHnHostReady,
} from "../host/hn-host-controller";
import {
  HnHostNavigationController,
} from "../host/hn-host-navigation-controller";
import { HnHostPageAdapter } from "../host/hn-host-page-adapter";
import { HnListPageAdapter } from "../host/hn-list-page-adapter";
import { HnListPaginationController } from "../host/hn-list-pagination-controller";
import { activateHnNativeTabBypass } from "../host/hn-native-bypass";
import { HnHostReadingSettingsController } from "../host/hn-host-reading-settings-controller";
import { HnHostThemeController } from "../host/hn-host-theme-controller";
import { parseHnRoute } from "../host/hn-route";
import { LifecycleScope } from "../kernel/lifecycle";
import { RequestScheduler } from "../network/request-scheduler";
import { ReaderWorkspaceStateStore } from "../settings/reader-workspace-state-store";
import { SettingsStore } from "../settings/settings-store";
import { HostTitleTranslator } from "../translation/host-title-translator";
import { TranslationRuntime } from "../translation/translation-runtime";
import { ReaderController } from "./reader-controller";

export const HN_HTML_MAX_CONCURRENT = 2;

export function teardownHnHostForPageTransition(
  document: Document,
  scope: LifecycleScope,
  event: Event,
): void {
  if ((event as PageTransitionEvent).persisted) return;
  document.documentElement.style.setProperty("visibility", "hidden", "important");
  scope.destroy();
}

export function bootstrapHackerNewsReader(): void {
  if (activateHnNativeTabBypass(location.href, window)) return;
  const route = parseHnRoute(location);
  const scope = new LifecycleScope();
  const settingsStore = new SettingsStore();
  const initialSettings = settingsStore.load();
  const hostTheme = new HnHostThemeController(document, scope);
  hostTheme.apply(initialSettings.theme);
  const hostReadingSettings = new HnHostReadingSettingsController(document, scope);
  hostReadingSettings.apply(initialSettings);
  installHnHostAppearance(document, route, __HN_HOST_CSS__, scope);
  const start = (): void => {
    if (scope.destroyed) return;
    try {
      const workspaceStateStore = new ReaderWorkspaceStateStore();
      const workspaceState = workspaceStateStore.load();
      const hostPageScheduler = new RequestScheduler(HN_HTML_MAX_CONCURRENT);
      const translationRuntime = new TranslationRuntime(document, scope);
      let navigateHost: (url: string) => void = () => undefined;
      let refreshHostProjection: () => void = () => undefined;
      let setActiveHostStory: (storyId: Parameters<HnHostController["setActiveStory"]>[0]) => void = () => undefined;
      let setLastReadHostStory: (storyId: Parameters<HnHostController["setLastReadStory"]>[0]) => void = () => undefined;
      const reader = new ReaderController(document, scope, __HN_READER_CSS__, workspaceStateStore, {
        theme: hostTheme,
        pageScheduler: hostPageScheduler,
        translationRuntime,
        onHostNavigate: (url) => navigateHost(url),
        onSettingsPreview: (settings) => hostReadingSettings.apply(settings),
        onSettingsChange: (settings) => {
          hostReadingSettings.apply(settings);
          refreshHostProjection();
        },
        onActiveStoryChange: (storyId) => {
          setActiveHostStory(storyId);
          if (storyId === null) {
            try {
              setLastReadHostStory(workspaceStateStore.load().lastActiveStoryId);
            } catch {
              // A storage read failure must not block closing the Reader.
            }
            refreshHostProjection();
          }
        },
      });
      const titleTranslator = new HostTitleTranslator(
        document,
        scope,
        settingsStore,
        translationRuntime.service,
      );
      const host = new HnHostController(
        document,
        route,
        (storyId, commentId) => {
          void reader.open(storyId, commentId);
        },
        "",
        scope,
        workspaceState.lastActiveStoryId,
        (titles, signal, onTranslation) => titleTranslator.translateMany(
          titles,
          signal,
          onTranslation,
        ),
        (comments, signal, onTranslation) => titleTranslator.translateComments(
          comments,
          signal,
          onTranslation,
        ),
      );
      setActiveHostStory = (storyId) => host.setActiveStory(storyId);
      setLastReadHostStory = (storyId) => host.setLastReadStory(storyId);
      host.install();
      refreshHostProjection = () => host.refreshPageProjection();
      const listPageAdapter = new HnListPageAdapter(document, hostPageScheduler);
      const pagination = new HnListPaginationController(
        document,
        listPageAdapter,
        host,
        scope,
      );
      pagination.install();
      const hostPageAdapter = new HnHostPageAdapter(document, hostPageScheduler);
      const navigation = new HnHostNavigationController(
        document,
        hostPageAdapter,
        host,
        () => {
          pagination.resetForListPage();
          reader.syncHostDocumentTitle();
        },
        scope,
        () => pagination.suspendForHostNavigation(),
        (itemId) => {
          void reader.openItem(itemId);
        },
      );
      navigateHost = (url) => { void navigation.navigate(url); };
      navigation.install();
      if (route.kind === "item") {
        void reader.openItem(route.itemId).then(() => navigation.showHostPage("/news"));
      }
    } finally {
      markHnHostReady(document, scope);
    }
  };
  if (document.readyState === "loading") {
    scope.listen(document, "DOMContentLoaded", start, { once: true });
  } else {
    start();
  }
  scope.listen(window, "pagehide", (event) => {
    teardownHnHostForPageTransition(document, scope, event);
  });
}
