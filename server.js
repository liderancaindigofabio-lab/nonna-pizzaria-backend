import express from 'express';
import cors from 'cors';
import pg from 'pg';
import crypto from 'node:crypto';
import bcrypt from 'bcryptjs';
import { migrateFirebase } from './migration-core.mjs';
const {Pool}=pg;
const app=express(); app.use(cors()); app.use(express.json({limit:'2mb'}));
const pool=new Pool({connectionString:process.env.DATABASE_URL,ssl:process.env.NODE_ENV==='production'?{rejectUnauthorized:false}:false,connectionTimeoutMillis:8000,idleTimeoutMillis:10000});
pool.on('error',function(err){console.error('database pool error',err.message)});
const schema=`CREATE TABLE IF NOT EXISTS restaurants(id text primary key,name text not null,created_at timestamptz not null default now());
CREATE TABLE IF NOT EXISTS users(id text primary key,restaurant_id text not null references restaurants(id),email text not null unique,name text not null,role text not null,password_hash text not null default '',active boolean not null default true,created_at timestamptz not null default now(),last_access_at timestamptz);
CREATE TABLE IF NOT EXISTS products(id text primary key,restaurant_id text not null references restaurants(id),category text not null,name text not null,description text,price numeric(12,2) not null default 0,cost numeric(12,2) not null default 0,emoji text,image_url text,active boolean not null default true,updated_at timestamptz not null default now());
CREATE TABLE IF NOT EXISTS orders(id text primary key,restaurant_id text not null references restaurants(id),status text not null,channel text,customer jsonb not null default '{}',items jsonb not null default '[]',subtotal numeric(12,2) not null default 0,delivery_fee numeric(12,2) not null default 0,total numeric(12,2) not null default 0,payment jsonb not null default '{}',courier_id text,created_at timestamptz not null default now(),updated_at timestamptz not null default now());
CREATE TABLE IF NOT EXISTS order_events(id bigserial primary key,order_id text not null references orders(id),status text not null,actor_id text,metadata jsonb not null default '{}',created_at timestamptz not null default now());
CREATE TABLE IF NOT EXISTS cash_registers(id text primary key,restaurant_id text not null references restaurants(id),status text not null,opened_at timestamptz,closed_at timestamptz,counted numeric(12,2),expected numeric(12,2));
CREATE TABLE IF NOT EXISTS cash_movements(id text primary key,register_id text not null references cash_registers(id),type text not null,amount numeric(12,2) not null check(amount>0),description text,actor_id text,created_at timestamptz not null default now());
CREATE TABLE IF NOT EXISTS inventory(id text primary key,restaurant_id text not null references restaurants(id),name text not null,category text,quantity numeric(12,3) not null default 0,min_quantity numeric(12,3) not null default 0,unit text not null default 'un',updated_at timestamptz not null default now());
CREATE TABLE IF NOT EXISTS expenses(id text primary key,restaurant_id text not null references restaurants(id),description text not null,category text,amount numeric(12,2) not null check(amount>0),due_date date not null,paid boolean not null default false,created_at timestamptz not null default now());
CREATE TABLE IF NOT EXISTS reservations(id text primary key,restaurant_id text not null references restaurants(id),customer jsonb not null default '{}',table_no text,starts_at timestamptz not null,status text not null,created_at timestamptz not null default now());
CREATE TABLE IF NOT EXISTS migration_state(key text primary key,completed_at timestamptz not null default now());`;
let ready=null;
async function ensureSchema(){if(!ready)ready=pool.query(schema).catch(function(err){ready=null;throw err});return ready}
app.get('/health',async(_,res)=>{try{await ensureSchema();res.json({ok:true,service:'nonna-pizzaria-api'})}catch(e){res.status(503).json({ok:false,error:'database_unavailable'})}});
app.use(async(_,res,next)=>{try{await ensureSchema();next()}catch(e){res.status(503).json({error:'database_unavailable'})}});

