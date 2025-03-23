import z from "zod";
import { unique } from "./general";
import Customer from "@njin-entities/customer";
import { FindOneOptions } from "typeorm";

export const composeCustomerValidation = unique(
  z.object({
    fullname: z.string(),
    phone: z.string().optional(),
    email: z.string().email().optional(),
  }),
  Customer,
  (value) => {
    let options: FindOneOptions<Customer> = {};

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
