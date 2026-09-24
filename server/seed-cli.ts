import { rmSync } from "node:fs";
import { openDb } from "./db.ts";
import { seed } from "./seed.ts";

// Wipes the local database and seeds it again.
const file = process.env.PLANCIA_DB ?? "data/plancia.db";
for (const f of [file, `${file}-wal`, `${file}-shm`]) rmSync(f, { force: true });
seed(openDb(file));
console.log(`Seeded ${file}`);
