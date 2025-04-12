import User from "@njin-entities/user";
import cli from "@njin-modules/cli";
import { afterAll, beforeAll } from "bun:test";
import { AppDataSource } from "../src/database/source";
import bootstrap from "../src/utils/bootstrap";
import auth from "@njin-modules/auth";

beforeAll(async () => {
  cli.ui.logger.info(`Start test`);
  await bootstrap();
});

afterAll(async () => {
  await AppDataSource.dropDatabase();
  await AppDataSource.destroy();

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