// Temporary, tightly protected Firebase import endpoint. Remove after migration is confirmed.
const migrationAuthorized = req => {
  const expected = process.env.MIGRATION_TOKEN;
  const supplied = req.get('x-migration-token') || (req.get('authorization') || '').replace(/^Bearer\\s+/i, '');
  if (!expected || !supplied || expected.length !== supplied.length) return false;
  return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(supplied));
};
let lastMigration = null;
const migrationGuard = (req, res, next) => migrationAuthorized(req) ? next() : res.status(404).json({error:'not_found'});
app.post('/api/admin/migrate', migrationGuard, async (req,res) => {
  try {
    const result = await migrateFirebase(req.body, pool);
    lastMigration = { ...result, completedAt: new Date().toISOString() };
    res.json(lastMigration);
  } catch (e) {
    console.error('Admin migration rolled back:', e.message);
    res.status(500).json({ok:false,error:'migration_failed'});
  }
});
// One-time owner credential bridge. The password is accepted only over the
// token-protected request, hashed server-side, and is never logged or returned.
app.post('/api/admin/migrate/owner', migrationGuard, async (req, res) => {
  const email = String(req.body?.email || '').trim().toLowerCase();
  const password = typeof req.body?.password === 'string' ? req.body.password : '';
  if (email !== 'fabio08dejesusjunior@gmail.com' || password.length < 8) {
    return res.status(400).json({ ok: false, error: 'invalid_owner_payload' });
  }
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const claimed = await client.query(
      `INSERT INTO migration_state(key) VALUES('nonna-owner-credential-v1')
       ON CONFLICT(key) DO NOTHING RETURNING key`
    );
    if (!claimed.rowCount) {
      await client.query('ROLLBACK');
      return res.status(409).json({ ok: false, error: 'owner_already_imported' });
    }
    const passwordHash = await bcrypt.hash(password, 12);
    const existing = await client.query(
      `SELECT id FROM users WHERE restaurant_id=$1 AND (lower(email)=lower($2) OR id=$3)
       ORDER BY CASE WHEN lower(email)=lower($2) THEN 0 ELSE 1 END LIMIT 1`,
      ['nonna-pizzaria', email, 'HaUqvQd6muYH3zUNUpwBOhD29Bf1']
    );
    const id = existing.rows[0]?.id || 'HaUqvQd6muYH3zUNUpwBOhD29Bf1';
    await client.query(
      `INSERT INTO users(id,restaurant_id,email,name,role,password_hash,active)
       VALUES($1,$2,$3,$4,'owner',$5,true)
       ON CONFLICT(id) DO UPDATE SET restaurant_id=EXCLUDED.restaurant_id,email=EXCLUDED.email,
         name=EXCLUDED.name,role='owner',password_hash=EXCLUDED.password_hash,active=true`,
      [id, 'nonna-pizzaria', email, 'Fabio Júnior', passwordHash]
    );
    await client.query('COMMIT');
    return res.json({ ok: true, tenant: 'nonna-pizzaria', userId: id, role: 'owner', imported: true });
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('Owner credential import failed:', e.message);
    return res.status(500).json({ ok: false, error: 'owner_import_failed' });
  } finally { client.release(); }
});

app.get('/api/admin/migrate/status', migrationGuard, async (_req,res) => {
  try {
    const q = await pool.query(`SELECT json_build_object(
      'restaurants',(SELECT count(*)::int FROM restaurants WHERE id='nonna-pizzaria'),
      'users',(SELECT count(*)::int FROM users WHERE restaurant_id='nonna-pizzaria'),
      'products',(SELECT count(*)::int FROM products WHERE restaurant_id='nonna-pizzaria'),
      'orders',(SELECT count(*)::int FROM orders WHERE restaurant_id='nonna-pizzaria'),
      'orderEvents',(SELECT count(*)::int FROM order_events e JOIN orders o ON o.id=e.order_id WHERE o.restaurant_id='nonna-pizzaria')
    ) AS counts`);
    res.json({ok:true,tenant:'nonna-pizzaria',counts:q.rows[0].counts,lastMigration});
  } catch (e) { res.status(503).json({ok:false,error:'database_unavailable'}); }
});
// Public authentication endpoint for the Nonna operational panels.
function issueToken(payload) {
  const body = Buffer.from(JSON.stringify({ ...payload, exp: Date.now() + 7 * 86400000 })).toString('base64url');
  const secret = process.env.SESSION_SECRET || process.env.JWT_SECRET || 'nonna-session-secret';
  const sig = crypto.createHmac('sha256', secret).update(body).digest('base64url');
  return `${body}.${sig}`;
}
app.post('/api/auth/login', async (req, res) => {
  const email = String(req.body?.email || '').trim().toLowerCase();
  const password = typeof req.body?.password === 'string' ? req.body.password : '';
  if (!email || !password) return res.status(400).json({ error: 'email,password required' });
  try {
    const result = await pool.query(
      'SELECT id,restaurant_id,name,email,role,password_hash FROM users WHERE email=lower($1) AND active=true',
      [email]
    );
    const user = result.rows[0];
    if (!user || !await bcrypt.compare(password, user.password_hash)) {
      return res.status(401).json({ error: 'invalid_credentials' });
    }
    await pool.query('UPDATE users SET last_access_at=now() WHERE id=$1', [user.id]);
    return res.json({
      token: issueToken({ uid: user.id, rid: user.restaurant_id, role: user.role }),
      user: { id: user.id, name: user.name, email: user.email, role: user.role }
    });
  } catch (e) {
    console.error('Login failed:', e.message);
    return res.status(503).json({ error: 'database_unavailable' });
  }
});
app.get('/api/config',async(_,res)=>res.json({migration:'in_progress'}));
app.listen(process.env.PORT||10000,()=>console.log('Nonna API listening'));
