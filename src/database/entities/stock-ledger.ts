import { Type } from "class-transformer";
import {
  Column,
  Entity,
  JoinColumn,
  ManyToOne,
  OneToOne,
  PrimaryGeneratedColumn,
  type Relation,
} from "typeorm";
import Base from "./base";
import Product from "./product";
import StockAdjustment from "./stock-adjustment";

@Entity()
export default class StockLedger extends Base {
  @PrimaryGeneratedColumn("uuid")
  public id!: string;

  @ManyToOne(() => Product, (product) => product.ledgers, {
    eager: true,
    onDelete: "CASCADE",
    nullable: false,
  })
  public product!: Relation<Product>;

  @Column({ type: "bigint" })
  @Type(() => Number)
  public current!: number;

  @Column({ type: "bigint" })
  @Type(() => Number)
  public add!: number;

  @Column({ type: "bigint" })
  @Type(() => Number)
  public result!: number;

  @OneToOne(() => StockAdjustment, { eager: true, nullable: true })
  @JoinColumn()
  public adjustment!: Relation<StockAdjustment>;
}
