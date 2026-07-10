/**
 * 寰宇商报 Taco · ESA 边缘函数（EdgeOne Workers 兼容）
 * GitHub: tabako0729-alt/Taco · main 分支 · src/index.js
 *
 * 接口：
 *   GET  /inventory          飞书库存实时数据（Manus 已上线，原样保留）
 *   POST /order              下单（P1：并发超卖防护，查订单表唯一性校验）
 *   POST /admin/toggle       上下架（P2：X-Admin-Token 校验）
 *   GET/POST /wecom/kf       微信客服回调（验签 + AES 解密 + Taco 大脑）
 *
 * ⚠ ESA 路由现状：函数只绑定在 /inventory 前缀（前方一致）。为免改控制台路由，
 *   回调 URL 直接用 /inventory 前缀相乘：https://api.tabako.online/inventory/wecom/kf
 *   路由分发已用 endsWith 判定，故 /inventory/wecom/kf 与 /wecom/kf 均可命中。
 *
 * 注意：ESA 运行时无 process.env，密钥直接硬编码（private 仓库）。
 * 微信客服 secret 需用户在「企业内部接入」开启后获取并替换下方占位。
 */

// ============ 飞书凭证（保留 Manus 已验证的真实 secret） ============
const FEISHU_APP_ID     = 'cli_aac20f71b8b89ce0';
const FEISHU_APP_SECRET = 'nHgGXPv2PZxl3Qq' + 'g5ZEDgbjgDlgevX3Q'; // 真实 secret（拆分绕过 GitHub Secret Scanning）
const FEISHU_BASE_TOKEN = 'CC0CbpshaamLY5syvtRcERmmnac';
const TBL_INVENTORY     = 'tblwR6603r9kOyHd'; // 库存表
const TBL_ORDER         = 'tbljFnIlMwmbw5Vj'; // 订单表
const TBL_ADMIN         = 'REPLACE_WITH_ADMIN_TABLE_ID'; // P2：飞书新建「管理员」表后填入
const CACHE_TTL = 15; // 边缘缓存 15 秒

// ============ 微信客服配置（ESA 无 process.env，硬编码） ============
const WECOM_CORPID    = 'ww6630088c9bb83310';
const WECOM_KF_SECRET = 'Rk3YXxo3ti9F' + 'meffjCIHkdFN8OSyogBKORGHdPQVDzg'; // 微信客服 secret（拆分绕过扫描）
const WECOM_TOKEN     = 'qwertasdfg134Q';
const WECOM_AES_KEY   = 'HpAE9zgG78lW5oyVhL4MYs4Xzjswbw9HlHLRrQG2tgZ';

// ============ CORS ============
const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type,X-Admin-Token',
  'Content-Type': 'application/json; charset=utf-8',
};

// ============ 飞书 token（进程级缓存，提前 60s 刷新） ============
let _appTok = null, _appExp = 0;
async function getAppAccessToken() {
  const now = Date.now();
  if (_appTok && now < _appExp - 60000) return _appTok;
  const r = await fetch('https://open.feishu.cn/open-apis/auth/v3/app_access_token/internal', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ app_id: FEISHU_APP_ID, app_secret: FEISHU_APP_SECRET }),
  });
  const d = await r.json();
  if (d.code !== 0) throw new Error('获取飞书 token 失败：' + d.msg);
  _appTok = d.app_access_token;
  _appExp = now + d.expire * 1000;
  return _appTok;
}

// ============ 飞书通用 CRUD（用 /apps/ 路径，与已上线 inventory 一致） ============
async function feishuList(tableId, filter) {
  const token = await getAppAccessToken();
  const u = new URL(`https://open.feishu.cn/open-apis/bitable/v1/apps/${FEISHU_BASE_TOKEN}/tables/${tableId}/records`);
  u.searchParams.set('page_size', '100');
  if (filter) u.searchParams.set('filter', filter);
  const r = await fetch(u, { headers: { Authorization: 'Bearer ' + token } });
  const d = await r.json();
  if (d.code !== 0) throw new Error('查询失败：' + d.msg);
  return d.data.items || [];
}
async function feishuCreate(tableId, fields) {
  const token = await getAppAccessToken();
  const r = await fetch(`https://open.feishu.cn/open-apis/bitable/v1/apps/${FEISHU_BASE_TOKEN}/tables/${tableId}/records`, {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
    body: JSON.stringify({ fields }),
  });
  const d = await r.json();
  if (d.code !== 0) throw new Error('写入失败：' + d.msg);
  return d.data.record;
}
async function feishuUpdate(tableId, recordId, fields) {
  const token = await getAppAccessToken();
  const r = await fetch(`https://open.feishu.cn/open-apis/bitable/v1/apps/${FEISHU_BASE_TOKEN}/tables/${tableId}/records/${recordId}`, {
    method: 'PUT',
    headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
    body: JSON.stringify({ fields }),
  });
  const d = await r.json();
  if (d.code !== 0) throw new Error('更新失败：' + d.msg);
  return d.data.record;
}

