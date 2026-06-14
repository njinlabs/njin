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
  img: {
    hosts: process.env.IMG_HOSTS
      ? process.env.IMG_HOSTS.split(",").map((h) => h.trim()).filter(Boolean)
      : [],
  },
};

export default env;
