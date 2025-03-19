import { instanceToPlain, plainToInstance } from "class-transformer";
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
  public createdAt!: Date;

  @UpdateDateColumn({
    type: "timestamptz",
    default: () => "CURRENT_TIMESTAMP(6)",
    onUpdate: "CURRENT_TIMESTAMP(6)",
  })
  public updatedAt!: Date;
}
