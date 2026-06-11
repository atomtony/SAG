import { startHttpServer } from "./api/server.js";
import { logger } from "./observability/logger.js";

startHttpServer().catch((error: unknown) => {
  logger.error({ error }, "server failed");
  process.exit(1);
});

