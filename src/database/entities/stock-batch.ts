import database from "@njin-modules/database";
import { TransformDate } from "@njin-utils/transform-date";
import { Type } from "class-transformer";
import { DateTime } from "luxon";
import {
  Column,
  Entity,
  EntityManager,
  ManyToOne,
  PrimaryGeneratedColumn,
  type Relation,
} from "typeorm";
import Base from "./base";
import Product from "./product";
import ProfitLedger from "./profit-ledger";
import StockLedger from "./stock-ledger";

@Entity()
export default class StockBatch extends Base {
  @PrimaryGeneratedColumn("uuid")
  public id!: string;

  @Column()
  public productId!: string;

  @ManyToOne(() => Product, (product) => product.batches, {
    eager: true,
    onDelete: "CASCADE",
    nullable: false,
  })
  public product!: Relation<Product>;

  @Column({ type: "timestamptz", nullable: true })
  @TransformDate()
  public receivedAt!: DateTime;

  @Column({ type: "bigint" })
  @Type(() => Number)
  public quantity!: number;

  @Column({ type: "bigint" })
  @Type(() => Number)
  public price!: number;
}
