import database from "./database";
import auth from "./auth";
import server from "./server";
import cli from "./cli";
import config from "./config";

const modules = [config, database, auth, server, cli];

export default modules;
