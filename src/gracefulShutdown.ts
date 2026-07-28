import type { FastifyInstance } from "fastify";

type ShutdownSignal = "SIGINT" | "SIGTERM";

export function createGracefulShutdown(
  app: FastifyInstance,
): (signal: ShutdownSignal) => Promise<void> {
  let shutdownPromise: Promise<void> | undefined;

  return (signal) => {
    shutdownPromise ??= (async () => {
      app.log.info({ signal }, "Graceful shutdown started");
      try {
        await app.close();
        app.log.info({ signal }, "Graceful shutdown completed");
      } catch (error) {
        process.exitCode = 1;
        app.log.error(
          { err: error, signal },
          "Graceful shutdown failed",
        );
      }
    })();
    return shutdownPromise;
  };
}

export function installGracefulShutdown(
  app: FastifyInstance,
): () => void {
  const shutdown = createGracefulShutdown(app);
  const onSigint = (): void => {
    void shutdown("SIGINT");
  };
  const onSigterm = (): void => {
    void shutdown("SIGTERM");
  };

  process.once("SIGINT", onSigint);
  process.once("SIGTERM", onSigterm);

  return () => {
    process.removeListener("SIGINT", onSigint);
    process.removeListener("SIGTERM", onSigterm);
  };
}
