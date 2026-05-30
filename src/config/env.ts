const env = {
  port: Number(process.env.PORT ?? 3000),
  db: {
    path: process.env.DB_PATH ?? "rocksdb://mydb",
    namespace: process.env.DB_NAMESPACE ?? "general",
    database: process.env.DB_DATABASE ?? "general",
  },
  file: {
    dir: process.env.FILE_DIR ?? "./uploads",
  },
};

export default env;
