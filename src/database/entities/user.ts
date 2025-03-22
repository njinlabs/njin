import { type ACLAllowed } from "@njin-types/acl";
import { hash } from "argon2";
import { Exclude } from "class-transformer";
import {
  BeforeInsert,
  BeforeUpdate,
  Column,
  Entity,
  OneToMany,
  PrimaryGeneratedColumn,
} from "typeorm";
import Base from "./base";
import UserToken from "./user-token";

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
  public controls!: ACLAllowed | null;

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

  @OneToMany(() => UserToken, (token) => token.user)
  public tokens?: User[];
}
