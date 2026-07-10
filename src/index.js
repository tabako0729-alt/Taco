/**
 * 飞书库存代理 - ESA 边缘函数
 * 为 tabako.online 提供实时广告位库存查询接口
 * 密钥通过环境变量注入，不进代码
 */

const CACHE_TTL = 15; // 边缘缓存15秒

export default {
  async fetch(request, env) {
    // 处理 CORS 预检请求
    if (request.method === 'OPTIONS') {
      return new Response(null, {
        headers: {
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Methods': 'GET, OPTIONS',
          'Access-Control-Allow-Headers': 'Content-Type',
        }
      });
    }

    try {
      // 第一步：获取飞书 tenant_access_token
      const tokenRes = await fetch(
        'https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            app_id: env.FEISHU_APP_ID,
            app_secret: env.FEISHU_APP_SECRET
          })
        }
      );
      const tokenData = await tokenRes.json();
      const token = tokenData.tenant_access_token;

      if (!token) {
        throw new Error('获取飞书 token 失败：' + JSON.stringify(tokenData));
      }

      // 第二步：查询广告位库存表
      const dataRes = await fetch(
        `https://open.feishu.cn/open-apis/bitable/v1/apps/${env.FEISHU_APP_TOKEN}/tables/${env.FEISHU_TABLE_ID}/records?page_size=100`,
        {
          headers: { 'Authorization': `Bearer ${token}` }
        }
      );
      const data = await dataRes.json();

      // 第三步：格式化数据返回给前端
      const items = (data.data?.items || []).map(item => ({
        id: item.record_id,
        panel: item.fields['版位'] || '',
        type: item.fields['广告类型'] || '',
        status: item.fields['售卖状态'] || '',
        price: String(item.fields['价格'] || ''),
        size: item.fields['尺寸'] || ''
      }));

      return new Response(
        JSON.stringify({
          last_updated: new Date().toISOString(),
          total: items.length,
          items
        }),
        {
          headers: {
            'Content-Type': 'application/json; charset=utf-8',
            'Access-Control-Allow-Origin': '*',
            'Cache-Control': `s-maxage=${CACHE_TTL}`
          }
        }
      );

    } catch (err) {
      return new Response(
        JSON.stringify({ error: err.message }),
        {
          status: 500,
          headers: {
            'Content-Type': 'application/json',
            'Access-Control-Allow-Origin': '*'
          }
        }
      );
    }
  }
};
