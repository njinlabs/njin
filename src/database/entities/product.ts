import { TransformDinero, transformDinero } from "@njin-utils/transform-dinero";
import { Type } from "class-transformer";
import { type Dinero } from "dinero.js";
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
import PurchaseItem from "./purchase-item";
import StockAdjustment from "./stock-adjustment";
import StockBatch from "./stock-batch";
import StockLedger from "./stock-ledger";

@Entity()
export default class Product extends Base {
  @PrimaryGeneratedColumn("uuid")
  public id!: string;

  @Column()
  public name!: string;

  @Column("numeric", { precision: 12, scale: 2, transformer: transformDinero })
  @TransformDinero()
  public price!: Dinero;

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
  @Type(() => ProductCategory)
  public category?: Relation<ProductCategory> | null;

  @OneToMany(() => StockLedger, (ledger) => ledger.product)
  @Type(() => StockLedger)
  public ledgers!: StockLedger[];

  @OneToMany(() => StockAdjustment, (adjustment) => adjustment.product)
  @Type(() => StockAdjustment)
  public adjustments!: StockLedger[];

  @OneToMany(() => StockBatch, (batch) => batch.product)
  @Type(() => StockBatch)
  public batches!: StockBatch[];

  @OneToMany(() => PurchaseItem, (purchaseItem) => purchaseItem.product)
  @Type(() => PurchaseItem)
  public purchases!: PurchaseItem[];
}
