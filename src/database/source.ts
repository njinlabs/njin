import { DataSource } from "typeorm";
import User from "./entities/user";
import UserToken from "@njin-entities/user-token";
import Group from "@njin-entities/access-group";
import ProductCategory from "@njin-entities/product-category";
import Product from "@njin-entities/product";
import StockAdjustment from "@njin-entities/stock-adjustment";
import StockLedger from "@njin-entities/stock-ledger";
import StockBatch from "@njin-entities/stock-batch";
import Customer from "@njin-entities/customer";
import Supplier from "@njin-entities/supplier";
import ProfitLedger from "@njin-entities/profit-ledger";

export const AppDataSource = new DataSource({
  type: "postgres",
  host: process.env.DB_HOST,
  port: Number(process.env.DB_PORT),
  username: process.env.DB_USER,
  password: process.env.DB_PASS,
  database: process.env.DB_NAME,
  synchronize: process.env.NODE_ENV === "production" ? false : true,
  logging: false,
  entities: [
    User,
    UserToken,
    Group,
    ProductCategory,
    Product,
    StockAdjustment,
    StockLedger,
    StockBatch,
    ProfitLedger,
    Customer,
    Supplier,
  ],
  subscribers: [],
  migrations: [],
});
