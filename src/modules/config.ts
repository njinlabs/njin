import { Module } from "@njin-types/module";
import z from "zod";

class Config implements Module {
  public njin!: Awaited<ReturnType<typeof this.validate>>;

  private validate<T>(data: T) {
    return z
      .object({
        invoiceNumberFormats: z
          .object({
            purchase: z
              .string()
              .optional()
              .default("PUR/%date:yyyy/LL/dd%/%000000%"),
          })
          .optional()
          .default({
            purchase: "PUR/%date:yyyy/LL/dd%/%000000%",
          }),
        database: z
          .object({
            host: z.string(),
            port: z.number(),
            user: z.string(),
            password: z.string(),
            name: z.string(),
          })
          .optional()
          .default({
            host: "localhost",
            port: 5432,
            user: "postgers",
            password: "postgres",
            name: "njin",
          }),
        currency: z
          .object({
            available: z.array(z.string()).optional().default(["IDR"]),
            default: z.string().optional().default("IDR"),
          })
          .optional()
          .default({
            available: ["IDR"],
            default: "IDR",
          }),
      })
      .parseAsync(data)
      .catch((e) => {
        throw new Error("Config is invalid");
      });
  }

  async boot() {
    const config = Bun.file(process.env.CONFIG_FILE || "./njin.config.json");

    if (await config.exists()) {
      this.njin = await this.validate(await config.json());

      return;
    }

    this.njin = await this.validate({});
  }
}

export default new Config();
