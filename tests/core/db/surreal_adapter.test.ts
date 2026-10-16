import { surrealAdapter } from "../../../src/core/adapters/surreal";
import { describeAdapter } from "./contract_suite";

// A fresh in-memory database per test: the embedded engine behind mem:// is private to each
// connection, so tests can't see each other's rows.
describeAdapter("surreal (mem://)", () =>
  surrealAdapter({ path: "mem://", namespace: "test", database: "test" }),
);
