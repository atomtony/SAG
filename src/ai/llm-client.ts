import { aiSettingsService, type AiRuntimeSettings } from "../services/ai-settings-service.js";
import type { ExtractedEntity, ExtractedEvent, EventRecord } from "../types.js";
import { createModelCallLogger } from "../observability/model-call-log.js";

export interface LlmClient {
  extractNamedEntities(query: string): Promise<string[]>;
  extractEventsFromChunk(input: {
    title: string;
    heading?: string;
    content: string;
    references: string[];
  }): Promise<ExtractedEvent[]>;
  rerankEvents(input: {
    query: string;
    candidates: EventRecord[];
    topK: number;
  }): Promise<string[]>;
}

export class OpenAICompatibleLlmClient implements LlmClient {
  async extractNamedEntities(query: string): Promise<string[]> {
    const settings = await aiSettingsService.getRuntimeSettings();
    if (!settings.hasRemoteLlm) {
      const log = createModelCallLogger({
        kind: "llm",
        operation: "extractNamedEntities.local",
        request: { query }
      });
      const entities = localNamedEntities(query);
      log.succeed({ named_entities: entities });
      return entities;
    }
    const result = await this.chatJson(settings, {
      system: "Extract named entities important for answering the question. Return JSON only.",
      user: JSON.stringify({
        question: query,
        schema: { named_entities: ["string"] }
      })
    });
    const entities = Array.isArray(result.named_entities) ? result.named_entities : result.entities;
    return Array.isArray(entities) ? entities.map(String).filter(Boolean) : localNamedEntities(query);
  }

  async extractEventsFromChunk(input: {
    title: string;
    heading?: string;
    content: string;
    references: string[];
  }): Promise<ExtractedEvent[]> {
    const settings = await aiSettingsService.getRuntimeSettings();
    if (!settings.hasRemoteLlm) {
      const log = createModelCallLogger({
        kind: "llm",
        operation: "extractEventsFromChunk.local",
        request: input
      });
      const events = [localExtractEvent(input)];
      log.succeed({ events });
      return events;
    }
    const result = await this.chatJson(settings, {
      system: buildSag2ExtractionSystemPrompt(),
      user: JSON.stringify({
        type: "request",
        data: {
          items: [{
            id: 1,
            content: [
              input.heading ? `# ${input.heading}` : "",
              input.content
            ].filter(Boolean).join("\n\n")
          }],
          meta: {
            source_type: "article",
            source_title: input.title,
            source_summary: "",
            previous_context: "",
            entity_types: [
              { type: "person", description: "人物、作者、用户、负责人等具体个人" },
              { type: "organization", description: "公司、机构、团体、政府部门、学校、团队等组织" },
              { type: "location", description: "地点、地域、国家、城市、场所、地址" },
              { type: "time", description: "日期、年份、时期、时间表达" },
              { type: "product", description: "产品、系统、平台、模型、软件、服务、数据库" },
              { type: "metric", description: "数字、指标、金额、比例、数量、评分、性能数据" },
              { type: "action", description: "动作、行为、流程、操作、状态变化" },
              { type: "work", description: "作品、文档、论文、项目、任务、计划" },
              { type: "group", description: "人群、角色群体、职业群体、用户群体" },
              { type: "subject", description: "主题、概念、领域、技术、专业术语、事件名称" },
              { type: "tags", description: "其他类型均不匹配时使用的标签实体" }
            ],
            output_language: "必须与输入正文的主要语言一致；中文输入输出中文，英文输入输出英文，不要翻译专有名词之外的内容。"
          }
        }
      })
    });
    const items = Array.isArray(result.items) ? result.items : result.data?.items;
    if (!Array.isArray(items) || items.length === 0) {
      return [localExtractEvent(input)];
    }
    const inputIsChinese = isMostlyChinese(input.content);
    const event = buildSingleExtractedEvent(items, input, inputIsChinese);
    return event ? [event] : [localExtractEvent(input)];
  }

