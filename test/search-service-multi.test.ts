import { beforeEach, describe, expect, it, vi } from "vitest";
import type { EmbeddingClient } from "../src/ai/embedding-client.js";
import type { LlmClient } from "../src/ai/llm-client.js";
import type { RerankClient } from "../src/ai/rerank-client.js";

const repositories = vi.hoisted(() => ({
  assertSourcesAccessible: vi.fn(),
  coarseRankEventsByContent: vi.fn(),
  getEventIdsByEntityIds: vi.fn(),
  getEventsWithEntityIds: vi.fn(),
  getSectionsForEvents: vi.fn(),
  searchChunksByVector: vi.fn(),
  searchEntitiesByName: vi.fn(),
  searchEntitiesByText: vi.fn(),
  searchEntitiesByVector: vi.fn(),
  searchEventsByTitleVector: vi.fn()
}));

vi.mock("../src/db/repositories.js", () => repositories);

import { SearchService } from "../src/services/search-service.js";

describe("SearchService multi search", () => {
  beforeEach(() => {
    for (const mock of Object.values(repositories)) {
      mock.mockReset();
    }
    repositories.assertSourcesAccessible.mockResolvedValue(undefined);
    repositories.searchEntitiesByName.mockResolvedValue([]);
    repositories.searchEntitiesByText.mockResolvedValue([]);
    repositories.searchEntitiesByVector.mockResolvedValue([]);
    repositories.getEventIdsByEntityIds.mockResolvedValue([]);
    repositories.searchEventsByTitleVector.mockResolvedValue([]);
    repositories.searchChunksByVector.mockResolvedValue([]);
  });

  it("uses SAG2 multi defaults for thresholds and query-event oversampling", async () => {
    const embeddings: EmbeddingClient = {
      generate: vi.fn(async () => [1, 0, 0]),
      batchGenerate: vi.fn()
    };
    const llm: LlmClient = {
      extractNamedEntities: vi.fn(async () => ["SAG"]),
      extractEventsFromChunk: vi.fn(),
      rerankEvents: vi.fn()
    };
    const service = new SearchService(embeddings, llm);

    await service.search({
      query: "SAG 多跳检索",
      sourceIds: ["00000000-0000-0000-0000-000000000001"],
      strategy: "multi",
      searchMode: "standard"
    });

    expect(repositories.searchEntitiesByVector).toHaveBeenCalledWith(expect.objectContaining({
      topK: 20,
      threshold: 0.9
    }));
    expect(repositories.searchEventsByTitleVector).toHaveBeenCalledWith(expect.objectContaining({
      topK: 60,
      threshold: 0.4
    }));
  });

  it("caps vector search results to top 5 at the service boundary", async () => {
    const embeddings: EmbeddingClient = {
      generate: vi.fn(async () => [1, 0, 0]),
      batchGenerate: vi.fn()
    };
    const llm: LlmClient = {
      extractNamedEntities: vi.fn(async () => []),
      extractEventsFromChunk: vi.fn(async () => []),
      rerankEvents: vi.fn(async () => [])
    };
    const service = new SearchService(embeddings, llm);
    const sourceId = "00000000-0000-0000-0000-000000000001";
    repositories.searchChunksByVector.mockResolvedValue(Array.from({ length: 6 }, (_, index) => ({
      chunkId: `chunk-${index + 1}`,
      sourceId,
      documentId: "00000000-0000-0000-0000-000000000002",
      heading: `切片 ${index + 1}`,
      content: `内容 ${index + 1}`,
      rank: index,
      score: 1
    })));

    const result = await service.search({
      query: "SAG topK",
      sourceIds: [sourceId],
      strategy: "vector",
      topK: 50
    });

    expect(repositories.searchChunksByVector).toHaveBeenCalledWith(expect.objectContaining({
      topK: 5
    }));
    expect(result.sections).toHaveLength(5);
  });

  it("expands only through new entities and ranks dual-phase candidates separately", async () => {
    const embeddings: EmbeddingClient = {
      generate: vi.fn(async () => [1, 0, 0]),
      batchGenerate: vi.fn()
    };
    const llm: LlmClient = {
      extractNamedEntities: vi.fn(async () => ["初始实体"]),
      extractEventsFromChunk: vi.fn(),
      rerankEvents: vi.fn(async () => [])
    };
    const service = new SearchService(embeddings, llm);
    const sourceId = "00000000-0000-0000-0000-000000000001";

    repositories.searchEntitiesByVector.mockResolvedValue([entity("entity-query", sourceId, "初始实体")]);
    repositories.getEventIdsByEntityIds
      .mockResolvedValueOnce(["event-seed"])
      .mockResolvedValueOnce(["event-hop1"])
      .mockResolvedValueOnce(["event-hop2"]);
    repositories.getEventsWithEntityIds
      .mockResolvedValueOnce(new Map([
        ["event-seed", event("event-seed", sourceId, ["entity-query", "entity-new"])]
      ]))
      .mockResolvedValueOnce(new Map([
        ["event-hop1", event("event-hop1", sourceId, ["entity-new", "entity-hop2"])]
      ]));
    repositories.coarseRankEventsByContent.mockImplementation(async (input: { eventIds: string[] }) => (
      input.eventIds.map((id) => event(id, sourceId, []))
    ));
    repositories.getSectionsForEvents.mockResolvedValue([]);

    await service.search({
      query: "解释多跳检索",
      sourceIds: [sourceId],
      strategy: "multi",
      searchMode: "standard",
      subStrategy: "multi1",
      multi: {
        maxEventsB: 1
      }
    });

    expect(repositories.getEventIdsByEntityIds).toHaveBeenNthCalledWith(1, expect.objectContaining({
      entityIds: ["entity-query"]
    }));
    expect(repositories.getEventIdsByEntityIds).toHaveBeenNthCalledWith(2, expect.objectContaining({
      entityIds: ["entity-new"]
    }));
    expect(repositories.getEventIdsByEntityIds).toHaveBeenNthCalledWith(3, expect.objectContaining({
      entityIds: ["entity-hop2"]
    }));
    expect(repositories.coarseRankEventsByContent).toHaveBeenNthCalledWith(1, expect.objectContaining({
      eventIds: ["event-seed", "event-hop1"],
      maxEvents: 100
    }));
    expect(repositories.coarseRankEventsByContent).toHaveBeenNthCalledWith(2, expect.objectContaining({
      eventIds: ["event-hop2"],
      maxEvents: 1
    }));
  });

  it("caps LLM rerank and final sections to top 5", async () => {
    const embeddings: EmbeddingClient = {
      generate: vi.fn(async () => [1, 0, 0]),
      batchGenerate: vi.fn()
    };
    const llm: LlmClient = {
      extractNamedEntities: vi.fn(async () => []),
      extractEventsFromChunk: vi.fn(),
      rerankEvents: vi.fn(async (input: { candidates: Array<{ id: string }>; topK: number }) => (
        input.candidates.slice(0, input.topK).map((candidate) => candidate.id)
      ))
    };
    const service = new SearchService(embeddings, llm);
    const sourceId = "00000000-0000-0000-0000-000000000001";
    const events = Array.from({ length: 6 }, (_, index) => event(`event-${index + 1}`, sourceId, []));

    repositories.searchEventsByTitleVector.mockResolvedValue(events);
    repositories.getEventsWithEntityIds.mockResolvedValue(new Map(events.map((item) => [item.id, item])));
    repositories.coarseRankEventsByContent.mockResolvedValue(events);
    repositories.getSectionsForEvents.mockResolvedValue(events.map((item, index) => ({
      eventId: item.id,
      chunkId: `chunk-${index + 1}`,
      sourceId,
      documentId: item.documentId,
      heading: item.title,
      content: item.content,
      rank: index,
      score: 1
    })));

    const result = await service.search({
      query: "SAG topK",
      sourceIds: [sourceId],
      strategy: "multi",
      searchMode: "standard",
      topK: 50
    });

    expect(llm.rerankEvents).toHaveBeenCalledWith(expect.objectContaining({
      topK: 5
    }));
    expect(result.sections).toHaveLength(5);
  });

  it("uses fast mode without LLM entity extraction or LLM rerank", async () => {
    const embeddings: EmbeddingClient = {
      generate: vi.fn(async () => [1, 0, 0]),
      batchGenerate: vi.fn()
    };
    const llm: LlmClient = {
      extractNamedEntities: vi.fn(async () => ["不应调用"]),
      extractEventsFromChunk: vi.fn(),
      rerankEvents: vi.fn(async () => ["不应调用"])
    };
    const reranker: RerankClient = {
      rerankEvents: vi.fn(async (input: { candidates: Array<{ id: string }>; topK: number }) => (
        input.candidates.slice(0, input.topK).map((candidate) => candidate.id)
      ))
    };
    const service = new SearchService(embeddings, llm, reranker);
    const sourceId = "00000000-0000-0000-0000-000000000001";
    const matchedEntity = entity("entity-query", sourceId, "SAG");
    const events = Array.from({ length: 3 }, (_, index) => event(`event-${index + 1}`, sourceId, ["entity-query"]));

    repositories.searchEntitiesByText.mockResolvedValue([matchedEntity]);
    repositories.getEventIdsByEntityIds.mockResolvedValue(["event-1"]);
    repositories.searchEventsByTitleVector.mockResolvedValue(events);
    repositories.getEventsWithEntityIds.mockResolvedValue(new Map(events.map((item) => [item.id, item])));
    repositories.coarseRankEventsByContent.mockResolvedValue(events);
    repositories.getSectionsForEvents.mockResolvedValue(events.map((item, index) => ({
      eventId: item.id,
      chunkId: `chunk-${index + 1}`,
      sourceId,
      documentId: item.documentId,
      heading: item.title,
      content: item.content,
      rank: index,
      score: 1
    })));

    const result = await service.search({
      query: "SAG 为什么快",
      sourceIds: [sourceId],
      strategy: "multi",
      searchMode: "fast",
      returnTrace: true,
      topK: 5
    });

    expect(llm.extractNamedEntities).not.toHaveBeenCalled();
    expect(llm.rerankEvents).not.toHaveBeenCalled();
    expect(repositories.searchEntitiesByText).toHaveBeenCalledWith(expect.objectContaining({
      query: "SAG 为什么快",
      limit: 20
    }));
    expect(reranker.rerankEvents).toHaveBeenCalledWith(expect.objectContaining({
      topK: 5
    }));
    expect(result.trace?.searchMode).toBe("fast");
    expect(result.trace?.recalledEntities).toHaveLength(1);
    expect(result.sections).toHaveLength(3);
  });
});

function entity(id: string, sourceId: string, name: string) {
  return {
    id,
    sourceId,
    type: "subject",
    name,
    normalizedName: name.toLowerCase(),
    score: 1
  };
}

function event(id: string, sourceId: string, entityIds: string[]) {
  return {
    id,
    sourceId,
    documentId: "00000000-0000-0000-0000-000000000002",
    chunkId: "00000000-0000-0000-0000-000000000003",
    title: id,
    summary: id,
    content: id,
    rank: 0,
    score: 1,
    entityIds
  };
}
