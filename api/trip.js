// Vercel serverless function: stores each trip in Redis under its share code and merges concurrent edits.
// Needs a Redis REST store connected to the project (Vercel → Storage → Upstash Redis). Env vars are read automatically.
const CODE = /^[A-Z2-9]{8}$/;
const URL_ = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
const TOK = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;

async function redis(cmd) {
  const r = await fetch(URL_, {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + TOK, 'Content-Type': 'application/json' },
    body: JSON.stringify(cmd),
  });
  const j = await r.json();
  if (j.error) throw new Error(j.error);
  return j.result;
}

const arr = (x) => (Array.isArray(x) ? x : []);
const obj = (x) => (x && typeof x === 'object' && !Array.isArray(x) ? x : {});
const str = (x, n = 200) => String(x == null ? '' : x).slice(0, n);

function clean(t) {
  t = obj(t);
  return {
    id: str(t.id, 64),
    code: str(t.code, 8),
    name: str(t.name) || 'My trip',
    start: str(t.start, 10),
    end: str(t.end, 10),
    metaTs: Number(t.metaTs) || 0,
    members: arr(t.members).map((m) => str(m, 60)).filter(Boolean),
    mts: obj(t.mts),
    cats: Object.fromEntries(
      Object.entries(obj(t.cats))
        .filter(([k, v]) => /^[^'"`\\<>&]{1,20}$/.test(k) && v && typeof v.i === 'string')
        .map(([k, v]) => [k, { i: str(v.i, 8).replace(/[<>&"'`\\]/g, ''), ts: Number(v.ts) || 0 }])
    ),
    budgets: obj(t.budgets),
    bts: obj(t.bts),
    expenses: arr(t.expenses).filter((e) => e && typeof e.id === 'string' && isFinite(e.amount)),
    deposits: arr(t.deposits).filter((d) => d && typeof d.id === 'string' && isFinite(d.amount)),
    del: obj(t.del),
  };
}

// Keep in sync with mergeTrips() in index.html
function merge(a, b) {
  const r = { id: a.id, code: a.code || b.code };
  const m = (b.metaTs || 0) > (a.metaTs || 0) ? b : a;
  r.name = m.name; r.start = m.start; r.end = m.end; r.metaTs = m.metaTs || 0;
  r.del = { ...(a.del || {}) };
  for (const k in b.del || {}) r.del[k] = Math.max(r.del[k] || 0, b.del[k]);
  const alive = (k, ts) => !(k in r.del) || r.del[k] < (ts || 0);
  const recs = (la, lb, p) => {
    const map = new Map();
    for (const x of [...(la || []), ...(lb || [])]) {
      const cur = map.get(x.id);
      if (!cur || (x.ts || 0) > (cur.ts || 0)) map.set(x.id, x);
    }
    return [...map.values()].filter((x) => alive(p + x.id, x.ts));
  };
  r.expenses = recs(a.expenses, b.expenses, 'e:');
  r.deposits = recs(a.deposits, b.deposits, 'd:');
  r.mts = { ...(a.mts || {}) };
  for (const k in b.mts || {}) r.mts[k] = Math.max(r.mts[k] || 0, b.mts[k]);
  const names = [...(a.members || [])];
  for (const n of b.members || []) if (!names.includes(n)) names.push(n);
  r.members = names.filter((n) => alive('m:' + n, r.mts[n] || 1));
  r.cats = {};
  for (const x of [a.cats || {}, b.cats || {}]) for (const k in x) { const c = r.cats[k]; if (!c || (x[k].ts || 0) > (c.ts || 0)) r.cats[k] = x[k]; }
  for (const k in r.cats) if (!alive('c:' + k, r.cats[k].ts)) delete r.cats[k];
  r.budgets = {}; r.bts = {};
  const keys = new Set([...Object.keys(a.budgets || {}), ...Object.keys(b.budgets || {}), ...Object.keys(a.bts || {}), ...Object.keys(b.bts || {})]);
  for (const k of keys) {
    const ta = (a.bts || {})[k] || 0, tb = (b.bts || {})[k] || 0;
    const src = tb > ta ? b : ta > tb ? a : k in (a.budgets || {}) ? a : b;
    if (src.budgets && k in src.budgets) r.budgets[k] = src.budgets[k];
    if (Math.max(ta, tb)) r.bts[k] = Math.max(ta, tb);
  }
  return r;
}

module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  if (!URL_ || !TOK) return res.status(503).json({ error: 'not_configured' });
  try {
    if (req.method === 'GET') {
      const code = String(req.query.code || '').toUpperCase();
      if (!CODE.test(code)) return res.status(400).json({ error: 'bad_code' });
      const raw = await redis(['GET', 'trip:' + code]);
      if (!raw) return res.status(404).json({ error: 'not_found' });
      return res.status(200).json({ trip: JSON.parse(raw) });
    }
    if (req.method === 'POST') {
      let body = req.body;
      if (typeof body === 'string') body = JSON.parse(body);
      const code = String((body && body.code) || '').toUpperCase();
      if (!CODE.test(code)) return res.status(400).json({ error: 'bad_code' });
      if (!body.trip || typeof body.trip !== 'object') return res.status(400).json({ error: 'bad_trip' });
      const incoming = clean(body.trip);
      incoming.code = code;
      const raw = await redis(['GET', 'trip:' + code]);
      const merged = raw ? merge(clean(JSON.parse(raw)), incoming) : incoming;
      merged.code = code;
      const out = JSON.stringify(merged);
      if (out.length > 900000) return res.status(413).json({ error: 'too_large' });
      await redis(['SET', 'trip:' + code, out]);
      return res.status(200).json({ trip: merged });
    }
    return res.status(405).json({ error: 'method' });
  } catch (e) {
    return res.status(500).json({ error: 'server' });
  }
};
