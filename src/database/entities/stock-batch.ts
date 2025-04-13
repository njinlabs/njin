import { TransformDate } from "@njin-utils/transform-date";
import { transformDinero, TransformDinero } from "@njin-utils/transform-dinero";
import { Type } from "class-transformer";
import { type Dinero } from "dinero.js";
import { DateTime } from "luxon";
import {
  Column,
  Entity,
  ManyToOne,
  PrimaryGeneratedColumn,
  type Relation,
} from "typeorm";
import Base from "./base";
import Product from "./product";

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
  @Type(() => Product)
  public product!: Relation<Product>;

  @Column({ type: "timestamptz", nullable: true })
  @TransformDate()
  public receivedAt!: DateTime;

  @Column({ type: "bigint" })
  @Type(() => Number)
  public quantity!: number;

  @Column("numeric", { precision: 12, scale: 2, transformer: transformDinero })
  @TransformDinero()
  public price!: Dinero;
}
