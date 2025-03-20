import {
  instanceToPlain,
  plainToInstance,
  Transform,
  Type,
} from "class-transformer";
import moment, { type Moment } from "moment";
import { BaseEntity, CreateDateColumn, UpdateDateColumn } from "typeorm";

export default class Base extends BaseEntity {
  public static fromPlain<T>(this: new () => T, data: object) {
    return plainToInstance(this, data);
  }

  public serialize() {
    return instanceToPlain(this);
  }

  @CreateDateColumn({
    type: "timestamptz",
    default: () => "CURRENT_TIMESTAMP(6)",
  })
  @Transform(({ value }) => (value ? moment(value) : null), {
    toClassOnly: true,
  })
  public createdAt!: Moment;

  @UpdateDateColumn({
    type: "timestamptz",
    default: () => "CURRENT_TIMESTAMP(6)",
    onUpdate: "CURRENT_TIMESTAMP(6)",
  })
  @Transform(({ value }) => (value ? moment(value) : null), {
    toClassOnly: true,
  })
  public updatedAt!: Moment;
}
