import fs from 'node:fs/promises';
import pg from 'pg';
import { migrateFirebase } from './migration-core.mjs';
const [, , input] = process.argv;
if (!input || input.startsWith('-')) throw new Error('Usage: node migrate-firebase.mjs <firebase-export.json>');
const source = JSON.parse(await fs.readFile(input, 'utf8'));
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false });
try { console.log(JSON.stringify(await migrateFirebase(source, pool), null, 2)); }
catch (e) { console.error('Migration rolled back:', e.message); process.exitCode = 1; }
finally { await pool.end(); }
