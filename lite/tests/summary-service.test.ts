import { describe, expect, it } from "vitest";
import type { AiMessage } from "../src/ai/ai-completion-client";
import type { ArticleSnapshot } from "../src/article/article-extractor";
import { CacheRepository } from "../src/cache/cache-repository";
import { MemoryCacheStore } from "../src/cache/cache-store";
import { DEFAULT_SETTINGS, type AiProfile } from "../src/settings/settings-store";
import { SummaryService, type AiCompletionPort, type CachedSummary } from "../src/summary/summary-service";
import type { Comment, Story, ThreadSnapshot } from "../src/thread/model";

const profile: AiProfile = { ...DEFAULT_SETTINGS.ai, apiKey: "test-key", model: "test-model" };
const story: Story = {
  id: 1 as never, title: "A story", url: "https://example.com", author: "pg", score: 10,
  html: "", childIds: [2 as never, 5 as never], descendants: 4, observedAt: 1,
};

function comment(id: number, parentId: number, childIds: number[] = []): Comment {
  return {
    id: id as never, storyId: 1 as never, parentId: parentId as never, childIds: childIds as never,
    rank: id, author: `user-${id}`, createdAt: null, html: `<p>comment ${id}</p>`, text: `comment ${id}`,
    deleted: false, dead: false, source: "dom", observedAt: 1,
  };
}

const comments = [comment(2, 1, [3, 4]), comment(3, 2), comment(4, 2), comment(5, 1)];
const snapshot: ThreadSnapshot = {
  schemaVersion: 1, story, comments, loadedIds: comments.map((item) => item.id), missingIds: [], complete: true, capturedAt: 1,
};
const article: ArticleSnapshot = {
  sourceUrl: "https://example.com", canonicalUrl: "https://example.com/article", title: "Article", byline: null,
  siteName: "example.com", html: "<p>Article body</p>", text: "Article body ".repeat(20), wordCount: 40,
  quality: "good", extractedAt: 1,
};

class FakeAi implements AiCompletionPort {
  readonly calls: { operation: string; messages: readonly AiMessage[] }[] = [];
  discussionCommentId = 2;

  complete(_profile: AiProfile, operation: string, messages: readonly AiMessage[]): Promise<string> {
    this.calls.push({ operation, messages });
    if (operation.startsWith("article-summary:")) {
      return Promise.resolve(JSON.stringify({ overview: "article overview", keyPoints: ["point"], caveats: ["caveat"] }));
    }
    return Promise.resolve(`\`\`\`json\n${JSON.stringify({
      overview: "discussion overview", consensus: ["yes"], disputes: ["no"],
      branches: [{ commentId: this.discussionCommentId, summary: "branch" }], coverageNote: "all useful comments",
    })}\n\`\`\``);
  }
}

function service(ai = new FakeAi(), now: () => number = Date.now): { summary: SummaryService; ai: FakeAi } {
  return { summary: new SummaryService(new CacheRepository<CachedSummary>(new MemoryCacheStore(), now), ai, now), ai };
}

describe("SummaryService", () => {
  it("summarizes one reply branch and reuses the separate discussion cache", async () => {
    const pair = service();
    const first = await pair.summary.summarizeDiscussion(snapshot, { kind: "branch", rootId: 2 as never }, "standard", profile);
    const second = await pair.summary.summarizeDiscussion(snapshot, { kind: "branch", rootId: 2 as never }, "standard", profile);
    expect(first.includedComments).toBe(3);
    expect(second).toBe(first);
    expect(pair.ai.calls).toHaveLength(1);
    const payload = pair.ai.calls[0]?.messages[1]?.content ?? "";
    expect(payload).toContain('"id":2');
    expect(payload).toContain('"id":4');
    expect(payload).not.toContain('"id":5');
  });

  it("rejects AI references to comments outside the submitted scope", async () => {
    const pair = service();
    pair.ai.discussionCommentId = 5;
    await expect(pair.summary.summarizeDiscussion(snapshot, { kind: "branch", rootId: 2 as never }, "short", profile))
      .rejects.toThrow(/范围外评论/);
  });

  it("keeps article and discussion operations and caches distinct", async () => {
    const pair = service();
    const discussion = await pair.summary.summarizeDiscussion(snapshot, { kind: "all" }, "standard", profile);
    const result = await pair.summary.summarizeArticle(article, "standard", profile);
    await pair.summary.summarizeArticle(article, "standard", profile);
    expect(discussion.kind).toBe("discussion");
    expect(result.kind).toBe("article");
    expect(pair.ai.calls.map((call) => call.operation)).toEqual([
      expect.stringMatching(/^discussion-summary:/),
      expect.stringMatching(/^article-summary:/),
    ]);
  });

  it("keeps one deduplicated 30-day history across all summarized stories", async () => {
    let currentTime = Date.UTC(2026, 7, 17, 8);
    const ai = new FakeAi();
    const pair = service(ai, () => currentTime);
    await pair.summary.summarizeDiscussion(snapshot, { kind: "branch", rootId: 2 as never }, "standard", profile);
    currentTime += 1_000;
    await pair.summary.summarizeDiscussion(snapshot, { kind: "all" }, "short", profile);

    let history = await pair.summary.listDiscussionHistory();
    expect(history).toHaveLength(2);
    expect(history[0]).toMatchObject({
      storyId: story.id,
      storyTitle: story.title,
      scope: { kind: "all" },
      length: "short",
      model: "test-model",
      savedAt: currentTime,
    });
    const otherStory: Story = { ...story, id: 10 as never, title: "Another story", childIds: [11 as never] };
    const otherComment: Comment = { ...comment(11, 10), storyId: otherStory.id, parentId: otherStory.id };
    const otherSnapshot: ThreadSnapshot = {
      ...snapshot,
      story: otherStory,
      comments: [otherComment],
      loadedIds: [otherComment.id],
    };
    ai.discussionCommentId = 11;
    currentTime += 1_000;
    await pair.summary.summarizeDiscussion(otherSnapshot, { kind: "all" }, "detailed", profile);
    history = await pair.summary.listDiscussionHistory();
    expect(history.map((entry) => entry.storyTitle)).toEqual(["Another story", "A story", "A story"]);
    expect(await pair.summary.listDiscussionHistory(story.id)).toHaveLength(2);
    expect(await pair.summary.listDiscussionHistory(99 as never)).toEqual([]);

    currentTime += 1_000;
    await pair.summary.summarizeDiscussion(snapshot, { kind: "branch", rootId: 2 as never }, "standard", profile);
    history = await pair.summary.listDiscussionHistory();
    expect(history).toHaveLength(3);
    expect(history[0]?.scope).toEqual({ kind: "branch", rootId: 2 });
    expect(pair.ai.calls).toHaveLength(3);

    currentTime += 30 * 24 * 60 * 60 * 1_000 + 1;
    expect(await pair.summary.listDiscussionHistory()).toEqual([]);
  });

  it("does not make a hidden AI request without an explicit profile", async () => {
    const pair = service();
    await expect(pair.summary.summarizeDiscussion(snapshot, { kind: "all" }, "standard", DEFAULT_SETTINGS.ai))
      .rejects.toThrow(/API Key/);
    expect(pair.ai.calls).toHaveLength(0);
  });
});
