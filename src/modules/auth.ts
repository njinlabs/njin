import User from "@njin-entities/user";
import UserToken from "@njin-entities/user-token";
import { Module } from "@njin-types/module";
import { createId } from "@paralleldrive/cuid2";
import { hash, verify } from "argon2";
import { type Moment } from "moment";

class Auth implements Module {
  public guards = {
    user: {
      User,
      Token: UserToken,
    },
  };

  public boot() {}

  public use(guard: keyof typeof this.guards = "user") {
    return {
      generate: this.generate(guard),
      validate: this.validate(guard),
    };
  }

  private generate(guard: keyof typeof this.guards) {
    const guardUsed = this.guards[guard];

    return async (
      user: InstanceType<(typeof guardUsed)["User"]>,
      name: string = "",
      expiredAt?: Moment
    ) => {
      const plainToken = createId();

      const token = new guardUsed.Token();
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
    ): Promise<InstanceType<(typeof guardUsed)["Token"]>> => {
      const [id, hashed = ""] = plainToken.split("_");

      const token = await guardUsed.Token.findOneOrFail({
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

export default new Auth();
