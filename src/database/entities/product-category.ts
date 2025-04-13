import { Column, Entity, OneToMany, PrimaryGeneratedColumn } from "typeorm";
import Base from "./base";
import Product from "./product";
import { Type } from "class-transformer";

@Entity()
export default class ProductCategory extends Base {
  @PrimaryGeneratedColumn("uuid")
  public id!: string;

  @Column()
  public name!: string;

  @OneToMany(() => Product, (product) => product.category)
  @Type(() => Product)
  public products!: Product[];
}
