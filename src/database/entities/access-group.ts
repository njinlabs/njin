import { Column, Entity, OneToMany, PrimaryGeneratedColumn } from "typeorm";
import Base from "./base";
import { ACLAllowed } from "@njin-types/acl";
import User from "./user";
import { Transform } from "class-transformer";
import { toList } from "@njin-utils/acl";

@Entity()
export default class AccessGroup extends Base {
  @PrimaryGeneratedColumn("uuid")
  public id!: string;

  @Column()
  public name!: string;

  @Column({
    type: "jsonb",
    nullable: true,
  })
  @Transform(({ value }) => (value ? toList(value) : []), {
    toPlainOnly: true,
  })
  public controls!: Partial<ACLAllowed> | null;

  @OneToMany(() => User, (user) => user.accessGroup)
  public users?: User[];
}
