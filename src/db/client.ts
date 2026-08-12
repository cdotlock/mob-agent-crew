import postgres from "postgres";

export type DatabaseClient = postgres.Sql;

export interface DatabaseOptions {
  max?: number;
  applicationName?: string;
  idleTimeoutSeconds?: number;
  connectTimeoutSeconds?: number;
}

export function createDatabaseClient(url: string, options: DatabaseOptions = {}): DatabaseClient {
  return postgres(url, {
    max: options.max ?? 10,
    idle_timeout: options.idleTimeoutSeconds ?? 20,
    connect_timeout: options.connectTimeoutSeconds ?? 10,
    connection: {
      application_name: options.applicationName ?? "mob-agent-crew",
    },
  });
}
