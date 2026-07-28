import { buildApp } from "./app.js";
import { env } from "./config/env.js";
import { installGracefulShutdown } from "./gracefulShutdown.js";

const app = await buildApp();
installGracefulShutdown(app);

try {
  await app.listen({
    host: env.HOST,
    port: env.PORT,
  });
} catch (error) {
  app.log.error({ err: error }, "Server startup failed");
  process.exitCode = 1;
}
