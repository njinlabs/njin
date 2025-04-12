import { afterAll, beforeAll } from "bun:test";
import { AppDataSource } from "../src/database/source";
import bootstrap from "../src/utils/bootstrap";
import cli from "@njin-modules/cli";

beforeAll(async () => {
  cli.ui.logger.info(`Start test`);
  await bootstrap();
});

afterAll(async () => {
  await AppDataSource.dropDatabase();
  await AppDataSource.destroy();

  cli.ui.logger.info(`Clearing database`);
});
