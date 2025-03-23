import { Exclude, Transform, Type } from "class-transformer";
import { DateTime } from "luxon";
import {
  Column,
  Entity,
  ManyToOne,
  PrimaryGeneratedColumn,
  type Relation,
} from "typeorm";
import Base from "./base";
import User from "./user";
import { TransformDate } from "@njin-utils/transform-date";

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
  @TransformDate()
  public expiredAt!: DateTime;

  @Column()
  public userId!: string;

  @ManyToOne(() => User, (user) => user.tokens, { cascade: true })
  public user?: Relation<User>;
}
