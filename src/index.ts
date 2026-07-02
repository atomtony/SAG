import { migrate } from "./db/migrate.js";
import { seed } from "./db/seed.js";
import { startHttpServer } from "./api/server.js";
import { logger } from "./observability/logger.js";

async function main() {
  await migrate();
  await seed();
  await startHttpServer();
}

main().catch((error: unknown) => {
  logger.error({ error }, "server failed");
  process.exit(1);
});

