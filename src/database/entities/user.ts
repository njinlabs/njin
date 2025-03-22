import { type ACLAllowed } from "@njin-types/acl";
import { hash } from "argon2";
import { Exclude } from "class-transformer";
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
import Base from "./base";
import UserToken from "./user-token";
import Group from "./group";

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
  public controls!: Partial<ACLAllowed> | null;

  @Exclude({
    toPlainOnly: true,
  })
  public plainPassword!: string;

  @BeforeInsert()
  @BeforeUpdate()
  public async hashPassword() {
    if (this.plainPassword) {
      this.password = await hash(this.plainPassword);
    }
  }

  @AfterLoad()
  public setControls() {
    if (this.group) {
      this.controls = this.group.controls;
    }
  }

  @OneToMany(() => UserToken, (token) => token.user)
  public tokens?: User[];

  @Exclude({ toPlainOnly: true })
  @ManyToOne(() => Group, (group) => group.users, {
    eager: true,
    nullable: true,
    onDelete: "SET NULL",
  })
  public group?: Relation<Group>;
}
