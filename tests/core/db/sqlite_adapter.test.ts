import { sqliteAdapter } from "../../../src/core/adapters/sqlite";
import { describeAdapter } from "./contract_suite";

// The shared contract suite against SQLite, in memory: real SQLite semantics without a server.
describeAdapter("sqlite", () => sqliteAdapter({ path: ":memory:" }));
