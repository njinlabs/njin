import cli from "@modules/cli";
import server from "@modules/server";

export default function start() {
  cli.program
    .command("start")
    .description("Start Njin HTTP server")
    .action(() => {
      server.start();
    });
}