  async rerankEvents(input: {
    query: string;
    candidates: EventRecord[];
    topK: number;
  }): Promise<string[]> {
    const settings = await aiSettingsService.getRuntimeSettings();
    if (!settings.hasRemoteLlm) {
      const log = createModelCallLogger({
        kind: "llm",
        operation: "rerankEvents.local",
        request: input
      });
      const ids = localRerank(input.query, input.candidates, input.topK);
      log.succeed({ useful_event_ids: ids });
      return ids;
    }
    const result = await this.chatJson(settings, {
      system: `Select exactly ${input.topK} event ids most useful for answering the question. Return JSON only.`,
      user: JSON.stringify({
        question: input.query,
        candidates: input.candidates.map((candidate) => ({
          id: candidate.id,
          title: candidate.title,
          content: candidate.content.slice(0, 1200),
          score: candidate.score ?? 0
        })),
        output_schema: { useful_event_ids: ["uuid"] }
      })
    });
    const ids = result.useful_event_ids ?? result.event_ids;
    return Array.isArray(ids)
      ? ids.map(String).filter((id) => input.candidates.some((candidate) => candidate.id === id)).slice(0, input.topK)
      : localRerank(input.query, input.candidates, input.topK);
  }

  private async chatJson(settings: AiRuntimeSettings, input: { system: string; user: string }): Promise<Record<string, any>> {
    const url = `${settings.llmBaseUrl.replace(/\/$/, "")}/chat/completions`;
    const body = {
      model: settings.llmModel,
      messages: [
        { role: "system", content: input.system },
        { role: "user", content: input.user }
      ],
      response_format: { type: "json_object" },
      temperature: 0.1
    };

    let lastError: unknown;
    const maxAttempts = settings.llmMaxRetries + 1;
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), settings.llmTimeoutMs);
      const log = createModelCallLogger({
        kind: "llm",
        operation: "chatJson",
        request: {
          url,
          method: "POST",
          attempt,
          maxAttempts,
          headers: {
            "Content-Type": "application/json"
          },
          body
        }
      });
      let logged = false;
      try {
        const response = await fetch(url, {
          method: "POST",
          signal: controller.signal,
          headers: {
            Authorization: `Bearer ${settings.llmApiKey}`,
            "Content-Type": "application/json"
          },
          body: JSON.stringify(body)
        });
        const { responseText, responseBody } = await readResponseBody(response);
        if (!response.ok) {
          const error = new Error(`llm request failed: ${response.status} ${responseText.slice(0, 500)}`);
          log.fail(error, {
            status: response.status,
            body: responseBody
          });
          logged = true;
          lastError = error;
          if (attempt < maxAttempts && isRetryableHttpStatus(response.status)) {
            await waitBeforeRetry(attempt);
            continue;
          }
          throw error;
        }
        const json = responseBody as { choices?: Array<{ message?: { content?: string } }> };
        const content = json.choices?.[0]?.message?.content ?? "{}";
        const parsed = JSON.parse(content);
        log.succeed({
          status: response.status,
          body: responseBody,
          parsed
        });
        return parsed;
      } catch (error) {
        lastError = error;
        if (!logged) {
          log.fail(error);
        }
        if (attempt < maxAttempts && isRetryableFetchError(error)) {
          await waitBeforeRetry(attempt);
          continue;
        }
        throw error;
      } finally {
        clearTimeout(timeout);
      }
    }
    throw lastError instanceof Error ? lastError : new Error(String(lastError));
  }
}

function parseJsonOrText(text: string): unknown {
  if (!text) {
    return null;
  }
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

async function readResponseBody(response: Response): Promise<{ responseText: string; responseBody: unknown }> {
  const maybeText = (response as Response & { text?: () => Promise<string> }).text;
  if (typeof maybeText === "function") {
    const responseText = await maybeText.call(response);
    return {
      responseText,
      responseBody: parseJsonOrText(responseText)
    };
  }
  const responseBody = await (response as Response & { json: () => Promise<unknown> }).json();
  return {
    responseText: typeof responseBody === "string" ? responseBody : JSON.stringify(responseBody),
    responseBody
  };
}

function isRetryableHttpStatus(status: number): boolean {
  return status === 408 || status === 429 || status >= 500;
}

function isRetryableFetchError(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }
  return error.name === "AbortError" || error.message.includes("fetch failed");
}

async function waitBeforeRetry(attempt: number): Promise<void> {
  const delayMs = Math.min(1_000, 100 * 2 ** Math.max(0, attempt - 1));
  await new Promise((resolve) => setTimeout(resolve, delayMs));
}

function normalizeEntities(raw: unknown, inputIsChinese: boolean): ExtractedEntity[] {
  if (!Array.isArray(raw)) {
    return [];
  }
  return raw
    .map((item) => {
      const record = item as Record<string, unknown>;
      const name = String(record.name ?? "").trim();
      const description = String(record.description ?? "").trim();
      return {
        type: normalizeEntityType(String(record.type ?? "subject")),
        name,
        description: normalizeEntityDescription(description, inputIsChinese)
      };
    })
    .filter((entity) => entity.name.length > 1);
}

