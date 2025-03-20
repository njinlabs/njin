import { Exclude, Transform, Type } from "class-transformer";
import moment, { type Moment } from "moment";
import {
  Column,
  Entity,
  ManyToOne,
  PrimaryGeneratedColumn,
  type Relation,
} from "typeorm";
import Base from "./base";
import User from "./user";

@Entity()
export default class UserToken extends Base {
  @PrimaryGeneratedColumn()
  public id!: number;

  @Column({ default: null, nullable: true })
  public name!: string;

  @Column()
  @Exclude()
  public hashed!: string;

  @Column({ type: "timestamptz", nullable: true })
  @Transform(({ value }) => (value ? moment(value) : null), {
    toClassOnly: true,
  })
  public expiredAt!: Moment;

  @ManyToOne(() => User, (user) => user.tokens, { cascade: true })
  public user!: Relation<User>;
}
