import User from "@njin-entities/user";
import auth from "@njin-modules/auth";
import cli from "@njin-modules/cli";
import database from "@njin-modules/database";
import { afterAll, beforeAll } from "bun:test";
import bootstrap from "../src/utils/bootstrap";

beforeAll(async () => {
  cli.ui.logger.info(`Start test`);
  await bootstrap();
});

afterAll(async () => {
  await database.source.dropDatabase();
  await database.source.destroy();

  cli.ui.logger.info(`Clearing database`);
});

export const defaultTestData = async () => {
  const superuserToken = await auth
    .use("user")
    .generate(
      (
        await User.find()
      ).find(({ controls }) => controls?.user?.includes("write"))!
    );

  return {
    tokens: {
      superuser: `Bearer ${superuserToken}`,
    },
  };
};
