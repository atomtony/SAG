# SAG 数据库架构

## 核心表关系

```
sources（项目表）                                 ← 一个项目
  │
  └── documents（文档）                            ← 多个文档，外键 source_id → sources.id
       │
       ├── document_sections（段落）                ← 按标题划分的段落结构，后续不再查询
       │                                           与 source_chunks 一一对应
       └── source_chunks（切片）                   ← 切片 + embedding 向量，供搜索使用
            │                                      每个 section 生成一个 chunk
            │
            └── events（事项）                       ← 事项表，含 title_embedding/content_embedding
                 │                                  外键 chunk_id → source_chunks.id
                 │                                  外键 document_id → documents.id
                 │
                 └── event_entities（关联表）           外键 event_id → events.id
                                                     外键 entity_id → entities.id
                                                     实现 events ↔ entities 多对多关联
                                                     多跳搜索核心：事件→实体→其他事件

entities（实体）                                   外键 source_id → sources.id（属于项目，不属于文档）
                                                    通过 event_entities 间接关联到多个文档
entity_types（实体类型，全局预置 11 种）
conversations（对话会话）
  └── messages（对话消息）
mcp_sessions（MCP 会话）
  └── mcp_tool_calls（工具调用记录）
```

### 实体与文档的间接关系

```
实体不属于某个文档，而是属于项目（source_id）

  项目
   ├── 文档A ── 事项A1 ──┐
   │                     ├── 实体 "SAG" ← 跨文档共享
   ├── 文档B ── 事项B3 ──┘
   │
   └── 实体本身：entities.source_id → sources.id

所以搜索时匹配到实体 "SAG"，能同时召回文档A和文档B的相关事项
```

---

## 正向流程：向量生成（文档 → 向量）

