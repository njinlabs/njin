import { Type } from "class-transformer";
import {
  Column,
  Entity,
  ManyToOne,
  PrimaryGeneratedColumn,
  type Relation,
} from "typeorm";
import Base from "./base";
import ProductCategory from "./product-category";

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

  @ManyToOne(() => ProductCategory, (category) => category.products, {
    eager: true,
    nullable: true,
    onDelete: "SET NULL",
  })
  @Type(() => ProductCategory)
  public category?: Relation<ProductCategory> | null;
}
