import {
  BeforeInsert,
  BeforeUpdate,
  Column,
  Entity,
  OneToMany,
  PrimaryGeneratedColumn,
} from "typeorm";
import Base from "./base";
import Purchase from "./purchase";
import { Type } from "class-transformer";

@Entity()
export default class Supplier extends Base {
  @PrimaryGeneratedColumn("uuid")
  public id!: string;

  @Column()
  public fullname!: string;

  @Column({ nullable: true, unique: true })
  public phone?: string | null;

  @Column({ nullable: true, unique: true })
  public email?: string | null;

  @BeforeInsert()
  @BeforeUpdate()
  public sanitize() {
    if (this.phone)
      this.phone = this.phone.replace(/\D/g, "").replace(/^0/, "62");
    if (this.email) this.email = this.email.toLowerCase();
  }

  @OneToMany(() => Purchase, (purchase) => purchase.supplier)
  @Type(() => Purchase)
  public purchases!: Purchase[];
}
