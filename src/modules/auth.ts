import authConfig from "@njin-config/auth.config";
import { AuthGuard } from "@njin-types/auth";
import { Module } from "@njin-types/module";
import { createId } from "@paralleldrive/cuid2";
import { hash, verify } from "argon2";
import { DateTime } from "luxon";

class Auth implements Module {
  public guards = authConfig.guards;

  public boot() {}

  public use(guard: keyof typeof this.guards = authConfig.defaultGuard) {
    return {
      generate: this.generate(guard),
      validate: this.validate(guard),
    };
  }

  private generate(guard: keyof typeof this.guards) {
    const guardUsed = this.guards[guard];

    return async (
      user: InstanceType<(typeof guardUsed)["user"]>,
      name: string = "",
      expiredAt?: DateTime
    ) => {
      const plainToken = createId();

      const token = new guardUsed.token();
      token.name = name;
      if (expiredAt) token.expiredAt = expiredAt;
      token.hashed = await hash(plainToken);
      token.user = user;

      await token.save();

      return `${token.id}_${plainToken}`;
    };
  }

  private validate(guard: keyof typeof this.guards) {
    const guardUsed = this.guards[guard];

    return async (
      plainToken: string
    ): Promise<InstanceType<(typeof guardUsed)["token"]>> => {
      const [id, hashed = ""] = plainToken.split("_");

      const token = await guardUsed.token.findOneOrFail({
        where: { id: Number(id) },
        relations: {
          user: true,
        },
      });

      if (!(await verify(token.hashed, hashed))) {
        throw new Error("Token invalid");
      }

      return token;
    };
  }
}

export function makeConfig<
  Keys extends string,
  Guards extends Record<Keys, AuthGuard>
>(config: { guards: Guards; defaultGuard: keyof Guards }) {
  return config;
}

export default new Auth();
