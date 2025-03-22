import { Column, Entity, OneToMany, PrimaryGeneratedColumn } from "typeorm";
import Base from "./base";
import { ACLAllowed } from "@njin-types/acl";
import User from "./user";

@Entity()
export default class Group extends Base {
  @PrimaryGeneratedColumn("uuid")
  public id!: string;

  @Column()
  public name!: string;

  @Column({
    type: "jsonb",
    nullable: true,
  })
  public controls!: Partial<ACLAllowed> | null;

  @OneToMany(() => User, (user) => user.group)
  public users?: User[];
}