```
上传文档
    │
    ▼
┌──────────────────────────────────────────────────────────┐
│  ① 切片（chunkMarkdown）                                  │
│                                                          │
│  文档 → 拆成多个 section → 每个 section 生成一个 chunk    │
└──────────────────────────────────────────────────────────┘
    │
    ▼
┌──────────────────────────────────────────────────────────┐
│  ② chunk 向量化（batchGenerate）                          │
│                                                          │
│  输入: chunk.heading + "\n" + chunk.content               │
│  输出: source_chunks.embedding vector(1024)              │
│                                                          │
│           ↓ 下一步递进：每个 chunk 交给 LLM 提取           │
└──────────────────────────────────────────────────────────┘
    │
    ▼
┌──────────────────────────────────────────────────────────┐
│  ③ LLM 提取事项 + 实体                                    │
│                                                          │
│  每个 chunk 交给 LLM，提取 1 个 event + N 个 entities    │
│                                                          │
│  请求: system(角色+规则) + user(示例输入)                 │
│        + assistant(示例输出) + user(实际chunk)            │
│                                                          │
│  角色：你是一名专业的 SAG 内容提取器                       │
│        从原始文档中提取 events 和 entities                │
│                                                          │
│  实体类型：person / organization / location / time /      │
│            product / metric / action / work /             │
│            group / subject / tags                         │
│                                                          │
│  关键规则：                                               │
│  ├─ items 只返回 1 个事件（合并所有有效片段）              │
│  ├─ 中文输入 → 中文输出                                   │
│  ├─ 不捏造事实、不遗漏核心事实                             │
│  └─ LLM 不可用 → 本地 fallback（正则提取）                │
│                                                          │
│           ↓ 对提取结果再次向量化                            │
└──────────────────────────────────────────────────────────┘
    │
    ▼
┌──────────────────────────────────────────────────────────┐
│  ④ 二次向量化（逐级递进）                                  │
│                                                          │
│  级别    输入文本                 存入字段                  │
│  ─────────────────────────────────────────────────────    │
│  L1:  chunk.heading+content  → source_chunks.embedding   │
│  L2:  event.title            → events.title_embedding    │
│  L3:  event.content          → events.content_embedding  │
│  L4:  entity.name            → entities.embedding        │
│  L5:  event.title+entity.name → event_entities.embedding │
│                                                          │
│  每一级都在上一级基础上精细化和关联化                       │
└──────────────────────────────────────────────────────────┘
    │
    ▼
┌───────────────────────────────────────────────────────────────┐
│  ⑤ 写入 DB                                                    │
│                                                               │
│  ┌─ source_chunks ──────────────────────────────────────────┐  │
│  │  id, source_id, document_id, heading, content, rank      │  │
│  │  embedding ← L1（chunk.heading + "\n" + chunk.content）   │  │
│  │  ↑ 供全文检索 + 向量检索                                   │  │
│  └──────────────────────────────────────────────────────────┘  │
│                                                               │
│  ┌─ events ─────────────────────────────────────────────────┐  │
│  │  id, chunk_id, document_id, title, summary, content      │  │
│  │  keywords, category, priority, status, references         │  │
│  │  title_embedding ← L2（event.title）                       │  │
│  │  content_embedding ← L3（event.content）                   │  │
│  │  ↑ 供事项级向量检索                                        │  │
│  └──────────────────────────────────────────────────────────┘  │
│                                                               │
│  ┌─ entities ───────────────────────────────────────────────┐  │
│  │  id, source_id, type, name, normalized_name, description │  │
│  │  embedding ← L4（entity.name）                             │  │
│  │  ↑ 供实体匹配                                              │  │
│  │  去重：on conflict (source_id, type, normalized_name)      │  │
│  │  同项目同类型同名 → 合并为同一条实体                        │  │
│  │  实体不关联 document 和 chunk（只关联 project）             │  │
│  └──────────────────────────────────────────────────────────┘  │
│                                                               │
│  ┌─ event_entities ─────────────────────────────────────────┐  │
│  │  event_id, entity_id, weight, embedding ← L5             │  │
│  │  ↑ 供多跳扩展（事件→实体→其他事件）                        │  │
│  └──────────────────────────────────────────────────────────┘  │
│                                                               │
│  ┌─ document_sections ─────────────────────────────────────┐  │
│  │  存 sections（段落结构），后续不再查询                      │  │
│  └──────────────────────────────────────────────────────────┘  │
└───────────────────────────────────────────────────────────────┘
```

**③ LLM 提取的 JSON 示例**

说明：JSON 里的 `items[]` 就是数据库的 `events`（事项），`items[].entities[]` 就是 `entities`（实体）。LLM 返回后用 `buildSingleExtractedEvent()` 转换成 `ExtractedEvent` 对象存入 `events` 表。

few-shot 示例输入：
```
{
    "type": "request",
    "data": {
        "items": [
            {
                "id": 1,
                "content": "# SAG 检索  SAG 将文档切成 chunk，抽取单个融合事项和实体..."
            }
        ],
        "meta": {
            "source_title": "SAG 说明",
            "entity_types": [
                "person",
                "subject",
                "product"
            ]
        }
    }
}
```

few-shot 示例输出：
```json
{
    "type": "response",
    "data": {
        "items": [
            {
                "title": "SAG 文档入库与多跳检索流程",
                "summary": "SAG 通过 chunk、融合事项、实体组织文档",
                "content": "SAG 将文档切分为 chunk，并从每个 chunk 中抽取融合事项和实体",
                "keywords": [
                    "SAG",
                    "chunk",
                    "融合事项",
                    "多跳检索"
                ],
                "entities": [
                    {
                        "type": "product",
                        "name": "SAG",
                        "description": "执行文档入库和多跳检索的系统"
                    },
                    {
                        "type": "subject",
                        "name": "chunk",
                        "description": "SAG 文档入库时形成的原文切片"
                    }
                ],
                "is_valid": true
            }
        ],
        "meta": {
            "reason": "识别出一个围绕 SAG 入库与检索的主题",
            "confidence": 0.9
        }
    }
}
```


---

## 反向流程：搜索查询（query → 结果）

