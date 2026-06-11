import fs from "node:fs";
import path from "node:path";
import Fastify from "fastify";
import fastifyStatic from "@fastify/static";
import { z } from "zod";
import { config, SUPPORTED_EMBEDDING_DIMENSIONS } from "../config/env.js";
import { ingestionService } from "../services/ingestion-service.js";
import { searchService } from "../services/search-service.js";
import { graphService } from "../services/graph-service.js";
import { logger } from "../observability/logger.js";
import { webuiService } from "../services/webui-service.js";
import { mcpAgentService } from "../services/mcp-agent-service.js";
import { aiSettingsService } from "../services/ai-settings-service.js";
import { getPublicMcpSettings } from "../services/mcp-settings-service.js";
import { listModelCallLogs } from "../observability/model-call-log.js";

const rootDir = process.cwd();
const webDistDir = path.join(rootDir, "web", "dist");
const webIndexFile = path.join(webDistDir, "index.html");

const ingestSchema = z.object({
  sourceId: z.string().uuid().optional(),
  title: z.string().min(1),
  content: z.string().min(1),
  metadata: z.record(z.unknown()).optional(),
  extract: z.boolean().optional(),
  waitForCompletion: z.boolean().optional()
});

const searchSchema = z.object({
  query: z.string().min(1),
  sourceIds: z.array(z.string().uuid()).min(1),
  strategy: z.enum(["vector", "multi"]).optional(),
  searchMode: z.enum(["standard", "fast"]).optional(),
  subStrategy: z.enum(["multi", "multi1", "hopllm"]).optional(),
  topK: z.number().int().positive().max(50).optional(),
  returnTrace: z.boolean().optional(),
  multi: z.object({
    entityTopK: z.number().int().positive().optional(),
    multiTopK: z.number().int().positive().optional(),
    keySimilarityThreshold: z.number().min(0).max(1).optional(),
    similarityThreshold: z.number().min(0).max(1).optional(),
    maxHops: z.number().int().min(0).max(10).optional(),
    maxEvents: z.number().int().positive().optional(),
    maxEventsA: z.number().int().positive().optional(),
    maxEventsB: z.number().int().min(0).optional(),
    maxHopRetries: z.number().int().positive().max(10).optional(),
    rerankTopK: z.number().int().positive().max(20).optional(),
    maxSections: z.number().int().positive().max(50).optional()
  }).optional()
});

const uploadSchema = z.object({
  sourceId: z.string().uuid().optional(),
  title: z.string().min(1).optional(),
  fileName: z.string().min(1),
  content: z.string(),
  extract: z.boolean().optional()
});

const projectSchema = z.object({
  name: z.string().min(1),
  description: z.string().optional().nullable()
});

const projectUpdateSchema = z.object({
  name: z.string().min(1).optional(),
  description: z.string().optional().nullable()
});

const documentUpdateSchema = z.object({
  title: z.string().min(1).optional()
});

const createMcpSessionSchema = z.object({
  title: z.string().min(1).optional(),
  sourceIds: z.array(z.string().uuid()).optional()
});

const mcpMessageSchema = z.object({
  content: z.string().min(1)
});

const aiSettingsSchema = z.object({
  embeddingBaseUrl: z.string().url(),
  embeddingModel: z.string().min(1),
  embeddingDimensions: z.literal(SUPPORTED_EMBEDDING_DIMENSIONS),
  embeddingApiKey: z.string().optional(),
  clearEmbeddingApiKey: z.boolean().optional(),
  llmBaseUrl: z.string().url(),
  llmModel: z.string().min(1),
  llmApiKey: z.string().optional(),
  clearLlmApiKey: z.boolean().optional(),
  llmTimeoutMs: z.number().int().positive(),
  llmMaxRetries: z.number().int().min(0).max(10),
  defaultSearchMode: z.enum(["standard", "fast"]).default("fast")
});

