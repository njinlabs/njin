import auth from "./auth";
import cli from "./cli";
import database from "./database";
import server from "./server";

const modules = [database, auth, server, cli];

export default modules;
