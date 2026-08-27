const TENANT = 'nonna-pizzaria';
const arr = v => Array.isArray(v) ? v : Object.entries(v || {}).map(([key, value]) => ({ ...(value && typeof value === 'object' ? value : { value }), key }));
const idOf = (v, key, prefix) => String(v?.id ?? v?.uid ?? v?.key ?? key ?? `${prefix}_${Math.random().toString(36).slice(2)}`);
const num = (v, fallback = 0) => Number.isFinite(Number(v)) ? Number(v) : fallback;
const iso = v => { const d = v ? new Date(typeof v === 'number' ? v : v) : null; return d && !Number.isNaN(d.getTime()) ? d.toISOString() : null; };
const json = v => JSON.stringify(v ?? {});
const statuses = { novo: 'new', preparando: 'preparing', pronto: 'ready', em_entrega: 'out_for_delivery', entregue: 'delivered', cancelado: 'cancelled' };
const safeEmail = (c, id) => String(c.email || `legacy-${id}@nonna.invalid`).toLowerCase().slice(0, 254);
const money = v => Math.max(0, num(v));

/** Import one Firebase export using the supplied pool. The caller owns pool lifecycle. */
export async function migrateFirebase(source, pool) {
  source = source && typeof source === 'object' ? source : {};
  const menu = source.cardapio || source.menu || {};
  const asRecords = (value) => Array.isArray(value)
    ? value.map((v, i) => ({ ...(v && typeof v === 'object' ? v : { value: v }), key: String(v?.key ?? v?.id ?? i) }))
    : Object.entries(value || {}).map(([key, v]) => ({ ...(v && typeof v === 'object' ? v : { value: v }), key }));
  const customers = asRecords(source.clientes || source.customers || source.users || source.usuarios);
  const orders = asRecords(source.pedidos || source.orders);
  const motoboys = asRecords(source.motoboys || source.couriers || source.entregadores);
  const rootEvents = asRecords(source.events || source.eventos || source.orderEvents);
  const products = [];
  for (const [category, values] of Object.entries(menu)) {
    if (!Array.isArray(values) && (!values || typeof values !== 'object')) continue;
    for (const [key, p] of Object.entries(values)) {
      if (!p || typeof p !== 'object' || !('nome' in p || 'name' in p)) continue;
      const price = p.preco ?? p.price ?? (typeof p.preco_base === 'number' ? p.preco_base : 0);
      products.push({ ...p, key, category, price: typeof price === 'object' ? Object.values(price)[0] : price });
    }
  }
  const clientByTel = new Map(customers.map(c => [String(c.tel || c.telefone || '').replace(/\D/g, ''), c]));
  const counts = { restaurant: 0, users: 0, products: 0, customers: 0, orders: 0, orderEvents: 0, couriers: 0 };
  const tx = await pool.connect();
  try {
    await tx.query('BEGIN');
    await tx.query(`INSERT INTO restaurants(id,name) VALUES($1,$2) ON CONFLICT(id) DO UPDATE SET name=EXCLUDED.name`, [TENANT, source.config?.nome || source.config?.name || 'Nonna Pizzaria']); counts.restaurant = 1;
    for (const p of products) {
      const id = idOf(p, p.key, 'product');
      await tx.query(`INSERT INTO products(id,restaurant_id,category,name,description,price,emoji,image_url,active,updated_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,COALESCE($10,now())) ON CONFLICT(id) DO UPDATE SET restaurant_id=EXCLUDED.restaurant_id,category=EXCLUDED.category,name=EXCLUDED.name,description=EXCLUDED.description,price=EXCLUDED.price,emoji=EXCLUDED.emoji,image_url=EXCLUDED.image_url,active=EXCLUDED.active,updated_at=EXCLUDED.updated_at`, [id,TENANT,String(p.category),String(p.nome||p.name),p.descricao||p.description||null,num(p.price),p.emoji||null,p.imagem||p.image||p.image_url||null,p.ativo!==false&&p.active!==false,iso(p.updatedAt)]); counts.products++;
    }
    for (const c of customers) {
      const id = idOf(c, c.key, 'customer'); const name = String(c.nome || c.name || 'Cliente').slice(0, 120);
      await tx.query(`INSERT INTO users(id,restaurant_id,email,name,role,password_hash,active) VALUES($1,$2,$3,$4,'customer',$5,true) ON CONFLICT(id) DO UPDATE SET name=EXCLUDED.name,active=true`, [id,TENANT,safeEmail(c,id),name,'!legacy-import']); counts.users++; counts.customers++; c._dbId = id;
    }
    for (const m of motoboys) {
      const id = idOf(m, m.key, 'courier'); await tx.query(`INSERT INTO users(id,restaurant_id,email,name,role,password_hash,active) VALUES($1,$2,$3,$4,'courier',$5,true) ON CONFLICT(id) DO UPDATE SET name=EXCLUDED.name,active=true`, [id,TENANT,safeEmail(m,id),String(m.nome||m.name||'Entregador').slice(0,120),'!legacy-import']); counts.users++; counts.couriers++; m._dbId=id;
    }
    for (const o of orders) {
      const id=idOf(o,o.key,'order'); const c=o.cliente||o.customer||{}; const tel=String(c.tel||c.telefone||o.telefone||'').replace(/\D/g,''); const known=clientByTel.get(tel); const created=iso(o.createdAt||o.criadoEm||o.created_at)||new Date().toISOString();
      const items=o.itens||o.items||[]; const subtotal=money(o.subtotal ?? o.subTotal ?? o.total); const fee=money(o.taxaEntrega ?? o.deliveryFee ?? o.delivery_fee); const total=money(o.total ?? subtotal+fee);
      await tx.query(`INSERT INTO orders(id,restaurant_id,status,channel,customer,items,subtotal,delivery_fee,total,payment,courier_id,created_at,updated_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$12) ON CONFLICT(id) DO UPDATE SET status=EXCLUDED.status,channel=EXCLUDED.channel,customer=EXCLUDED.customer,items=EXCLUDED.items,subtotal=EXCLUDED.subtotal,delivery_fee=EXCLUDED.delivery_fee,total=EXCLUDED.total,payment=EXCLUDED.payment,courier_id=EXCLUDED.courier_id,updated_at=EXCLUDED.updated_at`, [id,TENANT,statuses[o.status]||o.status||'new',o.channel||'legacy-firebase',json({...c,customerUid:o.customerUid||o.clienteId||(known && known._dbId)||null}),json(items),subtotal,fee,total,json(o.pagamento||o.payment||{}),o.motoboyId||o.courierUid||null,created]); counts.orders++;
      const orderEvents = arr(o.timeline || o.events || []).concat(rootEvents.filter(ev => String(ev.orderId ?? ev.pedidoId ?? ev.order_key ?? '') === String(o.key) || String(ev.orderId ?? '') === id));
      for (const ev of orderEvents) { const eid=`${id}:${idOf(ev,ev.key,'event')}`; await tx.query(`INSERT INTO order_events(id,order_id,status,actor_id,metadata,created_at) VALUES((abs(hashtext($1))::bigint),$2,$3,$4,$5,$6) ON CONFLICT(id) DO NOTHING`,[eid,id,statuses[ev.status]||ev.status||'new',ev.actorId||ev.actor||null,json(ev),iso(ev.timestamp||ev.createdAt)||created]); counts.orderEvents++; }
    }
    await tx.query('COMMIT');
    const verify = await pool.query(`SELECT 'products' entity,count(*)::int count FROM products WHERE restaurant_id=$1 UNION ALL SELECT 'users',count(*)::int FROM users WHERE restaurant_id=$1 UNION ALL SELECT 'orders',count(*)::int FROM orders WHERE restaurant_id=$1 UNION ALL SELECT 'order_events',count(*)::int FROM order_events e JOIN orders o ON o.id=e.order_id WHERE o.restaurant_id=$1`, [TENANT]);
    return { ok:true, tenant:TENANT, source:{products:products.length,customers:customers.length,orders:orders.length,motoboys:motoboys.length}, migrated:counts, verified:Object.fromEntries(verify.rows.map(r=>[r.entity,r.count])) };
  } catch (e) { await tx.query('ROLLBACK').catch(()=>{}); throw e; } finally { tx.release(); }
}
