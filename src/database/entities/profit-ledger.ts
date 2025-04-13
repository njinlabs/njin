import { transformDinero, TransformDinero } from "@njin-utils/transform-dinero";
import { type Dinero } from "dinero.js";
import { BeforeInsert, Column, Entity, PrimaryGeneratedColumn } from "typeorm";
import Base from "./base";

@Entity()
export default class ProfitLedger extends Base {
  @PrimaryGeneratedColumn("uuid")
  public id!: string;

  @Column("numeric", {
    precision: 12,
    scale: 2,
    transformer: transformDinero,
    nullable: true,
  })
  @TransformDinero()
  public current!: Dinero;

  @Column("numeric", {
    precision: 12,
    scale: 2,
    transformer: transformDinero,
    nullable: true,
  })
  @TransformDinero()
  public add!: Dinero;

  @Column("numeric", {
    precision: 12,
    scale: 2,
    transformer: transformDinero,
    nullable: true,
  })
  @TransformDinero()
  public result!: Dinero;

  @BeforeInsert()
  public setResult() {
    this.result = this.current.add(this.add);
  }
}
