import { Column, Entity, OneToMany, PrimaryGeneratedColumn } from "typeorm";
import Base from "./base";
import Product from "./product";

@Entity()
export default class ProductCategory extends Base {
  @PrimaryGeneratedColumn("uuid")
  public id!: string;

  @Column()
  public name!: string;

  @OneToMany(() => Product, (product) => product.category)
  public products!: Product[];
}