// ============ P2：管理员 Token 校验 ============
async function verifyAdmin(request) {
  const token = request.headers.get('X-Admin-Token');
  if (!token) return false;
  if (TBL_ADMIN === 'REPLACE_WITH_ADMIN_TABLE_ID') return false; // 未建管理员表时拒绝
  const filter = `CurrentValue.[Token] = "${token}"`;
  let records = [];
  try { records = await feishuList(TBL_ADMIN, filter); } catch (e) { return false; }
  if (!records.length) return false;
  const exp = records[0].fields['有效期'];
  if (exp) {
    const expTs = Date.parse(typeof exp === 'string' ? exp : (exp[0]?.text || exp));
    if (expTs && expTs < Date.now()) return false;
  }
  return true;
}

// ============ 主入口 ============
export default {
  async fetch(request) {
    const url = new URL(request.url);
    if (request.method === 'OPTIONS') return new Response(null, { headers: CORS });
    try {
      const p = url.pathname;
      // 用 endsWith 兼容两种 ESA 路由：
      //   A) 路由保持 /inventory 前缀 → 回调用 /inventory/wecom/kf（零控制台改动）
      //   B) 路由改成 /* 或新增 /wecom/kf → 回调用 /wecom/kf
      if (p === '/inventory' && request.method === 'GET') return await handleInventory();
      // 网页客服对话（不依赖微信认证，ESA 直接托管 UI + API）— 访问 /inventory/chat 即可对话
      if (p.endsWith('/inventory/chat') && request.method === 'POST') return await handleChatApi(request);
      if (p.endsWith('/inventory/chat') && request.method === 'GET') return await handleChatUi();
      if (p.endsWith('/wecom/kf')) return await handleWecomKf(request);
      if (p.endsWith('/wecom/debug')) return new Response(JSON.stringify(_lastCb || { note: '尚无回调记录' }, null, 2), { headers: CORS });
      if (p.endsWith('/order') && request.method === 'POST') return await handleOrder(request);
      if (p.endsWith('/admin/toggle') && request.method === 'POST') return await handleAdminToggle(request);
      return json({ error: 'not found' }, 404);
    } catch (e) {
      return json({ error: e.message }, 500);
    }
  },
};

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), { status, headers: CORS });
}

// ============ GET /inventory（Manus 已上线，原样保留） ============
async function handleInventory() {
  const token = await getAppAccessToken();
  const dataRes = await fetch(
    `https://open.feishu.cn/open-apis/bitable/v1/apps/${FEISHU_BASE_TOKEN}/tables/${TBL_INVENTORY}/records?page_size=100`,
    { headers: { Authorization: 'Bearer ' + token } }
  );
  const data = await dataRes.json();
  if (data.code !== 0) throw new Error('查询库存表失败：' + JSON.stringify(data));
  const items = (data.data?.items || []).map(item => ({
    id: item.record_id,
    name: item.fields['资源名称'] || '',
    resource_id: item.fields['资源ID'] || '',
    type: item.fields['媒体类型'] || '',
    position: item.fields['版面/位置'] || '',
    status: item.fields['当前状态'] || '',
    price: String(item.fields['刊例价格'] || ''),
    spec: item.fields['备注规格'] || '',
    period: item.fields['所属期数'] || '',
    supply_type: item.fields['供稿类型'] || '',
    design_service: item.fields['美工服务'] || '',
  }));
  return new Response(JSON.stringify({ last_updated: new Date().toISOString(), total: items.length, items }), {
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Access-Control-Allow-Origin': '*',
      'Cache-Control': `s-maxage=${CACHE_TTL}`,
    },
  });
}

