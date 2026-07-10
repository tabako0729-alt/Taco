# Taco 广告位库存代理

> 飞书多维表库存数据边缘代理，部署在阿里云 ESA，为 tabako.online 提供实时广告位库存查询接口。

## 架构

```
用户浏览器（tabako.online）
    ↓ 每30秒轮询
api.tabako.online/inventory（ESA 边缘函数）
    ↓ 服务端请求（密钥安全）
飞书多维表 API
    ↓ 返回库存数据
前端实时展示
```

## 环境变量（在 ESA 控制台配置，不进代码）

| 变量名 | 说明 |
|---|---|
| `FEISHU_APP_ID` | 飞书应用 App ID |
| `FEISHU_APP_SECRET` | 飞书应用 App Secret |
| `FEISHU_APP_TOKEN` | 多维表 Base Token |
| `FEISHU_TABLE_ID` | 广告位库存表 Table ID |

## 接口

`GET /inventory` → 返回所有广告位库存数据（JSON）
