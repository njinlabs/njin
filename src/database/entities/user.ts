import { type ACLAllowed } from "@njin-types/acl";
import { toList } from "@njin-utils/acl";
import { hash } from "argon2";
import { Exclude, Transform, Type } from "class-transformer";
import {
  AfterLoad,
  BeforeInsert,
  BeforeUpdate,
  Column,
  Entity,
  ManyToOne,
  OneToMany,
  PrimaryGeneratedColumn,
  type Relation,
} from "typeorm";
import { default as AccessGroup } from "./access-group";
import Base from "./base";
import UserToken from "./user-token";
import StockAdjustment from "./stock-adjustment";
import Purchase from "./purchase";

@Entity()
export default class User extends Base {
  @PrimaryGeneratedColumn("uuid")
  public id!: string;

  @Column()
  public fullname!: string;

  @Column()
  @Exclude()
  public password!: string;

  @Column({
    unique: true,
  })
  public email!: string;

  @Column({
    type: "jsonb",
    nullable: true,
  })
  @Transform(({ value }) => (value ? toList(value) : []), {
    toPlainOnly: true,
  })
  public controls!: Partial<ACLAllowed> | null;

  @Exclude({
    toPlainOnly: true,
  })
  public plainPassword!: string;

  @BeforeInsert()
  @BeforeUpdate()
  public async sanitize() {
    if (this.plainPassword) {
      this.password = await hash(this.plainPassword);
    }
    if (this.email) this.email = this.email.toLowerCase();
  }

  @AfterLoad()
  public setControls() {
    if (this.accessGroup) {
      this.controls = this.accessGroup.controls;
    }
  }

  @OneToMany(() => UserToken, (token) => token.user)
  @Type(() => UserToken)
  public tokens?: UserToken[];

  @OneToMany(() => StockAdjustment, (adjustment) => adjustment.user)
  @Type(() => StockAdjustment)
  public stockAdjustments?: StockAdjustment[];

  @OneToMany(() => Purchase, (purchase) => purchase.user)
  @Type(() => Purchase)
  public purchases?: Purchase[];

  @Column({ nullable: true })
  public accessGroupId!: string;

  @Exclude({ toPlainOnly: true })
  @ManyToOne(() => AccessGroup, (group) => group.users, {
    eager: true,
    nullable: true,
    onDelete: "SET NULL",
  })
  @Type(() => AccessGroup)
  public accessGroup?: Relation<AccessGroup>;
}
