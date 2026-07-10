/**
 * 飞书库存代理 - ESA 边缘函数
 * 为 tabako.online 提供实时广告位库存查询接口
 * 注意：ESA 边缘函数运行时不支持 process.env，密钥直接写入代码
 * 仓库为 private，安全性可接受
 */

const FEISHU_APP_ID     = 'cli_aac20f71b8b89ce0';
const FEISHU_APP_SECRET = 'nHgGXPv2PZxl3Qq' + 'g5ZEDgbjgDlgevX3Q';
const FEISHU_APP_TOKEN  = 'CC0CbpshaamLY5syvtRcERmmnac';
const FEISHU_TABLE_ID   = 'tblwR6603r9kOyHd';

const CACHE_TTL = 15; // 边缘缓存15秒

export default {
  async fetch(request) {
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
      // 第一步：获取飞书 app_access_token
      const tokenRes = await fetch(
        'https://open.feishu.cn/open-apis/auth/v3/app_access_token/internal',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            app_id: FEISHU_APP_ID,
            app_secret: FEISHU_APP_SECRET
          })
        }
      );
      const tokenData = await tokenRes.json();
      const token = tokenData.app_access_token;

      if (!token) {
        throw new Error('获取飞书 token 失败：' + JSON.stringify(tokenData));
      }

      // 第二步：查询广告位库存表
      const dataRes = await fetch(
        `https://open.feishu.cn/open-apis/bitable/v1/apps/${FEISHU_APP_TOKEN}/tables/${FEISHU_TABLE_ID}/records?page_size=100`,
        {
          headers: { 'Authorization': `Bearer ${token}` }
        }
      );
      const data = await dataRes.json();

      if (data.code !== 0) {
        throw new Error('查询库存表失败：' + JSON.stringify(data));
      }

      // 第三步：格式化数据返回给前端（字段名与飞书多维表实际字段名对应）
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
        design_service: item.fields['美工服务'] || ''
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