function collectValidEventItems(items: unknown[]): Array<Record<string, unknown>> {
  const collected: Array<Record<string, unknown>> = [];
  for (const item of items) {
    if (!item || typeof item !== "object") {
      continue;
    }
    const record = item as Record<string, unknown>;
    if (record.is_valid !== false) {
      collected.push(record);
    }
    if (Array.isArray(record.children)) {
      collected.push(...collectValidEventItems(record.children));
    }
  }
  return collected;
}

function buildSingleExtractedEvent(
  items: unknown[],
  input: { title: string; heading?: string; content: string; references: string[] },
  inputIsChinese: boolean
): ExtractedEvent | null {
  const eventItems = collectValidEventItems(items);
  if (eventItems.length === 0) {
    return null;
  }

  const primary = eventItems[0];
  const content = buildConciseEventContent(eventItems, input.content, inputIsChinese);
  if (isLikelyLanguageDrift(content, inputIsChinese)) {
    return null;
  }
  const keywords = uniqueStrings(
    eventItems.flatMap((item) => Array.isArray(item.keywords) ? item.keywords.map(String) : [])
  );
  const entities = uniqueEntities(eventItems.flatMap((item) => normalizeEntities(item.entities, inputIsChinese)));
  const title = normalizeEventText(String(primary.title ?? ""), input.heading ?? input.title, inputIsChinese);
  const summary = normalizeEventText(String(primary.summary ?? ""), title, inputIsChinese);
  const category = normalizeCategory(primary.category, inputIsChinese);

  return {
    title,
    summary,
    content,
    category,
    keywords: keywords.length > 0 ? keywords : localKeywords(input.content),
    references: input.references,
    entities
  };
}

function normalizeEventText(value: string, fallback: string, inputIsChinese: boolean): string {
  const text = value.trim();
  if (!text || isLikelyLanguageDrift(text, inputIsChinese)) {
    return fallback;
  }
  return text;
}

function normalizeCategory(value: unknown, inputIsChinese: boolean): string {
  const fallback = inputIsChinese ? "一般事项" : "general";
  const category = value == null ? "" : String(value).trim();
  const hasChinese = /[\u4e00-\u9fa5]/.test(category);
  if (!category || isLikelyLanguageDrift(category, inputIsChinese) || (inputIsChinese && !hasChinese)) {
    return fallback;
  }
  return category;
}

function normalizeEntityDescription(description: string, inputIsChinese: boolean): string {
  if (!description || isLikelyLanguageDrift(description, inputIsChinese)) {
    return inputIsChinese ? "在当前事项中被提及" : "Mentioned in the current event";
  }
  return description;
}

function buildConciseEventContent(
  eventItems: Array<Record<string, unknown>>,
  fallbackContent: string,
  inputIsChinese: boolean
): string {
  const candidates = uniqueStrings(
    eventItems.flatMap((item) => [
      String(item.summary ?? "").trim(),
      String(item.content ?? "").trim()
    ]).filter(Boolean)
  );
  const raw = candidates.join(inputIsChinese ? "；" : "; ") || fallbackContent.trim();
  return conciseText(raw, inputIsChinese);
}

function conciseText(text: string, inputIsChinese: boolean): string {
  const cleaned = text.replace(/\s+/g, " ").trim();
  const maxLength = inputIsChinese ? 180 : 360;
  if (cleaned.length <= maxLength) {
    return cleaned;
  }
  const sentencePattern = inputIsChinese ? /[^。！？；;]+[。！？；;]?/gu : /[^.!?;]+[.!?;]?/g;
  const sentences = cleaned.match(sentencePattern)?.map((item) => item.trim()).filter(Boolean) ?? [cleaned];
  const selected: string[] = [];
  let length = 0;
  for (const sentence of sentences) {
    if (selected.length >= 3) {
      break;
    }
    if (length + sentence.length > maxLength && selected.length > 0) {
      break;
    }
    selected.push(sentence);
    length += sentence.length;
  }
  const result = selected.join(inputIsChinese ? "" : " ").trim();
  if (result.length <= maxLength) {
    return result;
  }
  return `${result.slice(0, maxLength - 1).trim()}…`;
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}

