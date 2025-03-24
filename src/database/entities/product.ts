import { Exclude, Type } from "class-transformer";
import {
  Column,
  Entity,
  ManyToOne,
  OneToMany,
  PrimaryGeneratedColumn,
  type Relation,
} from "typeorm";
import Base from "./base";
import ProductCategory from "./product-category";
import StockLedger from "./stock-ledger";
import StockAdjustment from "./stock-adjustment";
import StockBatch from "./stock-batch";

@Entity()
export default class Product extends Base {
  @PrimaryGeneratedColumn("uuid")
  public id!: string;

  @Column()
  public name!: string;

  @Column({
    type: "bigint",
  })
  @Type(() => Number)
  public price!: number;

  @Column({ nullable: true, unique: true })
  public code?: string | null;

  @Column({ nullable: true, unique: true })
  public barcode?: string | null;

  @Column({
    type: "bigint",
    default: 0,
  })
  @Type(() => Number)
  public stock!: number;

  @Column({
    type: "jsonb",
    nullable: true,
  })
  public stockSetting?: {
    default: string;
    inherit?: {
      [key: string]: number;
    };
  } | null;

  @Column({ nullable: true })
  public categoryId!: string;

  @ManyToOne(() => ProductCategory, (category) => category.products, {
    eager: true,
    nullable: true,
    onDelete: "SET NULL",
  })
  public category?: Relation<ProductCategory> | null;

  @OneToMany(() => StockLedger, (ledger) => ledger.product)
  public ledgers!: StockLedger[];

  @OneToMany(() => StockAdjustment, (adjustment) => adjustment.product)
  public adjustments!: StockLedger[];

  @OneToMany(() => StockBatch, (adjustment) => adjustment.product)
  public batches!: StockBatch[];
}
