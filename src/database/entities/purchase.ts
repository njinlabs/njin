import config from "@njin-modules/config";
import { type Fee } from "@njin-types/fee";
import { calculateFee } from "@njin-utils/fee";
import { generateInvoice } from "@njin-validations/invoice";
import DineroFactory, { type Dinero } from "dinero.js";
import { DateTime } from "luxon";
import {
  BeforeInsert,
  Column,
  Entity,
  ManyToOne,
  PrimaryGeneratedColumn,
  type Relation,
} from "typeorm";
import Base from "./base";
import PurchaseItem from "./purchase-item";
import Supplier from "./supplier";
import User from "./user";
import { TransformDinero, transformDinero } from "@njin-utils/transform-dinero";
import { Exclude, Type } from "class-transformer";

@Entity()
export default class Purchase extends Base {
  @PrimaryGeneratedColumn("uuid")
  public id!: string;

  @Column({ unique: true })
  public invoiceNumber!: string;

  @Column("numeric", { precision: 12, scale: 2, transformer: transformDinero })
  @TransformDinero()
  public total!: Dinero;

  @Column({ nullable: true })
  public status!: "PAID" | "PENDING";

  @Column({ type: "jsonb" })
  public fees!: Fee[];

  @Column({ nullable: true })
  public supplierId!: string;

  @Column()
  public userId!: string;

  @ManyToOne(() => Supplier, (supplier) => supplier.purchases, {
    eager: true,
    onDelete: "SET NULL",
  })
  @Type(() => Supplier)
  public supplier!: Relation<Supplier>;

  @ManyToOne(() => User, (user) => user.purchases, {
    onDelete: "SET NULL",
  })
  @Type(() => User)
  public user!: Relation<User>;

  @ManyToOne(() => PurchaseItem, (item) => item.purchase)
  @Type(() => PurchaseItem)
  public items!: PurchaseItem[];

  @BeforeInsert()
  public async prependData() {
    const { result: fees, total } = calculateFee(
      this.items.reduce(
        (carry, item) => carry.add(item.total),
        DineroFactory({ amount: 0 })
      ),
      this.fees
    );

    const format =
      config.njin.invoiceNumberFormats?.purchase ||
      "PUR/%date:yyyy/LL/dd%/%number%";
    let number =
      (await Purchase.count({
        where: {
          createdAt: DateTime.now().startOf("day"),
        },
      })) + 1;

    this.fees = fees;
    this.invoiceNumber = generateInvoice(format, number);
    this.total = total;

    while (
      Boolean(
        await Purchase.count({
          where: {
            invoiceNumber: this.invoiceNumber,
          },
        })
      )
    ) {
      number++;
      this.invoiceNumber = generateInvoice(format, number);
    }
  }
}
