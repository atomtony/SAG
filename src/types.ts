export type SearchStrategy = "vector" | "multi";
export type SearchMode = "standard" | "fast";
export type MultiSubStrategy = "multi" | "multi1" | "hopllm";

export interface SearchInput {
  query: string;
  sourceIds: string[];
  strategy?: SearchStrategy;
  searchMode?: SearchMode;
  subStrategy?: MultiSubStrategy;
  topK?: number;
  returnTrace?: boolean;
  multi?: {
    entityTopK?: number;
    multiTopK?: number;
    keySimilarityThreshold?: number;
    similarityThreshold?: number;
    maxHops?: number;
    maxEvents?: number;
    maxEventsA?: number;
    maxEventsB?: number;
    maxHopRetries?: number;
    rerankTopK?: number;
    maxSections?: number;
  };
}

export interface SearchSection {
  chunkId: string;
  sourceId: string;
  documentId?: string;
  heading?: string;
  content: string;
  rank: number;
  score: number;
}

export interface SearchTrace {
  traceId: string;
  query: string;
  searchMode: SearchMode;
  queryEntities: string[];
  recalledEntities: Array<{ id: string; name: string; type: string; score: number }>;
  entityEventIds: string[];
  entityEvents?: SearchTraceEvent[];
  queryEventIds: string[];
  queryEvents?: SearchTraceEvent[];
  expandedEventIds: string[];
  expandedEvents?: SearchTraceEvent[];
  coarseRankedEventIds: string[];
  coarseRankedEvents?: SearchTraceEvent[];
  rerankedEventIds: string[];
  rerankedEvents?: SearchTraceEvent[];
  eventSnapshots?: SearchTraceEvent[];
  fallbackReason?: string;
  timings: Record<string, number>;
}

export interface SearchTraceEvent {
  id: string;
  title: string;
  summary: string;
  contentPreview: string;
  score?: number;
}

export interface SearchProgressEvent {
  type: "step";
  status: "running" | "done" | "failed";
  key: string;
  title: string;
  detail: string;
  payload?: unknown;
  durationMs?: number;
}

export interface SearchResult {
  sections: SearchSection[];
  traceId: string;
  trace?: SearchTrace;
}

export interface ProjectStatsRecord {
  documentCount: number;
  chunkCount: number;
  eventCount: number;
  entityCount: number;
}

export interface ProjectGraphEntityRecord {
  id: string;
  sourceId: string;
  type: string;
  name: string;
  normalizedName: string;
  eventCount: number;
}

export interface ProjectGraphEventRecord {
  id: string;
  sourceId: string;
  documentId?: string | null;
  title: string;
  rank: number;
  entityIds: string[];
}

export interface ProjectGraphRecord {
  entities: ProjectGraphEntityRecord[];
  events: ProjectGraphEventRecord[];
  edges: Array<{
    entityId: string;
    eventId: string;
  }>;
}

export interface IngestDocumentInput {
  sourceId?: string;
  title: string;
  content: string;
  metadata?: Record<string, unknown>;
  extract?: boolean;
  waitForCompletion?: boolean;
}

export interface IngestDocumentResult {
  sourceId: string;
  documentId: string;
  chunkCount: number;
  eventCount: number;
  taskId: string;
  traceId: string;
}

export type IngestProgressStage =
  | "QUEUED"
  | "READING"
  | "PARSING"
  | "CHUNKING"
  | "EMBEDDING_CHUNKS"
  | "EXTRACTING_EVENTS"
  | "EMBEDDING_EVENTS"
  | "WRITING_GRAPH"
  | "COMPLETED"
  | "FAILED";

export interface IngestProgressUpdate {
  stage: IngestProgressStage;
  message: string;
  progress: number;
  chunkCount?: number;
  eventCount?: number;
  currentChunk?: number;
  totalChunks?: number;
}

export interface ExtractedEvent {
  title: string;
  summary: string;
  content: string;
  category?: string;
  keywords: string[];
  priority?: string;
  status?: string;
  references: string[];
  entities: ExtractedEntity[];
}

export interface ExtractedEntity {
  type: string;
  name: string;
  description: string;
}

export interface SourceRecord {
  id: string;
  tenantId: string;
  name: string;
  description?: string | null;
  metadata: Record<string, unknown>;
  archivedAt?: string | null;
  createdAt?: string;
  updatedAt?: string;
}

export interface EmbeddingPreview {
  dimensions: number;
  sample: number[];
}

export interface EventRecord {
  id: string;
  sourceId: string;
  documentId?: string | null;
  chunkId?: string | null;
  title: string;
  summary: string;
  content: string;
  rank: number;
  score?: number;
  entities?: EntityRecord[];
  entityCount?: number;
  titleEmbedding?: EmbeddingPreview | null;
  contentEmbedding?: EmbeddingPreview | null;
}

export interface EntityRecord {
  id: string;
  sourceId: string;
  type: string;
  name: string;
  normalizedName: string;
  score?: number;
  embedding?: EmbeddingPreview | null;
}

export interface DocumentRecord {
  id: string;
  sourceId: string;
  title: string;
  status: string;
  parseStatus: string;
  metadata: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
  archivedAt?: string | null;
}

export interface ChunkRecord {
  id: string;
  sourceId: string;
  documentId?: string | null;
  heading?: string | null;
  content: string;
  rawContent?: string | null;
  rank: number;
  references: string[];
  metadata: Record<string, unknown>;
  createdAt: string;
  embedding?: EmbeddingPreview | null;
}

export interface EntityWithEventsRecord extends EntityRecord {
  description?: string | null;
  eventCount: number;
}

export interface EventDetailRecord {
  event: EventRecord;
  entities: EntityRecord[];
  document?: DocumentRecord | null;
  source?: SourceRecord | null;
  chunk?: {
    chunkId: string;
    sourceId?: string;
    documentId?: string | null;
    heading?: string;
    content: string;
    rank?: number;
  };
}

export interface EntityDetailRecord {
  entity: EntityWithEventsRecord;
  events: EventRecord[];
  source?: SourceRecord | null;
}

export interface McpSessionRecord {
  id: string;
  tenantId: string;
  title: string;
  status: string;
  model?: string | null;
  sourceIds: string[];
  metadata: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

export type McpMessageRole = "user" | "assistant" | "tool" | "system";

export interface McpMessageRecord {
  id: string;
  sessionId: string;
  role: McpMessageRole;
  content: string;
  metadata: Record<string, unknown>;
  createdAt: string;
}

export interface McpToolCallRecord {
  id: string;
  sessionId: string;
  messageId?: string | null;
  toolName: string;
  arguments: Record<string, unknown>;
  result?: unknown;
  status: "PENDING" | "SUCCEEDED" | "FAILED";
  durationMs?: number | null;
  error?: string | null;
  createdAt: string;
}

export interface AiProviderSettingsRecord {
  id: "global";
  embeddingBaseUrl: string;
  embeddingModel: string;
  embeddingDimensions: number;
  embeddingApiKey?: string | null;
  llmBaseUrl: string;
  llmModel: string;
  llmApiKey?: string | null;
  llmTimeoutMs: number;
  llmMaxRetries: number;
  metadata: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

export interface PublicAiProviderSettings {
  id: "global";
  embeddingBaseUrl: string;
  embeddingModel: string;
  embeddingDimensions: number;
  hasEmbeddingApiKey: boolean;
  llmBaseUrl: string;
  llmModel: string;
  hasLlmApiKey: boolean;
  llmTimeoutMs: number;
  llmMaxRetries: number;
  defaultSearchMode: SearchMode;
  updatedAt: string;
}
