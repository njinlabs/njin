import { type Connection, sqlAdapter } from "./sql/adapter";
import { bunSqlClient } from "./sql/bun_client";
import { postgresDialect } from "./sql/dialects/postgres";

export { DbError } from "./sql/adapter";

// A PostgreSQL adapter on Bun's built-in SQL client (or any driver that can be wrapped as an
// SqlClient). Everything about how data is stored lives in ./sql/adapter.ts and
// ./sql/dialects/postgres.ts.

export type PostgresAdapterConfig = {
  // A connection string; connects through Bun's built-in SQL client.
  url?: string;
  // Connection pool size for `url`.
  max?: number;
  // TLS for `url`: true, or Bun's TLS options. Use it for anything but a local database.
  tls?: boolean | Record<string, unknown>;
  // Bring your own driver, wrapped as an SqlClient, instead of `url`.
  connect?: () => Promise<Connection> | Connection;
  // Put every table in this schema instead of the connection's default one. It must exist.
  schema?: string;
};

// "host:port/database" from a connection string, without its credentials.
const hostAndDatabase = (url: string) => {
  try {
    const parsed = new URL(url);
    return `${parsed.host}${parsed.pathname}`;
  } catch {
    return "postgres";
  }
};

export const postgresAdapter = (config: PostgresAdapterConfig = {}) =>
  sqlAdapter({
    name: "postgres",
    dialect: postgresDialect,
    schema: config.schema,

    connect() {
      if (config.connect) return config.connect();
      if (config.url) {
        return bunSqlClient(config.url, { max: config.max, tls: config.tls });
      }
      throw new Error("postgresAdapter() needs either `url` or `connect`");
    },

    describe() {
      const where = config.url
        ? hostAndDatabase(config.url)
        : "custom connection";
      return config.schema ? `${where} (${config.schema})` : where;
    },
  });

export default postgresAdapter;