export function buildHttpServer() {
  const app = Fastify({
    logger: {
      level: config.LOG_LEVEL,
      base: {
        service: "sag"
      }
    }
  });

  app.get("/health", async () => ({
    ok: true,
    service: "sag"
  }));

  app.get("/api/model-call-logs", async (request) => {
    const query = request.query as { after?: string };
    const after = query.after ? Number(query.after) : 0;
    return listModelCallLogs(Number.isFinite(after) ? after : 0);
  });

  app.get("/sources", async (request) => {
    const query = request.query as { limit?: string; cursor?: string };
    return {
      sources: await graphService.listSources({
        limit: query.limit ? Number(query.limit) : undefined,
        cursor: query.cursor
      })
    };
  });

  app.get("/api/sources", async (request) => {
    const query = request.query as { limit?: string; cursor?: string };
    return {
      sources: await webuiService.listSources({
        limit: query.limit ? Number(query.limit) : undefined,
        cursor: query.cursor
      })
    };
  });

  app.get("/api/projects", async (request) => {
    const query = request.query as { limit?: string; cursor?: string; includeArchived?: string };
    return {
      projects: await webuiService.listProjects({
        limit: query.limit ? Number(query.limit) : undefined,
        cursor: query.cursor,
        includeArchived: query.includeArchived === "true"
      })
    };
  });

  app.post("/api/projects", async (request, reply) => {
    const input = projectSchema.parse(request.body);
    const project = await webuiService.createProject(input);
    return reply.code(201).send({ project });
  });

  app.patch("/api/projects/:projectId", async (request) => {
    const params = request.params as { projectId: string };
    z.string().uuid().parse(params.projectId);
    const input = projectUpdateSchema.parse(request.body);
    return {
      project: await webuiService.updateProject(params.projectId, input)
    };
  });

  app.post("/api/projects/:projectId/archive", async (request) => {
    const params = request.params as { projectId: string };
    z.string().uuid().parse(params.projectId);
    return {
      project: await webuiService.archiveProject(params.projectId)
    };
  });

  app.post("/api/projects/:projectId/restore", async (request) => {
    const params = request.params as { projectId: string };
    z.string().uuid().parse(params.projectId);
    return {
      project: await webuiService.restoreProject(params.projectId)
    };
  });

  app.delete("/api/projects/:projectId", async (request, reply) => {
    const params = request.params as { projectId: string };
    const query = request.query as { permanent?: string };
    z.string().uuid().parse(params.projectId);
    if (query.permanent !== "true") {
      return reply.code(400).send({
        error: {
          code: "PERMANENT_CONFIRMATION_REQUIRED",
          message: "永久删除项目必须显式传入 permanent=true"
        }
      });
    }
    return webuiService.deleteProject(params.projectId);
  });

  app.get("/api/sources/:sourceId/documents", async (request) => {
    const params = request.params as { sourceId: string };
    const query = request.query as { includeArchived?: string };
    z.string().uuid().parse(params.sourceId);
    return {
      documents: await webuiService.listDocuments(params.sourceId, {
        includeArchived: query.includeArchived === "true"
      })
    };
  });

  app.get("/api/projects/:projectId/documents", async (request) => {
    const params = request.params as { projectId: string };
    const query = request.query as { includeArchived?: string };
    z.string().uuid().parse(params.projectId);
    return {
      documents: await webuiService.listDocuments(params.projectId, {
        includeArchived: query.includeArchived === "true"
      })
    };
  });

  app.get("/api/projects/:projectId/stats", async (request) => {
    const params = request.params as { projectId: string };
    z.string().uuid().parse(params.projectId);
    return {
      stats: await webuiService.getProjectStats(params.projectId)
    };
  });

  app.get("/api/projects/:projectId/graph", async (request) => {
    const params = request.params as { projectId: string };
    z.string().uuid().parse(params.projectId);
    return {
      graph: await webuiService.getProjectGraph(params.projectId)
    };
  });

  app.post("/api/documents/upload", async (request, reply) => {
    const input = uploadSchema.parse(request.body);
    const result = await webuiService.uploadDocument(input);
    return reply.code(201).send(result);
  });

  app.post("/api/documents/upload/jobs", async (request, reply) => {
    const input = uploadSchema.parse(request.body);
    const job = await webuiService.createUploadJob(input);
    return reply.code(202).send({ job });
  });

  app.get("/api/documents/upload/jobs/:jobId", async (request, reply) => {
    const params = request.params as { jobId: string };
    z.string().uuid().parse(params.jobId);
    const job = webuiService.getUploadJob(params.jobId);
    if (!job) {
      return reply.code(404).send(notFound("UPLOAD_JOB_NOT_FOUND", "上传任务不存在"));
    }
    return { job };
  });

  app.get("/api/documents/:documentId", async (request, reply) => {
    const params = request.params as { documentId: string };
    z.string().uuid().parse(params.documentId);
    const document = await webuiService.getDocument(params.documentId);
    if (!document) {
      return reply.code(404).send(notFound("DOCUMENT_NOT_FOUND", "文档不存在"));
    }
    return { document };
  });

  app.patch("/api/documents/:documentId", async (request) => {
    const params = request.params as { documentId: string };
    z.string().uuid().parse(params.documentId);
    const input = documentUpdateSchema.parse(request.body);
    return {
      document: await webuiService.updateDocument(params.documentId, input)
    };
  });

  app.post("/api/documents/:documentId/archive", async (request) => {
    const params = request.params as { documentId: string };
    z.string().uuid().parse(params.documentId);
    return {
      document: await webuiService.archiveDocument(params.documentId)
    };
  });

  app.post("/api/documents/:documentId/restore", async (request) => {
    const params = request.params as { documentId: string };
    z.string().uuid().parse(params.documentId);
    return {
      document: await webuiService.restoreDocument(params.documentId)
    };
  });

  app.delete("/api/documents/:documentId", async (request, reply) => {
    const params = request.params as { documentId: string };
    const query = request.query as { permanent?: string };
    z.string().uuid().parse(params.documentId);
    if (query.permanent !== "true") {
      return reply.code(400).send({
        error: {
          code: "PERMANENT_CONFIRMATION_REQUIRED",
          message: "永久删除文档必须显式传入 permanent=true"
        }
      });
    }
    return webuiService.deleteDocument(params.documentId);
  });

  app.get("/api/documents/:documentId/chunks", async (request) => {
    const params = request.params as { documentId: string };
    z.string().uuid().parse(params.documentId);
    return {
      chunks: await webuiService.listChunks(params.documentId)
    };
  });

  app.get("/api/documents/:documentId/events", async (request) => {
    const params = request.params as { documentId: string };
    z.string().uuid().parse(params.documentId);
    return {
      events: await webuiService.listEvents(params.documentId)
    };
  });

  app.get("/api/documents/:documentId/entities", async (request) => {
    const params = request.params as { documentId: string };
    z.string().uuid().parse(params.documentId);
    return {
      entities: await webuiService.listEntities(params.documentId)
    };
  });

  app.post("/ingest", async (request, reply) => {
    const input = ingestSchema.parse(request.body);
    const result = await ingestionService.ingestDocument(input);
    return reply.code(201).send(result);
  });

  app.post("/search", async (request) => {
    const input = searchSchema.parse(request.body);
    return searchService.search(input);
  });

  app.post("/api/search", async (request) => {
    const input = searchSchema.parse(request.body);
    return searchService.search(input);
  });

  app.post("/api/search/stream", async (request, reply) => {
    const input = searchSchema.parse(request.body);
    reply.raw.writeHead(200, {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-store, must-revalidate",
      "Connection": "keep-alive"
    });

    const send = (event: string, data: unknown) => {
      reply.raw.write(`event: ${event}\n`);
      reply.raw.write(`data: ${JSON.stringify(data)}\n\n`);
      const flush = (reply.raw as typeof reply.raw & { flush?: () => void }).flush;
      if (typeof flush === "function") {
        flush.call(reply.raw);
      }
    };

    try {
      const result = await searchService.search(input, config.DEFAULT_TENANT_ID, (event) => {
        send(event.type, event);
      });
      send("done", {
        type: "done",
        result
      });
    } catch (error) {
      send("error", {
        type: "error",
        message: getErrorMessage(error)
      });
    } finally {
      reply.raw.end();
    }
  });

  app.get("/api/settings/ai", async () => ({
    settings: await aiSettingsService.getPublicSettings()
  }));

  app.get("/api/settings/mcp", async () => ({
    settings: getPublicMcpSettings()
  }));

  app.put("/api/settings/ai", async (request) => {
    const input = aiSettingsSchema.parse(request.body);
    return {
      settings: await aiSettingsService.updateSettings(input)
    };
  });

  app.get("/events/:eventId", async (request, reply) => {
    const params = request.params as { eventId: string };
    const event = await graphService.getEvent(params.eventId);
    if (!event) {
      return reply.code(404).send({
        error: {
          code: "EVENT_NOT_FOUND",
          message: "事件不存在"
        }
      });
    }
    return event;
  });

  app.get("/api/events/:eventId", async (request, reply) => {
    const params = request.params as { eventId: string };
    z.string().uuid().parse(params.eventId);
    const event = await webuiService.getEvent(params.eventId);
    if (!event) {
      return reply.code(404).send(notFound("EVENT_NOT_FOUND", "事件不存在"));
    }
    return event;
  });

  app.get("/api/entities/:entityId", async (request, reply) => {
    const params = request.params as { entityId: string };
    z.string().uuid().parse(params.entityId);
    const entity = await webuiService.getEntity(params.entityId);
    if (!entity) {
      return reply.code(404).send(notFound("ENTITY_NOT_FOUND", "实体不存在"));
    }
    return entity;
  });

  app.post("/api/mcp/sessions", async (request, reply) => {
    const input = createMcpSessionSchema.parse(request.body);
    const session = await mcpAgentService.createSession(input);
    return reply.code(201).send({ session });
  });

  app.get("/api/mcp/sessions", async () => ({
    sessions: await mcpAgentService.listSessions()
  }));

  app.get("/api/projects/:projectId/mcp/sessions", async (request) => {
    const params = request.params as { projectId: string };
    z.string().uuid().parse(params.projectId);
    return {
      sessions: await mcpAgentService.listSessions({ sourceId: params.projectId })
    };
  });

  app.get("/api/mcp/sessions/:sessionId", async (request, reply) => {
    const params = request.params as { sessionId: string };
    z.string().uuid().parse(params.sessionId);
    const detail = await mcpAgentService.getSession(params.sessionId);
    if (!detail) {
      return reply.code(404).send(notFound("MCP_SESSION_NOT_FOUND", "MCP 会话不存在"));
    }
    return detail;
  });

  app.post("/api/mcp/sessions/:sessionId/clear", async (request, reply) => {
    const params = request.params as { sessionId: string };
    z.string().uuid().parse(params.sessionId);
    const detail = await mcpAgentService.clearSession(params.sessionId);
    if (!detail) {
      return reply.code(404).send(notFound("MCP_SESSION_NOT_FOUND", "MCP 会话不存在"));
    }
    return detail;
  });

  app.delete("/api/mcp/sessions/:sessionId", async (request) => {
    const params = request.params as { sessionId: string };
    z.string().uuid().parse(params.sessionId);
    return mcpAgentService.deleteSession(params.sessionId);
  });

  app.post("/api/mcp/sessions/:sessionId/messages", async (request, reply) => {
    const params = request.params as { sessionId: string };
    z.string().uuid().parse(params.sessionId);
    const input = mcpMessageSchema.parse(request.body);
    const result = await mcpAgentService.runUserMessage({
      sessionId: params.sessionId,
      content: input.content
    });
    return reply.code(201).send(result);
  });

  app.post("/api/mcp/sessions/:sessionId/messages/stream", async (request, reply) => {
    const params = request.params as { sessionId: string };
    z.string().uuid().parse(params.sessionId);
    const input = mcpMessageSchema.parse(request.body);
    const abortController = new AbortController();
    let completed = false;
    const abortRun = () => {
      if (!completed) {
        abortController.abort();
      }
    };
    request.raw.on("aborted", abortRun);
    reply.raw.on("close", abortRun);

    reply.raw.writeHead(200, {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-store, must-revalidate",
      "Connection": "keep-alive"
    });

    const send = (event: string, data: unknown) => {
      if (abortController.signal.aborted || reply.raw.destroyed || reply.raw.writableEnded) {
        return;
      }
      reply.raw.write(`event: ${event}\n`);
      reply.raw.write(`data: ${JSON.stringify(data)}\n\n`);
    };

    try {
      await mcpAgentService.runUserMessage({
        sessionId: params.sessionId,
        content: input.content,
        signal: abortController.signal
      }, config.DEFAULT_TENANT_ID, (event) => {
        send(event.type, event);
      });
    } catch (error) {
      if (!isAbortError(error)) {
        send("error", {
          type: "error",
          message: getErrorMessage(error)
        });
      }
    } finally {
      completed = true;
      request.raw.off("aborted", abortRun);
      reply.raw.off("close", abortRun);
      if (!reply.raw.destroyed && !reply.raw.writableEnded) {
        reply.raw.end();
      }
    }
  });

  if (fs.existsSync(webIndexFile)) {
    app.register(fastifyStatic, {
      root: webDistDir,
      prefix: "/"
    });
    app.setNotFoundHandler((request, reply) => {
      if (request.url.startsWith("/api/") || request.url === "/health") {
        return reply.code(404).send(notFound("NOT_FOUND", "接口不存在"));
      }
      return reply.type("text/html").send(fs.readFileSync(webIndexFile, "utf8"));
    });
  }

  app.setErrorHandler((error, _request, reply) => {
    const statusCode = error instanceof z.ZodError ? 400 : 500;
    const logPayload = { error, statusCode };
    if (statusCode >= 500) {
      logger.error(logPayload, "request failed");
    } else {
      logger.warn(logPayload, "request validation failed");
    }
    reply.code(statusCode).send({
      error: {
        code: statusCode === 400 ? "BAD_REQUEST" : "INTERNAL_ERROR",
        message: getErrorMessage(error)
      }
    });
  });

  return app;
}

function notFound(code: string, message: string) {
  return {
    error: {
      code,
      message
    }
  };
}

function getErrorMessage(error: unknown): string {
  if (error instanceof z.ZodError) {
    return "请求参数无效";
  }
  return error instanceof Error ? error.message : String(error);
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

export async function startHttpServer(): Promise<void> {
  const app = buildHttpServer();
  await app.listen({
    host: config.HTTP_HOST,
    port: config.HTTP_PORT
  });
}
