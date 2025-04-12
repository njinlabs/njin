import "reflect-metadata";
import modules from "../modules";

async function bootstrap() {
  for (const module of modules) {
    await module.boot();
  }

  return modules;
}

export default bootstrap;