function uniqueEntities(entities: ExtractedEntity[]): ExtractedEntity[] {
  const seen = new Set<string>();
  const result: ExtractedEntity[] = [];
  for (const entity of entities) {
    const key = `${entity.type}:${entity.name.toLowerCase()}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    result.push(entity);
  }
  return result;
}

function buildSag2ExtractionSystemPrompt(): string {
  return `
## Role

你是专业的内容提取器，核心任务是从原始文档中提取「事项」和「实体」两类结构化信息，用于构建事项中心知识图谱。

事项提取：按语义单元组织内容，确保每个事项独立可读、语义完整，严格忠于原文事实，不增删核心信息，不篡改原文逻辑。事项正文必须是概括性提取，不是原文复写。

实体提取：聚焦事项核心语义，提取构建知识图谱所需的关键实体。需要覆盖主语实体、谓语/动作实体、宾语实体，以及人物、组织、地点、时间、产品、系统、模型、指标、项目、专业术语等关键对象。若标题包含关键实体，也必须从标题中提取。

## Task

1. 理解输入内容中的标题、正文和元信息。
2. 过滤噪音内容；如果正文完全无有效信息，可返回空 items。
3. 提取事项：
   - 必须把当前输入片段综合成一个顶级事项，data.items 必须且只能包含一个事项对象。
   - 即使当前片段包含多个主题、多个子话题或多个产品，也必须融合为一个完整事项，不允许拆成多个事项。
   - 事项必须有标题、摘要、精炼正文、引用片段索引。
   - 正文要覆盖当前片段的核心事实，保持独立可读，但必须压缩概括，不要复制长段原文。
   - 中文正文控制在 1-3 句、约 80-180 个汉字；英文正文控制在 1-3 sentences、约 60-120 words。
4. 提取实体：
   - 从 meta.entity_types 中选择最贴切类型，不允许自定义类型。
   - 优先使用具体类型，tags 只在其他类型不匹配时使用。
   - 并列实体必须拆开，例如“甲和乙”应提取为两个实体。
   - description 必须说明实体在当前事项中的具体作用、角色或关系。
5. 输出 JSON。

## Language Rules

- 输出语言必须保持输入正文的主要语言。
- 中文正文：title、summary、content、category、keywords、entities.description、meta.reason 都使用中文。
- 英文正文：保持英文输出。
- 不要把中文文档提取成英文；不要把英文文档翻译成中文。
- 专有名词、产品名、模型名、缩写可保留原文。

## Input

输入为 JSON：
- type: "request"
- data.items: 内容片段数组，每个包含 id 和 content，id 为 1-based 引用编号。
- data.meta.source_type: "article"
- data.meta.source_title: 文档标题
- data.meta.source_summary: 文档摘要，可为空
- data.meta.previous_context: 前文上下文，可为空
- data.meta.entity_types: 可用实体类型数组

## Output

只返回 JSON，不要 Markdown 代码块，不要解释文字。

输出格式：
{
  "type": "response",
  "data": {
    "items": [
      {
        "title": "事项标题",
        "summary": "一句话摘要",
        "content": "独立可读、精炼概括且忠于原文事实的事项内容",
        "category": "事项分类",
        "keywords": ["5-10个核心关键词"],
        "priority": "HIGH|MEDIUM|LOW|UNKNOWN",
        "status": "COMPLETED|PROCESSING|PENDING|UNKNOWN",
        "references": [1],
        "entities": [
          { "type": "entity_types中的类型", "name": "实体名称", "description": "实体在事项中的作用" }
        ],
        "is_valid": true,
        "children": []
      }
    ],
    "meta": {
      "reason": "简要说明提取和过滤依据",
      "confidence": 0.9
    }
  }
}

## Rules

- data.items 必须且只能包含一个事项对象；除非正文完全无有效信息，否则不要返回空 items。
- 不允许返回多个顶级事项；不允许把不同主题拆成多个事项。
- children 必须为空数组；所有核心信息、关键词和实体都合并到唯一事项中。
- 唯一事项必须忠于原文，不添加、不臆测，但必须概括表达，不要把 chunk 原文整段搬进 content。
- references 必须使用输入 items 的 1-based id，且覆盖事项对应的所有片段。
- keywords 必须包含专有名词、缩写、人名、组织、产品、系统、技术或关键数据。
- 对于中文正文，避免输出英文 category 或英文 description。
- 如果实体名称有全称、简称、别称，原文中出现的表达都可以提取。
- 字符串里的英文双引号必须转义，保证 JSON 可解析。
`.trim();
}

function localExtractEvent(input: {
  title: string;
  heading?: string;
  content: string;
  references: string[];
}): ExtractedEvent {
  const zh = isMostlyChinese(input.content);
  const title = cleanTitle(input.heading || firstSentence(input.content) || input.title);
  const keywords = localKeywords(`${title} ${input.content}`);
  const entities = localNamedEntities(`${title} ${input.content}`).slice(0, 12).map((name) => ({
    type: inferEntityType(name),
    name,
    description: zh ? `在事项「${title}」中被提及` : `Mentioned in event: ${title}`
  }));
  return {
    title,
    summary: conciseText(firstSentence(input.content) || title, zh),
    content: conciseText(input.content, zh),
    category: zh ? "一般事项" : "general",
    keywords,
    priority: "UNKNOWN",
    status: "COMPLETED",
    references: input.references,
    entities
  };
}

function localNamedEntities(text: string): string[] {
  const candidates = new Set<string>();
  const titleCaseMatches = text.match(/\b[A-Z][A-Za-z0-9]+(?:[-\s][A-Z][A-Za-z0-9]+){0,4}\b/g) ?? [];
  for (const match of titleCaseMatches) {
    candidates.add(match.trim());
  }
  const quotedMatches = text.match(/["'“”]([^"'“”]{2,80})["'“”]/g) ?? [];
  for (const match of quotedMatches) {
    candidates.add(match.replace(/["'“”]/g, "").trim());
  }
  const cjkMatches = text.match(/[\u4e00-\u9fa5A-Za-z0-9_-]{2,24}(?:公司|集团|大学|模型|系统|产品|项目|技术|平台|算法|数据库|方案)/g) ?? [];
  for (const match of cjkMatches) {
    candidates.add(match.trim());
  }
  return [...candidates].filter((item) => item.length > 1).slice(0, 20);
}

function localKeywords(text: string): string[] {
  if (isMostlyChinese(text)) {
    const cjkTerms = text.match(/[\u4e00-\u9fa5A-Za-z0-9_-]{2,18}/g) ?? [];
    return [...new Set(cjkTerms)].slice(0, 10);
  }
  const tokens = text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s_-]/gu, " ")
    .split(/\s+/)
    .filter((token) => token.length > 2 && !["the", "and", "for", "with", "from", "that"].includes(token));
  return [...new Set(tokens)].slice(0, 10);
}

function localRerank(query: string, candidates: EventRecord[], topK: number): string[] {
  const queryTokens = new Set(localKeywords(query));
  return [...candidates]
    .sort((a, b) => {
      const overlapA = overlapScore(queryTokens, `${a.title} ${a.content}`);
      const overlapB = overlapScore(queryTokens, `${b.title} ${b.content}`);
      return (overlapB + (b.score ?? 0)) - (overlapA + (a.score ?? 0));
    })
    .slice(0, topK)
    .map((candidate) => candidate.id);
}

function overlapScore(queryTokens: Set<string>, text: string): number {
  const tokens = new Set(localKeywords(text));
  let score = 0;
  for (const token of queryTokens) {
    if (tokens.has(token)) {
      score += 1;
    }
  }
  return score;
}

function firstSentence(text: string): string {
  return text.trim().split(/(?<=[.!?。！？])\s+/u)[0]?.slice(0, 120) ?? "";
}

function cleanTitle(text: string): string {
  return text.replace(/^#+\s*/, "").trim().slice(0, 160) || "Untitled event";
}

function isMostlyChinese(text: string): boolean {
  const cjkChars = text.match(/[\u4e00-\u9fa5]/g)?.length ?? 0;
  const latinWords = text.match(/[A-Za-z]{2,}/g)?.length ?? 0;
  return cjkChars > latinWords * 2;
}

function isLikelyLanguageDrift(text: string, inputIsChinese: boolean): boolean {
  const cjkChars = text.match(/[\u4e00-\u9fa5]/g)?.length ?? 0;
  const latinWords = text.match(/[A-Za-z]{2,}/g)?.length ?? 0;
  if (inputIsChinese) {
    return cjkChars === 0 && latinWords >= 4;
  }
  return cjkChars >= 8 && latinWords <= 2;
}

function inferEntityType(name: string): string {
  if (/\d/.test(name)) return "metric";
  if (/(Inc|Corp|LLC|Ltd|Company|Group|公司|集团|大学|组织)$/i.test(name)) return "organization";
  if (/(System|Platform|Product|系统|平台|产品|模型|数据库)$/i.test(name)) return "product";
  if (/(Search|Retrieval|检索|搜索|算法|技术|方案)$/i.test(name)) return "subject";
  return "subject";
}

function normalizeEntityType(type: string): string {
  const allowed = new Set(["time", "location", "person", "organization", "subject", "product", "metric", "action", "work", "group", "tags"]);
  return allowed.has(type) ? type : "subject";
}

export const llmClient = new OpenAICompatibleLlmClient();
