import z from "zod";
import { createUserValidation } from "./user";

export const initialSetupValidation = z.object({
  superuser: createUserValidation,
});
