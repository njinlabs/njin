import { DataSource } from "typeorm";
import User from "./entities/user";

export const AppDataSource = new DataSource({
  type: "postgres",
  host: process.env.DB_HOST,
  port: Number(process.env.DB_PORT),
  username: process.env.DB_USER,
  password: process.env.DB_PASS,
  database: process.env.DB_NAME,
  synchronize: process.env.NODE_ENV === "production" ? false : true,
  logging: false,
  entities: [User],
  subscribers: [],
  migrations: [],
});