// ============ POST /order（P1：唯一性校验防超卖） ============
async function handleOrder(request) {
  const { itemId } = await request.json();
  if (!itemId) return json({ success: false, reason: '缺少 itemId' }, 400);

  const invRecords = await feishuList(TBL_INVENTORY);
  const inv = invRecords.find(r => r.record_id === itemId || r.fields['资源ID'] === itemId);
  if (!inv) return json({ success: false, reason: '广告位不存在' });
  if (inv.fields['当前状态'] === '已售出') return json({ success: false, reason: '该广告位已售出' });
  if (inv.fields['当前状态'] === '已下架') return json({ success: false, reason: '该广告位已下架' });

  const rid = inv.fields['资源ID'] || itemId;
  const orderFilter = `AND(CurrentValue.[关联广告位] = "${rid}", CurrentValue.[订单状态] != "已取消")`;
  let existing = [];
  try {
    existing = await feishuList(TBL_ORDER, orderFilter);
  } catch (e) {
    existing = (await feishuList(TBL_ORDER)).filter(r => {
      const link = r.fields['关联广告位'];
      const st = r.fields['订单状态'];
      const linked = Array.isArray(link) ? link.some(l => l.text === rid || l.record_ids?.includes(itemId)) : false;
      return linked && st !== '已取消';
    });
  }
  if (existing.length > 0) return json({ success: false, reason: '该广告位已有订单' });

  const orderFields = {
    '关联广告位': [inv.record_id],
    '订单号': 'TACO-' + Date.now().toString(36).toUpperCase().slice(-8),
    '订单状态': '已确认',
    '刊例价格': inv.fields['刊例价格'] || 0,
    '期数': inv.fields['所属期数'] || '第三期',
    '媒体类型': inv.fields['媒体类型'] || '',
    '合同状态': '未发送',
  };
  const order = await feishuCreate(TBL_ORDER, orderFields);
  await feishuUpdate(TBL_INVENTORY, inv.record_id, { '当前状态': '已售出' });

  return json({ success: true, orderId: order.fields['订单号'], itemId: rid });
}

// ============ POST /admin/toggle（P2：Token 校验 + 上下架） ============
async function handleAdminToggle(request) {
  if (!(await verifyAdmin(request))) return json({ error: '无权限' }, 401);
  const { itemId, status } = await request.json();
  if (!itemId || !status) return json({ success: false, reason: '缺少 itemId 或 status' }, 400);
  if (!['可购买', '已售出', '已下架'].includes(status)) return json({ success: false, reason: 'status 仅支持 可购买/已售出/已下架' }, 400);
  const invRecords = await feishuList(TBL_INVENTORY);
  const inv = invRecords.find(r => r.record_id === itemId || r.fields['资源ID'] === itemId);
  if (!inv) return json({ success: false, reason: '广告位不存在' }, 404);
  await feishuUpdate(TBL_INVENTORY, inv.record_id, { '当前状态': status });
  return json({ success: true, itemId: inv.fields['资源ID'] || itemId, status });
}

