import { Transform, Type } from "class-transformer";
import { DateTime } from "luxon";

export function TransformDate() {
  return function (target: object, propertyKey: string | symbol): void {
    Type(() => Date)(target, propertyKey);

    Transform(
      ({ value }: { value: unknown }) =>
        value ? DateTime.fromJSDate(value as Date) : null,
      { toClassOnly: true }
    )(target, propertyKey);

    Transform(
      ({ value }: { value: unknown }) =>
        value
          ? (value instanceof DateTime
              ? value
              : DateTime.fromJSDate(value as Date)
            ).toISO()
          : null,
      { toPlainOnly: true }
    )(target, propertyKey);
  };
}
