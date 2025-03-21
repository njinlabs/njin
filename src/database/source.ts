import { DataSource } from "typeorm";
import User from "./entities/user";
import UserToken from "@njin-entities/user-token";
import Group from "@njin-entities/access-group";

export const AppDataSource = new DataSource({
  type: "postgres",
  host: process.env.DB_HOST,
  port: Number(process.env.DB_PORT),
  username: process.env.DB_USER,
  password: process.env.DB_PASS,
  database: process.env.DB_NAME,
  synchronize: process.env.NODE_ENV === "production" ? false : true,
  logging: false,
  entities: [User, UserToken, Group],
  subscribers: [],
  migrations: [],
});
