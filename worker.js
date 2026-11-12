/**
 * coc-notify 推送服务
 * 部署到 Cloudflare Workers，绑定 KV（变量名 SUBS），开一个每分钟的 Cron。
 *
 * 接口：
 *   POST /sub    { subscription, items }   首次订阅并写入待办
 *   POST /sync   { endpoint, items }       更新待办
 *   POST /test   { endpoint }              立刻发一条测试通知
 *   GET  /                                  健康检查
 */

const VAPID_PUBLIC = 'BNrhP8Q3U6bft3Hed1Ipi2HoQ8Uu4v0nj81oxo8SNUJbNp_RlKcNMP0jUwSKuHlZ0ArqdAyJJ_SHdjXtvVGn3O0';
const VAPID_X = '2uE_xDdTpt-3cd53UimLYehDxS7i_SePzWjGjxI1Qls';
const VAPID_Y = 'Np_RlKcNMP0jUwSKuHlZ0ArqdAyJJ_SHdjXtvVGn3O0';
/* 私钥不写在代码里，部署时在 Worker 设置里加一个 Secret：VAPID_D */
const VAPID_SUB = 'mailto:dosomethingforme@163.com';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Max-Age': '86400',
};

const enc = new TextEncoder();

function b64uToU8(s) {
  const t = s.replace(/-/g, '+').replace(/_/g, '/');
  const pad = t.length % 4 ? 4 - (t.length % 4) : 0;
  const bin = atob(t + '='.repeat(pad));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function u8ToB64u(u8) {
  let bin = '';
  for (let i = 0; i < u8.length; i++) bin += String.fromCharCode(u8[i]);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function concat(...arrs) {
  const len = arrs.reduce((n, a) => n + a.length, 0);
  const out = new Uint8Array(len);
  let off = 0;
  for (const a of arrs) { out.set(a, off); off += a.length; }
  return out;
}

async function hkdf(salt, ikm, info, len) {
  const key = await crypto.subtle.importKey('raw', ikm, 'HKDF', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt, info }, key, len * 8);
  return new Uint8Array(bits);
}

function trimLeading(u8) {
  let i = 0;
  while (i < u8.length - 1 && u8[i] === 0) i++;
  return u8.slice(i);
}

function derToRaw(der) {
  const b = new Uint8Array(der);
  let i = 1;
  if (b[i] & 0x80) i += 1 + (b[i] & 0x7f);
  i += 1;
  i += 1;
  const rLen = b[i++];
  const r = trimLeading(b.slice(i, i + rLen));
  i += rLen + 1;
  const sLen = b[i++];
  const s = trimLeading(b.slice(i, i + sLen));
  const out = new Uint8Array(64);
  out.set(r, 32 - r.length);
  out.set(s, 64 - s.length);
  return out;
}

async function vapidHeader(endpoint, env) {
  const aud = new URL(endpoint).origin;
  const h = u8ToB64u(enc.encode(JSON.stringify({ typ: 'JWT', alg: 'ES256' })));
  const p = u8ToB64u(enc.encode(JSON.stringify({
    aud,
    exp: Math.floor(Date.now() / 1000) + 43200,
    sub: VAPID_SUB,
  })));
  const jwk = { kty: 'EC', crv: 'P-256', x: VAPID_X, y: VAPID_Y, d: env.VAPID_D };
  const key = await crypto.subtle.importKey(
    'jwk', jwk, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign'],
  );
  const sig = await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, key, enc.encode(h + '.' + p));
  return 'vapid t=' + h + '.' + p + '.' + u8ToB64u(derToRaw(sig)) + ', k=' + VAPID_PUBLIC;
}

async function encryptPayload(sub, payloadObj) {
  const uaPub = b64uToU8(sub.keys.p256dh);
  const authSecret = b64uToU8(sub.keys.auth);

  const as = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
  const asPub = new Uint8Array(await crypto.subtle.exportKey('raw', as.publicKey));
  const uaKey = await crypto.subtle.importKey('raw', uaPub, { name: 'ECDH', namedCurve: 'P-256' }, false, []);
  const shared = new Uint8Array(
    await crypto.subtle.deriveBits({ name: 'ECDH', public: uaKey }, as.privateKey, 256),
  );

  const authInfo = concat(enc.encode('WebPush: info\u0000'), uaPub, asPub);
  const ikm = await hkdf(authSecret, shared, authInfo, 32);
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const cek = await hkdf(salt, ikm, enc.encode('Content-Encoding: aes128gcm\u0000'), 16);
  const nonce = await hkdf(salt, ikm, enc.encode('Content-Encoding: nonce\u0000'), 12);

  const rs = new Uint8Array(4);
  new DataView(rs.buffer).setUint32(0, 4096);
  const header = concat(salt, rs, new Uint8Array([asPub.length]), asPub);

  const plain = concat(enc.encode(JSON.stringify(payloadObj)), new Uint8Array([2]));
  const cekKey = await crypto.subtle.importKey('raw', cek, 'AES-GCM', false, ['encrypt']);
  const ct = new Uint8Array(await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv: nonce, additionalData: header }, cekKey, plain,
  ));

  return concat(header, ct);
}

