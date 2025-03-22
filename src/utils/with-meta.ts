import Base from "@njin-entities/base";
import { metaDataValidation } from "@njin-validations/general";
import z from "zod";

export async function withMeta<Entity extends typeof Base>(
  model: Entity,
  {
    meta: { perPage, page },
  }: {
    meta: z.infer<typeof metaDataValidation>;
  }
) {
  const data = await model.find({
    take: perPage,
    skip: (page - 1) * perPage,
  });
  const dataCount = await model.count();

  return {
    data: data.map((item) => item.serialize()),
    meta: {
      pagination: {
        page,
        perPage,
        totalItems: dataCount,
        totalPages: Math.ceil(dataCount / perPage),
      },
    },
  };
}
