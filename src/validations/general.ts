import Base from "@njin-entities/base";
import DineroFactory from "dinero.js";
import { FindOneOptions, FindOptionsWhere } from "typeorm";
import z, { ZodType } from "zod";

export const metaDataValidation = z.object({
  perPage: z.number().min(1).max(200).optional().default(50),
  page: z.number().min(1).optional().default(1),
  search: z.string().optional(),
});

export const uuidParamValidation = z.object({
  id: z.coerce.string().uuid(),
});

export const dineroValidation = z
  .number()
  .transform((value) => DineroFactory({ amount: value }));

export const unique = <Entity extends typeof Base, T>(
  validation: ZodType<T>,
  entity: Entity,
  field:
    | keyof InstanceType<Entity>
    | ((value: T) => FindOneOptions<InstanceType<Entity>>),
  allowCondition?: (value: T, result: InstanceType<Entity>) => Boolean
) => {
  return validation.refine(
    async (value) => {
      let options: FindOneOptions<InstanceType<Entity>> = {};

      if (typeof field === "string") {
        options = {
          where: {
            [field]: value,
          } as FindOptionsWhere<InstanceType<Entity>>,
        };
      } else {
        options = (field as (value: T) => FindOneOptions<InstanceType<Entity>>)(
          value
        );
      }

      if (!options.where) return true;

      const data = await entity.findOne(options as FindOneOptions<Base>);

      if (!data) return true;
      return allowCondition
        ? allowCondition(value, data as InstanceType<Entity>)
        : false;
    },
    {
      message: "Must a unique value",
    }
  );
};