async function sendPush(sub, data, env) {
  try {
    const body = await encryptPayload(sub, data);
    const res = await fetch(sub.endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/octet-stream',
        'Content-Encoding': 'aes128gcm',
        'TTL': '86400',
        'Urgency': 'high',
        'Authorization': await vapidHeader(sub.endpoint, env),
      },
      body,
      signal: AbortSignal.timeout(8000),
    });
    return res.status;
  } catch (e) {
    return 599;
  }
}

function keyOf(endpoint) {
  return 's_' + u8ToB64u(enc.encode(endpoint)).slice(-40);
}

function json(obj, status) {
  return new Response(JSON.stringify(obj), {
    status: status || 200,
    headers: Object.assign({ 'Content-Type': 'application/json; charset=utf-8' }, CORS),
  });
}

async function readBody(req) {
  const text = await req.text();
  if (!text) return {};
  try { return JSON.parse(text); } catch (e) { return null; }
}

export default {
  async fetch(req, env) {
    if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });

    const url = new URL(req.url);
    const path = url.pathname.replace(/\/+$/, '') || '/';

    if (req.method === 'GET' && path === '/') {
      let cron = null;
      let subs = 0;
      try {
        cron = await env.SUBS.get('__last', 'json');
        const list = await env.SUBS.list();
        subs = list.keys.filter((k) => k.name !== '__last').length;
      } catch (e) {}
      return json({ ok: true, service: 'coc-notify push', time: Date.now(), subs, cron });
    }

    if (req.method !== 'POST') return json({ ok: false, error: 'method not allowed' }, 405);

    const body = await readBody(req);
    if (!body) return json({ ok: false, error: 'bad json' }, 400);

    if (path === '/sub') {
      const { subscription, items } = body;
      if (!subscription || !subscription.endpoint) return json({ ok: false, error: 'no subscription' }, 400);
      const key = keyOf(subscription.endpoint);
      await env.SUBS.put(key, JSON.stringify({
        sub: subscription,
        items: Array.isArray(items) ? items : [],
        updated: Date.now(),
      }));
      return json({ ok: true, key });
    }

    if (path === '/sync') {
      const { endpoint, items } = body;
      if (!endpoint) return json({ ok: false, error: 'no endpoint' }, 400);
      const key = keyOf(endpoint);
      const rec = await env.SUBS.get(key, 'json');
      if (!rec) return json({ ok: false, error: 'not subscribed' }, 404);
      rec.items = Array.isArray(items) ? items : [];
      rec.updated = Date.now();
      await env.SUBS.put(key, JSON.stringify(rec));
      return json({ ok: true, count: rec.items.length });
    }

    if (path === '/test') {
      const { endpoint } = body;
      if (!endpoint) return json({ ok: false, error: 'no endpoint' }, 400);
      const key = keyOf(endpoint);
      const rec = await env.SUBS.get(key, 'json');
      if (!rec) return json({ ok: false, error: 'not subscribed' }, 404);
      const status = await sendPush(rec.sub, {
        title: '推送已就通',
        body: '到点会像这样提醒你。',
        tag: 'test',
        url: '/',
      }, env);
      return json({ ok: status < 300, status, error: status < 300 ? undefined : ('apple status ' + status) });
    }

    return json({ ok: false, error: 'not found' }, 404);
  },

  async scheduled(event, env, ctx) {
    const now = Math.floor(Date.now() / 1000);
    const list = await env.SUBS.list();
    await env.SUBS.put('__last', JSON.stringify({ at: Date.now(), subs: list.keys.length }));
    for (const k of list.keys) {
      if (k.name === '__last') continue;
      const rec = await env.SUBS.get(k.name, 'json');
      if (!rec || !rec.sub || !Array.isArray(rec.items) || !rec.items.length) continue;

      const due = rec.items.filter((it) => it.at <= now + 20);
      if (!due.length) continue;

      let status = 0;
      for (const item of due) {
        status = await sendPush(rec.sub, {
          title: item.title,
          body: item.body || '',
          tag: item.id,
          url: '/',
        }, env);
      }

      if (status === 404 || status === 410) {
        await env.SUBS.delete(k.name);
        continue;
      }

      rec.items = rec.items.filter((it) => it.at > now + 20);
      await env.SUBS.put(k.name, JSON.stringify(rec));
    }
  },
};
