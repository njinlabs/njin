import { Type } from "class-transformer";
import { BeforeInsert, Column, Entity, PrimaryGeneratedColumn } from "typeorm";
import Base from "./base";

@Entity()
export default class ProfitLedger extends Base {
  @PrimaryGeneratedColumn("uuid")
  public id!: string;

  @Column({ type: "bigint" })
  @Type(() => Number)
  public current!: number;

  @Column({ type: "bigint" })
  @Type(() => Number)
  public add!: number;

  @Column({ type: "bigint" })
  @Type(() => Number)
  public result!: number;

  @BeforeInsert()
  public setResult() {
    this.result = this.current + this.add;
  }
}
