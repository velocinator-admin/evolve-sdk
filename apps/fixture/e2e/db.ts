import postgres from "postgres";
import { DB_URL } from "./env";

/** Read-only access to the customer DB for assertions. */
export const sql = postgres(DB_URL, { max: 2, onnotice: () => {} });
