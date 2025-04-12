import { TransformDate } from "@njin-utils/transform-date";
import {
  instanceToInstance,
  instanceToPlain,
  plainToInstance,
} from "class-transformer";
import { DateTime } from "luxon";
import {
  AfterInsert,
  AfterLoad,
  AfterUpdate,
  BaseEntity,
  CreateDateColumn,
  FindOptionsWhere,
  UpdateDateColumn,
} from "typeorm";

export default class Base extends BaseEntity {
  public static fromPlain<T>(this: new () => T, data: object) {
    return plainToInstance(this, data);
  }

  public static async findOneAndAssign<T>(
    this: new () => T,
    where: FindOptionsWhere<T>,
    data: object
  ): Promise<T> {
    return Object.assign(
      await (this as unknown as typeof BaseEntity).findOneByOrFail(where),
      data
    ) as T;
  }

  public serialize() {
    return instanceToPlain(this);
  }

  @AfterInsert()
  @AfterUpdate()
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
