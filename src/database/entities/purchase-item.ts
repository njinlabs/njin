import {
  Column,
  Entity,
  ManyToOne,
  PrimaryGeneratedColumn,
  type Relation,
} from "typeorm";
import Base from "./base";
import { Type } from "class-transformer";
import Product from "./product";
import Purchase from "./purchase";
import { TransformDinero, transformDinero } from "@njin-utils/transform-dinero";
import { type Dinero } from "dinero.js";

@Entity()
export default class PurchaseItem extends Base {
  @PrimaryGeneratedColumn("uuid")
  public id!: string;

  @Column()
  public name!: string;

  @Column("numeric", { precision: 12, scale: 2, transformer: transformDinero })
  @TransformDinero()
  public price!: Dinero;

  @Column()
  @Type(() => Number)
  public quantity!: number;

  @Column("numeric", { precision: 12, scale: 2, transformer: transformDinero })
  @TransformDinero()
  public total!: Dinero;

  @Column({ nullable: true })
  public productId!: string;

  @Column({ nullable: true })
  public purchaseId!: string;

  @ManyToOne(() => Product, (product) => product.purchases, {
    onDelete: "SET NULL",
    eager: true,
  })
  @Type(() => Product)
  public product!: Relation<Product>;

  @ManyToOne(() => Purchase, (purchase) => purchase.items)
  @Type(() => PurchaseItem)
  public purchase!: PurchaseItem[];
}
