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
import PaymentMethod from "@njin-entities/payment-method";
import Purchase from "@njin-entities/purchase";
import PurchaseItem from "@njin-entities/purchase-item";
import config from "@njin-modules/config";

export const AppDataSource = () =>
  new DataSource({
    type: "postgres",
    host: config.njin.database.host,
    port: config.njin.database.port,
    username: config.njin.database.user,
    password: config.njin.database.password,
    database: config.njin.database.name,
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
      PaymentMethod,
      Purchase,
      PurchaseItem,
    ],
    subscribers: [],
    migrations: [],
  });
