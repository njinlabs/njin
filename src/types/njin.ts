import auth from "@njin-modules/auth";

export type Njin = {
  Variables: {
    auth: Awaited<ReturnType<ReturnType<typeof auth.use>["validate"]>>;
  };
};
