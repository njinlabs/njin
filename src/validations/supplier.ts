import z from "zod";
import { unique } from "./general";
import Supplier from "@njin-entities/supplier";
import { FindOneOptions } from "typeorm";

export const composeSupplierValidation = unique(
  z.object({
    fullname: z.string(),
    phone: z.string().optional(),
    email: z.string().email().optional(),
  }),
  Supplier,
  (value) => {
    let options: FindOneOptions<Supplier> = {};

    if (value.phone || value.email) {
      options.where = [];

      if (value.phone) options.where.push({ phone: value.phone });
      if (value.email) options.where.push({ email: value.email });
    }

    return options;
  },
  (value, res) => {
    if (value.phone && value.phone !== res.phone) {
      return false;
    }
    if (value.email && value.email !== res.email) {
      return false;
    }

    return true;
  }
);
