import { Type } from "class-transformer";
import {
  Column,
  Entity,
  ManyToOne,
  PrimaryGeneratedColumn,
  type Relation,
} from "typeorm";
import Base from "./base";
import Product from "./product";
import User from "./user";

@Entity()
export default class StockAdjustment extends Base {
  @PrimaryGeneratedColumn("uuid")
  public id!: string;

  @Column()
  public productId!: string;

  @ManyToOne(() => Product, (product) => product.adjustments, {
    eager: true,
    onDelete: "CASCADE",
    nullable: false,
  })
  public product!: Relation<Product>;

  @Column({ type: "bigint" })
  @Type(() => Number)
  public quantity!: number;

  @Column()
  public userId!: string;

  @ManyToOne(() => User, (user) => user.stockAdjustments, {
    nullable: true,
    eager: true,
    onDelete: "SET NULL",
  })
  public user?: Relation<User>;
}
