// @vitest-environment jsdom

import { describe, expect, it } from "vitest";
import type { HttpClient, HttpResponse, RequestDescriptor } from "../src/network/request-contract";
import { WordLookupService } from "../src/vocabulary/lookup";

const WIKTIONARY = {
  en: [{
    partOfSpeech: "Noun",
    definitions: [
      { definition: "a <b>stated</b> rule", parsedExamples: [{ example: "the stated <i>rule</i> holds" }] },
      { definition: "   " },
    ],
  }],
  zh: [{ partOfSpeech: "名詞", definitions: [{ definition: "規則" }] }],
};

const TATOEBA = {
  data: [
    { id: 7, text: "A long sentence about the word.", license: "CC BY 2.0 FR", owner: "alice", translations: [{ id: 8, text: "一句包含该词的长句。", lang: "cmn", license: "CC BY 2.0 FR", owner: "bob" }] },
    { id: 3, text: "Short word.", license: "CC BY 2.0 FR", owner: "carol", translations: [{ id: 4, text: "短句。", lang: "cmn", license: "CC BY 2.0 FR", owner: "dave" }] },
    { id: 9, text: "No Chinese here.", license: "", owner: "erin", translations: [{ id: 10, text: "Not Chinese.", lang: "eng", license: "", owner: "frank" }] },
  ],
};

/** Serves canned payloads per host and records every URL, so caching and failure isolation show up. */
class FakeHttpClient implements HttpClient {
  readonly calls: string[] = [];
  readonly failures = new Set<string>();
  dictionaryBody = JSON.stringify(WIKTIONARY);

  request<T>(descriptor: RequestDescriptor<T>): Promise<T> {
    this.calls.push(descriptor.url);
    const failure = [...this.failures].find((fragment) => descriptor.url.includes(fragment));
    if (failure !== undefined) return Promise.reject(new Error(`offline: ${failure}`));
    const body = descriptor.url.includes("wiktionary.org") ? this.dictionaryBody : JSON.stringify(TATOEBA);
    const response: HttpResponse = { status: 200, statusText: "OK", headers: {}, body, finalUrl: descriptor.url };
    return Promise.resolve(descriptor.decode(response));
  }
}

function service(): { readonly http: FakeHttpClient; readonly lookup: WordLookupService } {
  const http = new FakeHttpClient();
  return { http, lookup: new WordLookupService(http) };
}

describe("word lookup", () => {
  it("decodes Wiktionary senses as plain text, dropping markup and empty definitions", async () => {
    const { lookup } = service();
    const result = await lookup.loadDictionary("stated", new AbortController().signal);
    expect(result.cached).toBe(false);
    expect(result.value).toEqual([{
      partOfSpeech: "Noun",
      definitions: [{ definition: "a stated rule", example: "the stated rule holds" }],
    }]);
  });

  it("reports a dictionary without any usable sense as not found", async () => {
    const { lookup, http } = service();
    http.dictionaryBody = JSON.stringify({ en: [{ partOfSpeech: "Noun", definitions: [{ definition: "  " }] }] });
    await expect(lookup.loadDictionary("blank", new AbortController().signal)).rejects.toThrow(/暂未收录/);
  });

  it("keeps only Tatoeba sentences that carry a Chinese translation, shortest first", async () => {
    const { lookup } = service();
    const result = await lookup.loadExamples("word", new AbortController().signal);
    expect(result.value.map((example) => example.id)).toEqual([3, 7]);
    expect(result.value[0]).toMatchObject({ english: "Short word.", chinese: "短句。", translationId: 4, license: "CC BY 2.0 FR" });
  });

  it("asks each provider once per word and answers a later call from memory", async () => {
    const { http, lookup } = service();
    const signal = new AbortController().signal;
    await lookup.loadDictionary("stated", signal);
    await lookup.loadExamples("stated", signal);
    const dictionary = await lookup.loadDictionary("STATED", signal);
    const examples = await lookup.loadExamples("Stated", signal);
    expect(http.calls).toHaveLength(2);
    expect(dictionary.cached).toBe(true);
    expect(examples.cached).toBe(true);
  });

  it("keeps one failing provider from blanking the other", async () => {
    const { http, lookup } = service();
    http.failures.add("wiktionary.org");
    const signal = new AbortController().signal;
    await expect(lookup.loadDictionary("stated", signal)).rejects.toThrow(/offline/);
    const examples = await lookup.loadExamples("stated", signal);
    expect(examples.value).toHaveLength(2);
  });

  it("never reaches the network when the caller already aborted", async () => {
    const { http, lookup } = service();
    const controller = new AbortController();
    controller.abort();
    await expect(lookup.loadDictionary("stated", controller.signal)).rejects.toThrow(/abort/i);
    expect(http.calls).toHaveLength(0);
  });
});
