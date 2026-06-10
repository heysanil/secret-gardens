/**
 * safe API server — boot entrypoint.
 * config → sqlite → better-auth migrations → our migrations → KEK boot-check
 * → redis → listen.
 */
import { createApp } from "./app";
import { createAuth, runAuthMigrations } from "./auth";
import { loadConfig } from "./config";
import { openDb, runMigrations } from "./db";
import { createAuditLog } from "./redis/audit";
import { createRedis } from "./redis/client";
import { ensureKekCheck } from "./services/kekCheck";

export type { App } from "./app";

async function main(): Promise<void> {
  const config = loadConfig(process.env);

  const db = openDb(config.dbPath);
  const redis = createRedis(config.redisUrl);
  const audit = createAuditLog(redis, { maxLen: config.auditMaxLen });

  const auth = createAuth({ db, config, audit });
  await runAuthMigrations(auth); // better-auth schema first…
  runMigrations(db); // …then ours.
  ensureKekCheck(db, config.masterKey);

  await redis.connect();

  const app = createApp({ db, redis, config, auth, audit });
  app.listen(config.port);
  console.log(
    `safe api listening on port ${config.port} ` +
      `(public URL ${config.publicUrl}, kek ${config.masterKey.kekId})`,
  );

  let shuttingDown = false;
  const shutdown = (signal: string) => {
    if (shuttingDown) {
      return;
    }
    shuttingDown = true;
    console.log(`received ${signal}, shutting down`);
    void Promise.resolve(app.stop())
      .catch((err: unknown) => {
        console.error("error while stopping http server:", err);
      })
      .finally(() => {
        redis.close();
        db.close();
        process.exit(0);
      });
  };
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
}

main().catch((err: unknown) => {
  const message = err instanceof Error ? err.message : String(err);
  console.error(`safe api failed to start: ${message}`);
  process.exit(1);
});
