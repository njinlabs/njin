import { type Connection, sqlAdapter } from "./sql/adapter";
import { bunSqlClient } from "./sql/bun_client";
import { mysqlDialect } from "./sql/dialects/mysql";

// A MySQL / MariaDB adapter on Bun's built-in SQL client. The two servers share a driver and are
// told apart by their version string once connected, so one adapter serves both. Everything about
// how data is stored lives in ./sql/adapter.ts and ./sql/dialects/mysql.ts.

export type MysqlAdapterConfig = {
  // A connection string: mysql://user:pass@host:3306/database.
  url?: string;
  // Connection pool size for `url`.
  max?: number;
  // TLS for `url`: true, or Bun's TLS options. Use it for anything but a local database.
  tls?: boolean | Record<string, unknown>;
  // MySQL 8 with an account that uses caching_sha2_password (the default there), over a
  // connection without TLS: lets the client fetch the server's RSA public key to log in. Bun
  // refuses that by default (since 1.4.3) because the key could be swapped by someone on the
  // network. Use `tls: true` instead wherever you can; this is for a local or otherwise trusted
  // network. MariaDB does not need it.
  allowPublicKeyRetrieval?: boolean;
  // Bring your own driver, wrapped as an SqlClient, instead of `url`.
  connect?: () => Promise<Connection> | Connection;
  // Put every table in this database instead of the connection's default one. It must exist.
  schema?: string;
};

// "host:port/database" from a connection string, without its credentials.
const hostAndDatabase = (url: string) => {
  try {
    const parsed = new URL(url);
    return `${parsed.host}${parsed.pathname}`;
  } catch {
    return "mysql";
  }
};

export const mysqlAdapter = (config: MysqlAdapterConfig = {}) =>
  sqlAdapter({
    name: "mysql",
    schema: config.schema,

    dialect: async (client) => {
      const [row] = await client.query("select version() as v", []);
      return mysqlDialect(/mariadb/i.test(String(row?.v)));
    },

    connect() {
      if (config.connect) return config.connect();
      if (config.url) {
        return bunSqlClient(config.url, {
          max: config.max,
          tls: config.tls,
          allowPublicKeyRetrieval: config.allowPublicKeyRetrieval,
          mysql: true,
        });
      }
      throw new Error("mysqlAdapter() needs either `url` or `connect`");
    },

    describe() {
      const where = config.url
        ? hostAndDatabase(config.url)
        : "custom connection";
      return config.schema ? `${where} (${config.schema})` : where;
    },
  });

export default mysqlAdapter;
