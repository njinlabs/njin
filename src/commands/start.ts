import cli from "@njin-modules/cli";
import server from "@njin-modules/server";

export default function start() {
  cli.program
    .command("start")
    .description("Start Njin HTTP server")
    .action(() => {
      server.start();
    });
}
