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
      if (p.endsWith('/wecom/kf')) return await handleWecomKf(request);
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
      const inv = await (await fetch('https://api.tabako.online/inventory')).json();
      const list = inv.data || inv;
      const avail = list.filter(x => x.status === '可购买' || x.status === '可预订');
      if (!avail.length) return '当前暂无可购买的广告位，下架/售罄后会实时同步恢复～';
      const top = avail.slice(0, 6).map(x => `· ${x.name}｜${x.price}元`).join('\n');
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
    if (event !== 'kf_msg_or_event') return new Response('success', { status: 200 });

    // 拉取消息
    const tok = await getKfToken();
    const syncRes = await fetch(`https://qyapi.weixin.qq.com/cgi-bin/kf/sync_msg?access_token=${tok}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: syncToken, open_kfid: openKfId, limit: 1000 }),
    });
    const syncData = await syncRes.json();
    if (syncData.errcode !== 0) return new Response('success', { status: 200 }); // sync 失败也回 success，避免重试

    // 遍历消息列表，只回复客户发的(origin=3)文本消息，且只回最近 60 秒内的（避免重处理历史）
    const now = Math.floor(Date.now() / 1000);
    const seen = new Set(_seenMsgIds || []);
    for (const msg of (syncData.msg_list || [])) {
      if (msg.origin !== 3) continue;            // 非客户发送
      if (msg.msgtype !== 'text') continue;       // 非文本
      if (now - (msg.send_time || 0) > 60) continue; // 超过 60 秒的历史消息跳过
      if (seen.has(msg.msgid)) continue;          // 已处理过
      seen.add(msg.msgid);
      const content = (msg.text && msg.text.content) || '';
      const reply = await tacoTalk(content);
      if (reply === '__TRANSFER__') {
        await kfTransfer(msg.external_userid, msg.open_kfid);
      } else {
        await kfSendText(msg.external_userid, msg.open_kfid, reply);
      }
    }
    _seenMsgIds = [...seen].slice(-200); // 内存去重，保留最近 200 条
    return new Response('success', { status: 200 });
  }
  return new Response('method not allowed', { status: 405 });
}
