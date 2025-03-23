import { TransformDate } from "@njin-utils/transform-date";
import {
  instanceToInstance,
  instanceToPlain,
  plainToInstance,
} from "class-transformer";
import { DateTime } from "luxon";
import {
  AfterLoad,
  BaseEntity,
  CreateDateColumn,
  UpdateDateColumn,
} from "typeorm";

export default class Base extends BaseEntity {
  public static fromPlain<T>(this: new () => T, data: object) {
    return plainToInstance(this, data);
  }

  public serialize() {
    return instanceToPlain(this);
  }

  @AfterLoad()
  public transform() {
    Object.assign(this, instanceToInstance(this));
  }

  @CreateDateColumn({
    type: "timestamptz",
    default: () => "CURRENT_TIMESTAMP(6)",
  })
  @TransformDate()
  public createdAt!: DateTime;

  @UpdateDateColumn({
    type: "timestamptz",
    default: () => "CURRENT_TIMESTAMP(6)",
    onUpdate: "CURRENT_TIMESTAMP(6)",
  })
  @TransformDate()
  public updatedAt!: DateTime;
}
