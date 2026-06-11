import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { ingestionService } from "../services/ingestion-service.js";
import { searchService } from "../services/search-service.js";
import { graphService } from "../services/graph-service.js";
import { logger } from "../observability/logger.js";
import { subscribeModelCallLogs, type ModelCallLogRecord } from "../observability/model-call-log.js";
import type { SearchProgressEvent } from "../types.js";

export function buildMcpServer(): McpServer {
  const server = new McpServer({
    name: "sag",
    version: "0.1.0"
  });

  server.tool(
    "sag_ingest_document",
    {
      title: z.string().min(1),
      content: z.string().min(1),
      metadata: z.record(z.unknown()).optional(),
      extract: z.boolean().optional(),
      waitForCompletion: z.boolean().optional()
    },
    async (input, extra) => {
      const notificationEmitter = createMcpNotificationEmitter(extra);
      const unsubscribe = notificationEmitter ? pipeMcpModelCallLogs(notificationEmitter) : () => undefined;
      try {
        const result = await ingestionService.ingestDocument({
          ...input,
          sourceId: readConfiguredSourceId()
        });
        return jsonContent(result);
      } finally {
        unsubscribe();
      }
    }
  );

  server.tool(
    "sag_search",
    {
      query: z.string().min(1),
      strategy: z.enum(["vector", "multi"]).optional(),
      searchMode: z.enum(["standard", "fast"]).optional(),
      subStrategy: z.enum(["multi", "multi1", "hopllm"]).optional(),
      topK: z.number().int().positive().max(50).optional(),
      returnTrace: z.boolean().optional()
    },
    async (input, extra) => {
      const notificationEmitter = createMcpNotificationEmitter(extra);
      const unsubscribe = notificationEmitter ? pipeMcpModelCallLogs(notificationEmitter) : () => undefined;
      try {
        const result = await searchService.search(
          { ...input, sourceIds: [readConfiguredSourceId()], strategy: input.strategy ?? "multi", returnTrace: true },
          undefined,
          notificationEmitter ? createMcpProgressEmitter(notificationEmitter) : undefined
        );
        return jsonContent(result);
      } finally {
        unsubscribe();
      }
    }
  );

  server.tool(
    "sag_explain_search",
    {
      query: z.string().min(1),
      searchMode: z.enum(["standard", "fast"]).optional(),
      subStrategy: z.enum(["multi", "multi1", "hopllm"]).optional(),
      topK: z.number().int().positive().max(50).optional()
    },
    async (input, extra) => {
      const notificationEmitter = createMcpNotificationEmitter(extra);
      const unsubscribe = notificationEmitter ? pipeMcpModelCallLogs(notificationEmitter) : () => undefined;
      try {
        const result = await searchService.search(
          { ...input, sourceIds: [readConfiguredSourceId()], strategy: "multi", returnTrace: true },
          undefined,
          notificationEmitter ? createMcpProgressEmitter(notificationEmitter) : undefined
        );
        return jsonContent(result.trace ?? result);
      } finally {
        unsubscribe();
      }
    }
  );

  server.tool(
    "sag_get_event",
    {
      eventId: z.string().uuid()
    },
    async (input) => {
      const result = await graphService.getEvent(input.eventId);
      return jsonContent(result ?? { error: { code: "EVENT_NOT_FOUND", message: "Event not found" } });
    }
  );

  return server;
}

function readConfiguredSourceId(): string {
  const sourceId = process.env.SAG_MCP_SOURCE_ID?.trim() || process.env.SAG_MCP_PROJECT_ID?.trim();
  const parsed = z.string().uuid().safeParse(sourceId);
  if (!parsed.success) {
    throw new Error("MCP server must be started with SAG_MCP_SOURCE_ID set to the current project id.");
  }
  return parsed.data;
}

function jsonContent(value: unknown) {
  return {
    content: [
      {
        type: "text" as const,
        text: JSON.stringify(value, null, 2)
      }
    ]
  };
}

type McpToolExtra = {
  _meta?: { progressToken?: string | number };
  sendNotification?: (notification: {
    method: "notifications/progress";
    params: {
      progressToken: string | number;
      progress: number;
      total?: number;
      message?: string;
    };
  }) => Promise<void>;
};

type McpNotificationEmitter = (message: unknown) => void;

function createMcpNotificationEmitter(extra: McpToolExtra): McpNotificationEmitter | undefined {
  const progressToken = extra._meta?.progressToken;
  if (progressToken === undefined || typeof extra.sendNotification !== "function") {
    return undefined;
  }

  let progress = 0;
  return (message: unknown) => {
    progress += 1;
    void extra.sendNotification?.({
      method: "notifications/progress",
      params: {
        progressToken,
        progress,
        message: JSON.stringify(message)
      }
    }).catch((error: unknown) => {
      logger.warn({ error }, "failed to send MCP progress notification");
    });
  };
}

function createMcpProgressEmitter(emit: McpNotificationEmitter) {
  return (event: SearchProgressEvent) => {
    emit({
      kind: "sag_search_progress",
      event
    });
  };
}

function pipeMcpModelCallLogs(emit?: McpNotificationEmitter): () => void {
  if (!emit) {
    return () => undefined;
  }
  return subscribeModelCallLogs((log: ModelCallLogRecord) => {
    emit({
      kind: "sag_model_call_log",
      log
    });
  });
}

export async function startMcpServer(): Promise<void> {
  const server = buildMcpServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
  logger.info("SAG MCP stdio server started");
}

if (import.meta.url === `file://${process.argv[1]}`) {
  startMcpServer().catch((error: unknown) => {
    logger.error({ error }, "mcp server failed");
    process.exit(1);
  });
}
