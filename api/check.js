// Vercel serverless function: POST /api/check  { text?, image? (data URL) }  →  { answer }
// Talks to a published Dify web app on the server side only.
//
// Required environment variable:
//   DIFY_APP_CODE   the Dify web app code (it *is* the credit — never ship it to the browser)
// Optional:
//   DIFY_WEB_API    default https://udify.app/api
//   RATE_LIMIT_MAX  max requests per IP per window (default 8)
//   RATE_LIMIT_WIN  window in seconds (default 60)

const CODE = process.env.DIFY_APP_CODE || '';
const API = (process.env.DIFY_WEB_API || 'https://udify.app/api').replace(/\/$/, '');
const RL_MAX = Number(process.env.RATE_LIMIT_MAX || 8);
const RL_WIN = Number(process.env.RATE_LIMIT_WIN || 60) * 1000;

const MAX_TEXT = 8000;
const MAX_IMAGE_BYTES = 3.2 * 1024 * 1024; // Vercel body limit is 4.5 MB; data URL inflates ~33%

// ---- Rate limit: per-instance in-memory sliding window ----
// Not global, but enough to stop a single client from draining the Dify quota.
const hits = new Map();

function clientIP(req) {
  const fwd = req.headers['x-forwarded-for'];
  if (typeof fwd === 'string' && fwd) return fwd.split(',')[0].trim();
  return req.headers['x-real-ip'] || req.socket?.remoteAddress || 'unknown';
}

function rateLimited(ip) {
  const now = Date.now();
  const recent = (hits.get(ip) || []).filter((t) => now - t < RL_WIN);
  if (recent.length >= RL_MAX) {
    hits.set(ip, recent);
    return Math.ceil((RL_WIN - (now - recent[0])) / 1000);
  }
  recent.push(now);
  hits.set(ip, recent);
  if (hits.size > 5000) {
    for (const [k, v] of hits) if (!v.some((t) => now - t < RL_WIN)) hits.delete(k);
  }
  return 0;
}

// ---- Passport cache: reuse the visitor token for the instance lifetime ----
let cached = null; // { token, exp }

async function passport() {
  if (cached && cached.exp > Date.now()) return cached.token;
  const p = await fetch(`${API}/passport`, { headers: { 'X-App-Code': CODE } });
  if (!p.ok) throw new Error('查证服务凭证获取失败（' + p.status + '）');
  const { access_token } = await p.json();
  if (!access_token) throw new Error('查证服务凭证为空');
  cached = { token: access_token, exp: Date.now() + 5 * 60 * 1000 };
  return access_token;
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: '只支持 POST' });
  }

  if (!CODE) {
    console.error('DIFY_APP_CODE is not set');
    return res.status(503).json({ error: '查证服务未配置，请联系站点管理员。' });
  }

  const wait = rateLimited(clientIP(req));
  if (wait) {
    res.setHeader('Retry-After', String(wait));
    return res.status(429).json({ error: `请求太频繁，请 ${wait} 秒后再试。` });
  }

  try {
    const { text = '', image } = req.body || {};
    const q = String(text).slice(0, MAX_TEXT);
    if (!q.trim() && !image) return res.status(400).json({ error: '请提供文字或截图' });

    const auth = { 'X-App-Code': CODE, 'X-App-Passport': await passport() };

    let files = [];
    if (image) {
      const m = /^data:(image\/[\w+.-]+);base64,([A-Za-z0-9+/=]+)$/.exec(String(image));
      if (!m) return res.status(400).json({ error: '图片格式不正确' });
      const buf = Buffer.from(m[2], 'base64');
      if (buf.length > MAX_IMAGE_BYTES) return res.status(413).json({ error: '截图太大，请压缩后再试' });

      const ext = m[1].split('/')[1].replace('jpeg', 'jpg').replace(/[^a-z0-9]/gi, '') || 'png';
      const form = new FormData();
      form.append('file', new Blob([buf], { type: m[1] }), `screenshot.${ext}`);
      const up = await fetch(`${API}/files/upload`, { method: 'POST', headers: auth, body: form });
      const uj = await up.json().catch(() => ({}));
      if (!up.ok) {
        // An expired token is the common cause; drop the cache so the next call re-auths.
        if (up.status === 401 || up.status === 403) cached = null;
        throw new Error('截图上传失败：' + (uj.message || up.status));
      }
      files = [{ type: 'image', transfer_method: 'local_file', upload_file_id: uj.id, url: '' }];
    }

    const r = await fetch(`${API}/chat-messages`, {
      method: 'POST',
      headers: { ...auth, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        inputs: {},
        query: q.trim() || '请核查这张截图',
        response_mode: 'streaming',
        conversation_id: '',
        files,
      }),
    });
    if (!r.ok) {
      if (r.status === 401 || r.status === 403) cached = null;
      throw new Error('查证服务调用失败（' + r.status + '）');
    }

    const raw = await r.text();
    let answer = '';
    let error = '';
    for (const line of raw.split('\n')) {
      if (!line.startsWith('data:')) continue;
      let e;
      try {
        e = JSON.parse(line.slice(5));
      } catch {
        continue;
      }
      if (e.event === 'message' || e.event === 'agent_message') answer += e.answer || '';
      if (e.event === 'message_replace') answer = e.answer || '';
      if (e.event === 'error') error = e.message || '查证流程出错';
    }
    if (!answer && error) throw new Error(error);
    if (!answer) throw new Error('查证服务没有返回内容');

    return res.status(200).json({ answer });
  } catch (e) {
    console.error(e);
    return res.status(502).json({ error: e.message || '查证服务暂时不可用' });
  }
}
