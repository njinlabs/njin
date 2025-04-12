import { Column, Entity, PrimaryGeneratedColumn } from "typeorm";
import Base from "./base";

@Entity()
export default class PaymentMethod extends Base {
  @PrimaryGeneratedColumn("uuid")
  public id!: string;

  @Column()
  public name!: string;

  @Column()
  public accountName!: string;

  @Column()
  public accountNumber!: string;

  @Column()
  public isActive!: string;
}
