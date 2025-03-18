import cli from "./cli";
import database from "./database";
import server from "./server";

const modules = [database, server, cli];

export default modules;