```
用户提问："SAG 和传统 RAG 比有什么优势？"
    │
    ▼
┌──────────────────────────────────────────────────────────┐
│  ① query 向量化                                           │
│                                                          │
│  输入: 用户问题文本（整个 query 一次传入）                  │
│        "SAG 和传统 RAG 比有什么优势？"                    │
│                                                          │
│  调 Embedding API → 输出 1 个 1024 维向量                 │
│  [0.0123, -0.0456, ..., 0.0789]                          │
│                                                          │
│  不是给每个词向量化，而是整句话压缩成一个坐标点             │
│  这个点代表整句话的语义                                   │
│                                                          │
│  用途: 后续所有向量比对（余弦相似度）都基于此              │
│  ├─ 比对 source_chunks.embedding（切片向量）              │
│  ├─ 比对 events.title_embedding（事项标题向量）           │
│  └─ 比对 events.content_embedding（事项内容向量）         │
└──────────────────────────────────────────────────────────┘
    │
    ▼
┌──────────────────────────────────────────────────────────┐
│  ② BM25 实体匹配（searchEntitiesByText）                  │
│                                                          │
│  作用：把用户问题拆成词，去实体库找匹配的实体              │
│                                                          │
│  query: "SAG 和传统 RAG 比有什么优势？"                    │
│         │ PostgreSQL websearch_to_tsquery                │
│         ▼                                               │
│  拆词: ["sag", "传统", "rag", "比", "有", "什么", "优势"] │
│         │                                               │
│         ▼ 匹配 entities 表                               │
│  ┌─ 文本匹配: ent.search_text @@ tsq（全文索引）          │
│  │  命中 "sag" → 实体 "SAG" ✅                           │
│  │  命中 "rag" → 实体 "RAG" ✅                           │
│  └─ 模糊匹配: ent.normalized_name % query（trigram）      │
│     拼写容错：搜 "Transfomer" 也能找到 "Transformer"     │
│                                                          │
│  匹配字段:                                               │
│  ├─ entities.search_text（name+description 的全文索引）   │
│  └─ entities.normalized_name（小写名称，trigram 索引）    │
│                                                          │
│  输出: ["SAG", "RAG"]  ← 找到的实体名，进入下一步        │
└──────────────────────────────────────────────────────────┘
    │
    ▼
┌──────────────────────────────────────────────────────────┐
│  ③ 实体 → 事项（getEventIdsByEntityIds）                  │
│                                                          │
│  作用：用上一步找到的实体 ID，查 event_entities 表        │
│       找出引用了这些实体的所有事项                        │
│                                                          │
│  SQL: select distinct event_id                           │
│       from event_entities                                │
│       where entity_id = any([实体ID列表])                 │
│                                                          │
│  实体 "SAG"(id=A) ──→ event_entities ──→ 事项1, 事项2    │
│  实体 "RAG" (id=B) ──→ event_entities ──→ 事项2, 事项3   │
│                                                          │
│  输出: [事件ID1, 事件ID2, 事件ID3]  ← 实体关联的事项      │
└──────────────────────────────────────────────────────────┘
    │
    ▼
┌──────────────────────────────────────────────────────────┐
│  ④ 标题向量召回（searchEventsByTitleVector）               │
│                                                          │
│  作用：用 query_vector 在 events 表里按标题找相似事项      │
│       不依赖实体匹配，纯语义相似度                         │
│                                                          │
│  SQL: select e.id, 1 - (e.title_embedding <=> $1::vector) │
│       from events e                                       │
│       where e.source_id = any($2::uuid[])                 │
│         and e.deleted_at is null                          │
│       order by score desc                                 │
│       limit $3                                            │
│                                                          │
│  query_vector（用户问题语义）                               │
│       │ 余弦相似度                                         │
│       ▼                                                  │
│  events.title_embedding（事项标题向量）                     │
│  "SAG 技术简介"  →  score 0.92（匹配 ✅）                  │
│  "RAG 对比分析"  →  score 0.85（匹配 ✅）                  │
│  "数据库配置"    →  score 0.12（不匹配 ❌）                │
│                                                          │
│  和③的区别：                                              │
│  ├─ ③ 靠实体精确匹配（搜"RAG"就只找有 RAG 实体的事项）     │
│  └─ ④ 靠语义相似度（搜"对比"也能找到比较类的事项）          │
│                                                          │
│  返回: EventRecord[]（事项对象列表，非 ID 列表）            │
│  [{ id, title, summary, content, score }, ...]            │
└──────────────────────────────────────────────────────────┘
    │                                              ← ③ 结果也是 ID 列表
    ├── ③ + ④ 合并 ────────────────────────────────────────┐
    │                                                       │
    │  seedEventIds = unique([                    ← ID 列表  │
    │    ...entityEventIds,     ← ③ 实体关联的事项 ID       │
    │    ...queryEvents.map(id) ← ④ 标题向量召回事顶 ID    │
    │  ])                                                   │
    │                                                       │
    │  然后再根据 ID 查完整事项对象（含关联实体 ID）：         │
    │  seedEvents = getEventsWithEntityIds(seedEventIds)     │
    │  → Map<eventId, EventRecord>                           │
    │                                                       │
    │  合并去重后作为种子事项进入多跳                         │
    └───────────────────────────────────────────────────────┘
                            │
                            ▼
┌──────────────────────────────────────────────────────────┐
│  ⑤ 多跳扩展（expandEvents）                               │
│                                                          │
│  目标：从事项A出发，找到引用同一实体的其他事项            │
│                                                          │
│  本质是一个迭代过程：                                       │
│                                                          │
│    遍历事项 → 拿关联实体 → 根据实体查其他事项 → 再遍历... │
│          ↑                                    │           │
│          └────────────────────────────────────┘           │
│                                                          │
│  例子（maxHops=1，只迭代1轮）：                           │
│                                                          │
│  ┌─ 种子事件A "SAG 技术简介" ────────────────────────┐   │
│  │    关联实体：SAG(id1)、HippoRAG(id2)              │   │
│  │                                                   │   │
│  │  Step 1: 从事件A拿实体 → [id1, id2]              │   │
│  │  Step 2: 过滤已看实体 → id2 是新的                │   │
│  │  Step 3: 查 event_entities 找引用 id2 的事件      │   │
│  │  Step 4: 过滤已看事件 → 事件B、C 是新的           │   │
│  │  Step 5: 事件B、C 加入候选列表                    │   │
│  │  Step 6: 没有新实体 → 停止                        │   │
│  │                                                   │   │
│  │  结果：事件A + 事件B + 事件C                      │   │
│  └───────────────────────────────────────────────────┘   │
│                                                          │
│  如果 maxHops=2，再迭代1轮：                              │
│    → 事件B关联了实体 [id2, id3]                          │
│    → 过滤掉已看过的 id2 → id3 是新的                     │
│    → 查引用 id3 的事件 → 找到事件D                       │
│    → 加入候选列表                                        │
│                                                          │
│  停止条件：没有新实体 或 没有新事件                       │
│                                                          │
│  扩展限制：                                               │
│  ├─ maxHops = 1（默认，迭代次数）                         │
│  ├─ maxEvents = 100（候选事件数上限）                     │
│  ├─ 已看过的实体和事件不再重复走                          │
│  └─ 扩展后还有粗排 + Rerank，最终只取 top-k               │
│                                                          │
│  输出: 扩展后的事件 ID 列表（string[]，非事项对象）        │
│  与种子事件 ID 合并后传给⑥粗排，由粗排查完整事项再排序    │
└──────────────────────────────────────────────────────────┘
    │
    ▼
┌──────────────────────────────────────────────────────────┐
│  ⑥ 粗排（向量相似度排序）                                  │
│                                                          │
│  输入：种子事件ID + 扩展事件ID（⑤的结果）                 │
│                                                          │
│  作用：在所有候选事项里，按内容相关性排序，砍掉不相关的    │
│                                                          │
│  流程：                                                   │
│    ① 收集所有候选事件 ID（种子 + 扩展）                   │
│    ② 查 events 表，拿这些事项的 content_embedding         │
│    ③ query_vector 比对 content_embedding（余弦相似度）    │
│    ④ 按 score 降序排列，取 maxEvents 条                   │
│                                                          │
│  SQL: select e.id, 1 - (e.content_embedding <=> $1::vector)│
│       from events e                                       │
│       where e.id = any($2::uuid[])                        │
│       order by score desc                                 │
│       limit $3                                            │
│                                                          │
│  query_vector（用户问题）                                  │
│       │                                                  │
│       ├─ "SAG 技术简介"    content_emb → 0.91 ✅          │
│       ├─ "RAG 对比分析"    content_emb → 0.82 ✅          │
│       ├─ "基准测试结果"    content_emb → 0.75 ✅          │
│       └─ "数据库安装配置"  content_emb → 0.08 ❌ 被过滤   │
│                                                          │
│  和④标题向量召回的异同：                                  │
│  ├─ ④ 比对 title_embedding（标题），召回头部事项          │
│  └─ ⑥ 比对 content_embedding（内容），对已有事项排序      │
│                                                          │
│  输出: 粗排后的事项对象列表（含 score）                    │
└──────────────────────────────────────────────────────────┘
    │
    ▼
┌──────────────────────────────────────────────────────────┐
│  ⑦ Rerank 模型重排                                       │
│                                                          │
│  输入：粗排后的候选事项列表（EventRecord[]）               │
│                                                          │
│  和⑥的区别：                                              │
│  ├─ ⑥ 向量粗排：query → 向量 → 比对 content_embedding    │
│  │  （双编码器 bi-encoder，分开算向量再比距离）            │
│  └─ ⑦ Rerank 精排：query + 候选文本一起送入模型判断       │
│     （交叉编码器 cross-encoder，同时看到 query 和候选）    │
│                                                          │
│  请求（调用专门的 rerank API，不是 chat 接口）：            │
│  POST {llmBaseUrl}/reranks                                │
│  {                                                        │
│    "model": "qwen3-rerank",                               │
│    "query": "SAG 和传统 RAG 比有什么优势？",               │
│    "documents": [                                         │
│      "标题：SAG 技术简介\n摘要：...\n内容：...",          │
│      "标题：RAG 对比分析\n摘要：...\n内容：..."           │
│    ],                                                     │
│    "top_n": 5                                             │
│  }                                                        │
│                                                          │
│  响应：                                                   │
│  {                                                        │
│    "results": [                                           │
│      {"index": 1, "relevance_score": 0.95},               │
│      {"index": 0, "relevance_score": 0.87}                │
│    ]                                                      │
│  }                                                        │
│                                                          │
│  对比精度：                                                │
│  ├─ ⑥ 向量粗排："苹果"和"香蕉"的向量距离 0.3（水果类近）  │
│  └─ ⑦ Rerank：模型看到"苹果好吃"和"用户问水果推荐"→ 更准  │
│                                                          │
│  本地 fallback（无 rerank 模型时）：                       │
│  ── query 和候选文本的关键词重叠度打分                     │
│                                                          │
│  输出: 精排后的事件 ID 列表（string[]）                    │
└──────────────────────────────────────────────────────────┘
    │
    ▼
┌──────────────────────────────────────────────────────────┐
│  ⑧ 回取切片原文（sectionsForSelectedEvents）              │
│                                                          │
│  说明：匹配和排序用的是事项（语义提炼），                   │
│       但最终展示给用户的是原文切片（chunk）               │
│                                                          │
│  精排事件 → event.chunk_id → source_chunks               │
│               ↓                                           │
│         读取 chunk 原文（ heading + content ）             │
│                                                          │
│  输出: top-k 切片结果（含原文 + score）                    │
└──────────────────────────────────────────────────────────┘
```

[]([]())