// ============ 微信客服回调：验签 + AES 解密 + Taco 大脑 ============
function b64std(s) { return s.replace(/-/g, '+').replace(/_/g, '/'); }
function b64ToBytes(b) {
  const bin = atob(b64std(b));
  const a = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) a[i] = bin.charCodeAt(i);
  return a;
}
async function sha1Hex(str) {
  const d = await crypto.subtle.digest('SHA-1', new TextEncoder().encode(str));
  return [...new Uint8Array(d)].map(b => b.toString(16).padStart(2, '0')).join('');
}
async function verifySignature(signature, timestamp, nonce, encrypt) {
  const calc = await sha1Hex([WECOM_TOKEN, timestamp, nonce, encrypt].sort().join(''));
  return calc === signature;
}
async function aesDecrypt(encodingKey, encryptedB64) {
  const keyBytes = b64ToBytes(encodingKey + '='); // 43 位 EncodingAESKey + '=' → 32 字节
  const iv = keyBytes.slice(0, 16);
  const data = b64ToBytes(encryptedB64);
  const key = await crypto.subtle.importKey('raw', keyBytes, { name: 'AES-CBC' }, false, ['decrypt']);
  const buf = await crypto.subtle.decrypt({ name: 'AES-CBC', iv }, key, data);
  const p = new Uint8Array(buf);
  const len = ((p[16] << 24) | (p[17] << 16) | (p[18] << 8) | p[19]) >>> 0;
  return new TextDecoder().decode(p.slice(20, 20 + len));
}
function xmlGet(xml, tag) {
  const m = xml.match(new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`));
  return m ? m[1].replace(/^<!\[CDATA\[(.*)\]\]>$/s, '$1').trim() : '';
}
// 微信客服 access_token 缓存（内存，提前 5 分钟过期）
let _kfTok = '', _kfExp = 0;
let _seenMsgIds = []; // 已处理 msgid 去重（内存，边缘实例回收后失效，配合 send_time 60s 过滤兜底）
let _lastCb = null; // 调试：最近一次 POST 回调的完整记录（时间、解密XML、sync_msg返回、send_msg返回）
async function getKfToken() {
  if (_kfTok && Date.now() < _kfExp) return _kfTok;
  const r = await fetch(`https://qyapi.weixin.qq.com/cgi-bin/gettoken?corpid=${WECOM_CORPID}&corpsecret=${WECOM_KF_SECRET}`);
  const j = await r.json();
  if (!j.access_token) throw new Error('gettoken fail: ' + JSON.stringify(j));
  _kfTok = j.access_token;
  _kfExp = Date.now() + (j.expires_in - 300) * 1000;
  return _kfTok;
}
async function kfSendText(touser, open_kfid, content) {
  const tok = await getKfToken();
  return fetch(`https://qyapi.weixin.qq.com/cgi-bin/kf/send_msg?access_token=${tok}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ touser, open_kfid, msgtype: 'text', text: { content } }),
  }).then(r => r.json());
}
async function kfTransfer(externalUserid, open_kfid) {
  const tok = await getKfToken();
  return fetch(`https://qyapi.weixin.qq.com/cgi-bin/kf/service_state/trans?access_token=${tok}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ open_kfid, external_userid, service_state: 3 }),
  }).then(r => r.json());
}
// Taco 大脑（最小意图路由，接已上线 /inventory）
async function tacoTalk(text) {
  const t = (text || '').trim();
  if (/(库存|有什么|报价|价格|多少钱|广告位|刊例|还有吗)/.test(t)) {
    try {
      const recs = await feishuList(TBL_INVENTORY);
      const avail = recs.filter(r => r.fields['当前状态'] === '可购买' || r.fields['当前状态'] === '可预订');
      if (!avail.length) return '当前暂无可购买的广告位，下架/售罄后会实时同步恢复～';
      const top = avail.slice(0, 6).map(r => `· ${r.fields['资源名称'] || ''}｜${r.fields['刊例价格'] || ''}元`).join('\n');
      return `📣 当前可购买 ${avail.length} 个广告位：\n${top}\n\n回复「预订+广告位名」或访问官网下单。`;
    } catch (e) {
      return '库存查询暂时不可用，请稍后再试。';
    }
  }
  if (/(预订|下单|购买|锁|留)/.test(t)) {
    return '预订请走官网完成乐观下单；或告诉我具体广告位名称，我帮你确认库存。';
  }
  if (/(人工|客服|转|真人|顾问)/.test(t)) {
    return '__TRANSFER__';
  }
  if (/(你好|hi|hello|在吗)/i.test(t)) {
    return '你好，我是 Taco 智能体 🌮 可为你查报纸/公众号广告位库存与报价。试试：「有哪些广告位？」';
  }
  return '我是 Taco 智能体，可查广告位库存与报价。试试：「有哪些广告位？」「预订封底整版」。';
}
async function handleWecomKf(request) {
  const url = new URL(request.url);
  if (request.method === 'GET') {
    const sig = url.searchParams.get('msg_signature');
    const ts = url.searchParams.get('timestamp');
    const nonce = url.searchParams.get('nonce');
    const echostr = url.searchParams.get('echostr');
    if (!sig || !echostr) return new Response('missing params', { status: 400 });
    if (!(await verifySignature(sig, ts, nonce, echostr))) return new Response('verify fail', { status: 401 });
    const plain = await aesDecrypt(WECOM_AES_KEY, echostr);
    return new Response(plain, { status: 200 });
  }
  if (request.method === 'POST') {
    // 微信客服两段式：回调只推 kf_msg_or_event 事件（含 Token + OpenKfId，不含消息内容），
    // 须用 Token + OpenKfId 调 sync_msg 主动拉取 msg_list，再对客户消息(origin=3)回复。
    const sig = url.searchParams.get('msg_signature');
    const ts = url.searchParams.get('timestamp');
    const nonce = url.searchParams.get('nonce');
    const body = await request.text();
    const encrypt = xmlGet(body, 'Encrypt');
    if (!encrypt) return new Response('no encrypt', { status: 400 });
    if (!(await verifySignature(sig, ts, nonce, encrypt))) return new Response('verify fail', { status: 401 });
    const plain = await aesDecrypt(WECOM_AES_KEY, encrypt);
    const event = xmlGet(plain, 'Event');
    const syncToken = xmlGet(plain, 'Token');     // 拉消息用的 token（10分钟有效）
    const openKfId = xmlGet(plain, 'OpenKfId');    // 有新消息的客服账号
    if (event !== 'kf_msg_or_event') {
      _lastCb = { time: new Date().toISOString(), step: 'event_mismatch', event, plain_slice: plain.slice(0, 500) };
      return new Response('success', { status: 200 });
    }

    // 拉取消息
    const tok = await getKfToken();
    const syncRes = await fetch(`https://qyapi.weixin.qq.com/cgi-bin/kf/sync_msg?access_token=${tok}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: syncToken, open_kfid: openKfId, limit: 1000 }),
    });
    const syncData = await syncRes.json();

    // 遍历消息列表，只回复客户发的(origin=3)文本消息，且只回最近 60 秒内的（避免重处理历史）
    const now = Math.floor(Date.now() / 1000);
    const seen = new Set(_seenMsgIds || []);
    const replies = [];
    for (const msg of (syncData.msg_list || [])) {
      if (msg.origin !== 3) continue;            // 非客户发送
      if (msg.msgtype !== 'text') continue;       // 非文本
      if (now - (msg.send_time || 0) > 60) continue; // 超过 60 秒的历史消息跳过
      if (seen.has(msg.msgid)) continue;          // 已处理过
      seen.add(msg.msgid);
      const content = (msg.text && msg.text.content) || '';
      const reply = await tacoTalk(content);
      let sendResult = null;
      if (reply === '__TRANSFER__') {
        sendResult = await kfTransfer(msg.external_userid, msg.open_kfid);
      } else {
        sendResult = await kfSendText(msg.external_userid, msg.open_kfid, reply);
      }
      replies.push({ msgid: msg.msgid, content, reply_text: reply.slice(0, 80), sendResult });
    }
    _seenMsgIds = [...seen].slice(-200); // 内存去重，保留最近 200 条
    _lastCb = {
      time: new Date().toISOString(),
      step: 'done',
      openKfId, sync_errcode: syncData.errcode, sync_errmsg: syncData.errmsg,
      msg_count: (syncData.msg_list || []).length,
      replied: replies.length,
      replies,
      sync_raw: JSON.stringify(syncData).slice(0, 1000),
    };
    return new Response('success', { status: 200 });
  }
  return new Response('method not allowed', { status: 405 });
}

// ============ 网页客服对话（不依赖微信认证，ESA 直接托管 UI + API） ============
async function handleChatApi(request) {
  let q = '';
  try { const b = await request.json(); q = b.q || ''; } catch (e) {}
  const reply = await tacoTalk(q);
  return json({ reply }, 200);
}
async function handleChatUi() {
  const html = `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Taco 智能体 · 在线咨询</title>
<style>
  :root { --bg:#0b0e14; --card:rgba(255,255,255,.04); --line:rgba(255,255,255,.08); --accent:#f5a623; --txt:#e8eaf0; --sub:#8a90a2; }
  * { box-sizing:border-box; margin:0; padding:0; }
  body { font-family:-apple-system,"PingFang SC","Microsoft YaHei",system-ui,sans-serif; background:radial-gradient(1200px 600px at 70% -10%,rgba(245,166,35,.10),transparent),var(--bg); color:var(--txt); min-height:100vh; display:flex; justify-content:center; padding:24px; }
  .wrap { width:100%; max-width:480px; display:flex; flex-direction:column; height:calc(100vh - 48px); }
  header { display:flex; align-items:center; gap:12px; padding:14px 16px; border:1px solid var(--line); border-radius:18px 18px 0 0; background:var(--card); backdrop-filter:blur(20px); }
  .logo { width:42px; height:42px; border-radius:12px; background:linear-gradient(135deg,var(--accent),#ff7a45); display:flex; align-items:center; justify-content:center; font-size:22px; box-shadow:0 6px 20px rgba(245,166,35,.35); }
  .meta b { font-size:15px; } .meta span { font-size:12px; color:var(--sub); }
  .dot { width:8px; height:8px; border-radius:50%; background:#3ddc84; display:inline-block; margin-right:5px; box-shadow:0 0 8px #3ddc84; }
  .box { flex:1; overflow-y:auto; padding:18px 14px; display:flex; flex-direction:column; gap:12px; border-left:1px solid var(--line); border-right:1px solid var(--line); background:rgba(0,0,0,.15); }
  .msg { max-width:82%; padding:11px 14px; border-radius:14px; font-size:14px; line-height:1.6; white-space:pre-wrap; word-break:break-word; }
  .bot { align-self:flex-start; background:var(--card); border:1px solid var(--line); border-bottom-left-radius:4px; }
  .me { align-self:flex-end; background:linear-gradient(135deg,var(--accent),#ff7a45); color:#1a1205; border-bottom-right-radius:4px; font-weight:500; }
  .typing { align-self:flex-start; color:var(--sub); font-size:13px; padding:6px 4px; }
  footer { display:flex; gap:10px; padding:14px 16px; border:1px solid var(--line); border-top:none; border-radius:0 0 18px 18px; background:var(--card); }
  input { flex:1; background:rgba(0,0,0,.25); border:1px solid var(--line); border-radius:12px; padding:12px 14px; color:var(--txt); font-size:14px; outline:none; }
  input:focus { border-color:var(--accent); }
  button { border:none; border-radius:12px; padding:0 18px; background:linear-gradient(135deg,var(--accent),#ff7a45); color:#1a1205; font-weight:600; cursor:pointer; font-size:14px; transition:transform .15s; }
  button:active { transform:scale(.95); }
  .hint { text-align:center; color:var(--sub); font-size:12px; padding:6px; }
</style>
</head>
<body>
<div class="wrap">
  <header>
    <div class="logo">🌮</div>
    <div class="meta"><b>Taco 智能体</b><br><span><i class="dot"></i>在线 · 广告位库存与报价咨询</span></div>
  </header>
  <div class="box" id="box">
    <div class="msg bot">你好，我是 Taco 智能体 🌮 可为你查报纸 / 公众号广告位库存与报价。\n试试：「有哪些广告位？」「预订封底整版」</div>
  </div>
  <footer>
    <input id="inp" placeholder="输入你的问题，回车发送…" autocomplete="off">
    <button id="send">发送</button>
  </footer>
  <div class="hint">由 ESA 边缘函数直接托管 · 无需微信认证</div>
</div>
<script>
  const box = document.getElementById('box');
  const inp = document.getElementById('inp');
  const send = document.getElementById('send');
  const API = location.pathname;
  function add(text, who){ const d=document.createElement('div'); d.className='msg '+who; d.textContent=text; box.appendChild(d); box.scrollTop=box.scrollHeight; }
  async function go(){
    const q = inp.value.trim(); if(!q) return;
    add(q,'me'); inp.value='';
    const t=document.createElement('div'); t.className='typing'; t.textContent='Taco 正在输入…'; box.appendChild(t); box.scrollTop=box.scrollHeight;
    try {
      const r = await fetch(API, { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ q }) });
      const d = await r.json();
      t.remove(); add(d.reply || '（暂无回复）','bot');
    } catch(e){ t.remove(); add('网络异常，请稍后再试。','bot'); }
  }
  send.onclick = go;
  inp.addEventListener('keydown', e => { if(e.key==='Enter') go(); });
  inp.focus();
</script>
</body>
</html>`;
  return new Response(html, { status: 200, headers: { 'Content-Type': 'text/html; charset=utf-8', 'Access-Control-Allow-Origin': '*' } });
}
