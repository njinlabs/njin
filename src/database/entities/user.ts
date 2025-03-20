import {
  BeforeInsert,
  BeforeUpdate,
  Column,
  Entity,
  OneToMany,
  PrimaryGeneratedColumn,
  type Relation,
} from "typeorm";
import Base from "./base";
import { Exclude } from "class-transformer";
import { hash } from "argon2";
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
  public tokens!: User[];
}
