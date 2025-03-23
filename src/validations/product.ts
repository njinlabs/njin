import z from "zod";
import { unique } from "./general";
import Product from "@njin-entities/product";
import ProductCategory from "@njin-entities/product-category";
import { FindOneOptions } from "typeorm";

const categoryValidation = z
  .object({
    id: z.string().uuid().optional(),
    name: z.string(),
  })
  .transform(async ({ id, name }) => {
    if (id) {
      return await ProductCategory.findOneBy({ id });
    }

    if (name) {
      const category = new ProductCategory();
      category.name = name;

      await category.save();

      return category;
    }

    return null;
  });

export const composeProductValidation = unique(
  z.object({
    name: z.string(),
    price: z.number(),
    code: z.string().optional(),
    barcode: z.string().optional(),
    defaultBasePrice: z.number().optional(),
    stockSetting: z
      .object({
        default: z.string(),
        inherit: z.record(z.string(), z.number()).optional(),
      })
      .optional(),
  }),
  Product,
  (value) => {
    let options: FindOneOptions<Product> = {};

    if (value.code || value.barcode) {
      options.where = [];

      if (value.code) options.where.push({ code: value.code });
      if (value.barcode) options.where.push({ barcode: value.barcode });
    }

    return options;
  },
  (value, res) => {
    if (value.barcode && value.barcode !== res.barcode) {
      return false;
    }
    if (value.code && value.code !== res.code) {
      return false;
    }

    return true;
  }
).and(z.object({ category: categoryValidation.optional() }));
