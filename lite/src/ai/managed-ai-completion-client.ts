import { hashText } from "../kernel/hash";
import type { AiProfile } from "../settings/settings-store";
import type { AiCompletionPort } from "../summary/summary-service";
import { TranslationTaskManager } from "../translation/translation-task-manager";
import type { AiCompletionClient, AiMessage } from "./ai-completion-client";

export class ManagedAiCompletionClient implements AiCompletionPort {
  constructor(
    readonly client: AiCompletionClient,
    readonly tasks: TranslationTaskManager,
  ) {}

  complete(profile: AiProfile, operation: string, messages: readonly AiMessage[], signal?: AbortSignal): Promise<string> {
    const taskSignal = signal ?? new AbortController().signal;
    const content = messages.map((message) => message.content).join("\n");
    return this.tasks.request({
      key: `ai-completion:${operation}:${hashText(`${profile.baseUrl}|${profile.model}|${content}`)}`,
      serviceKey: `ai:${profile.baseUrl}:${profile.model}`,
      priority: "interactive",
      signal: taskSignal,
      quota: {
        requestsPerMinute: profile.requestsPerMinute,
        tokensPerMinute: profile.tokensPerMinute,
      },
      estimatedTokens: Math.ceil(content.length / 3),
    }, (managedSignal) => this.client.complete(profile, operation, messages, managedSignal));
  }
}
