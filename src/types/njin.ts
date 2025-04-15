import auth from "@njin-modules/auth";
import config from "@njin-modules/config";

export type Njin = {
  Variables: {
    auth: Awaited<ReturnType<ReturnType<typeof auth.use>["validate"]>>;
  };
};

export type NjinConfig = typeof config.njin;
