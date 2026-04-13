# RongCloud Assist 后端 API 接口文档

> **Base URL**: `http://<host>:8080`  
> **更新日期**: 2026-03-16  
> **内容格式**: JSON (`Content-Type: application/json`)

---

## 目录

- [1. 鉴权说明](#1-鉴权说明)
- [2. AI 接口](#2-ai-接口)
  - [2.1 群聊 AI 总结](#21-群聊-ai-总结)
  - [2.2 AI 备忘生成](#22-ai-备忘生成)
  - [2.3 AI 工作日志](#23-ai-工作日志)
  - [2.4 AI 服务状态](#24-ai-服务状态)
- [3. 客户端接口](#3-客户端接口)
  - [3.1 客户端心跳上报](#31-客户端心跳上报)
  - [3.2 标记公告已读](#32-标记公告已读)
- [4. 管理接口 (Admin API)](#4-管理接口-admin-api)
  - [4.1 发布插件/核心组件](#41-发布插件核心组件)
  - [4.2 查看 Manifest](#42-查看-manifest)
  - [4.3 移除插件](#43-移除插件)
- [5. 管理后台 AJAX 接口](#5-管理后台-ajax-接口)
  - [5.1 用户管理](#51-用户管理)
  - [5.2 统计数据](#52-统计数据)
  - [5.3 灰度发布](#53-灰度发布)
  - [5.4 插件管理（扩展）](#54-插件管理扩展)
  - [5.5 公告管理](#55-公告管理)
  - [5.6 远程配置](#56-远程配置)
  - [5.7 审计日志](#57-审计日志)
  - [5.8 AI 调用统计](#58-ai-调用统计)
- [6. 系统接口](#6-系统接口)
  - [6.1 健康检查](#61-健康检查)
  - [6.2 静态文件](#62-静态文件)
- [7. 错误码说明](#7-错误码说明)

---

## 1. 鉴权说明

系统使用三种鉴权机制：

| 类型                 | Header / 方式                       | 适用接口                       | 说明                                                                       |
| -------------------- | ----------------------------------- | ------------------------------ | -------------------------------------------------------------------------- |
| **API Key**          | `Authorization: Bearer <API_KEY>`<br>`x-user-id: <user_id>`| `/api/ai/*`                    | 客户端调用 AI 接口鉴权，`x-user-id` 用于追踪用户调用。密钥在 `.env` 中配置 `API_KEY`，留空免鉴权 |
| **Admin Key**        | `Authorization: Bearer <ADMIN_KEY>` | `/api/admin/*`                 | 管理 API 接口鉴权，密钥在 `.env` 中配置 `ADMIN_KEY`                        |
| **Session (Cookie)** | 浏览器 Cookie 自动携带              | `/admin/*` (AJAX)              | 管理后台页面通过登录获取 Session，无需手动传递                             |
| **无鉴权**           | —                                   | `/api/client/*`, `/api/health` | 客户端心跳和健康检查无需鉴权                                               |

### 限流策略

| 路由                | 限制     | 窗口   |
| ------------------- | -------- | ------ |
| `/api/ai/*`         | 30 次/IP | 60 秒  |
| `POST /admin/login` | 5 次/IP  | 5 分钟 |

---

## 2. AI 接口

> **前缀**: `/api/ai`  
> **鉴权**: Header 携带 `Authorization: Bearer <API_KEY>` 并附加 `x-user-id: <user_id>`  
> **限流**: 30 次/分钟/IP  
> **调用追踪**: 所有 AI 接口调用会自动记录到 `api_usage` 表，根据 `x-user-id` 追踪  
> **缓存策略**: AI 接口统一使用 `ai-cache` 中间件缓存，TTL 由 `CACHE_TTL` 控制

### 2.1 群聊 AI 总结

**`POST /api/ai/summary`**

接收群聊消息记录，调用 LLM 生成群聊动态摘要。使用统一 AI 缓存中间件。

#### 请求体

```json
{
  "groupId": "group_001",
  "groupName": "技术讨论群",
  "messageCount": 50,
  "rawMessages": "[张三 10:30] 大家好\n[李四 10:31] ..."
}
```

| 字段           | 类型   | 必填   | 说明                  |
| -------------- | ------ | ------ | --------------------- |
| `groupId`      | string | 否     | 群组 ID（用于缓存键） |
| `groupName`    | string | 否     | 群组名称              |
| `messageCount` | number | 否     | 消息总数              |
| `rawMessages`  | string | **是** | 已格式化的消息文本    |

#### 响应体

```json
{
  "summary": "📋 讨论主题：...\n📌 关键信息：...",
  "choices": [
    {
      "message": {
        "role": "assistant",
        "content": "..."
      }
    }
  ],
  "usage": {
    "prompt_tokens": 320,
    "completion_tokens": 150,
    "total_tokens": 470
  },
  "cached": false
}
```

| 字段      | 类型    | 说明                                         |
| --------- | ------- | -------------------------------------------- |
| `summary` | string  | AI 生成的摘要内容                            |
| `choices` | array   | LLM 原始返回的 choices                       |
| `usage`   | object  | Token 用量统计                               |
| `cached`  | boolean | 是否命中缓存（缓存 TTL 由 `CACHE_TTL` 控制） |

---

### 2.2 AI 备忘生成

**`POST /api/ai/memo`**

从聊天消息中提取关键信息，生成结构化备忘录条目。

#### 请求体

```json
{
  "messageContent": "明天下午3点开会讨论项目进度",
  "senderName": "张三",
  "contextMessages": "[李四 09:00] 项目快到截止日期了\n[张三 09:05] ...",
  "conversationType": 1,
  "targetId": "user_002"
}
```

| 字段               | 类型   | 必填   | 说明                       |
| ------------------ | ------ | ------ | -------------------------- |
| `messageContent`   | string | **是** | 目标消息文本内容           |
| `senderName`       | string | 否     | 发送者名称                 |
| `contextMessages`  | string | 否     | 最近聊天记录（格式化文本） |
| `conversationType` | number | 否     | IM 会话类型                |
| `targetId`         | string | 否     | IM 会话目标 ID             |

#### 响应体

```json
{
  "content": "项目进度会议，讨论截止日期安排",
  "initiator": "张三",
  "deadline": "2026-03-17T15:00",
  "summary": "明日15:00项目进度会议",
  "usage": {
    "prompt_tokens": 250,
    "completion_tokens": 80,
    "total_tokens": 330
  }
}
```

| 字段        | 类型           | 说明                                  |
| ----------- | -------------- | ------------------------------------- |
| `content`   | string         | 备忘内容（含会议时间、主题等）        |
| `initiator` | string         | 发起人姓名                            |
| `deadline`  | string \| null | 截止时间 `YYYY-MM-DDTHH:mm` 或 `null` |
| `summary`   | string         | 一句话概要                            |
| `usage`     | object         | Token 用量                            |

---

### 2.3 AI 工作日志

**`POST /api/ai/work-log`**

根据当日 IM 消息记录生成工作日志摘要。使用统一 AI 缓存中间件。

#### 请求体

```json
{
  "date": "2026-03-16",
  "rawMessages": "[张三→技术讨论群 09:30] ...",
  "messageCount": 45,
  "conversationCount": 8
}
```

| 字段                | 类型   | 必填   | 说明                        |
| ------------------- | ------ | ------ | --------------------------- |
| `date`              | string | 否     | 日期 `YYYY-MM-DD`，默认当天 |
| `rawMessages`       | string | **是** | 已格式化的消息文本          |
| `messageCount`      | number | 否     | 消息总数                    |
| `conversationCount` | number | 否     | 会话数                      |

#### 响应体

```json
{
  "summary": "## 2026-03-16 工作日志\n\n### 主要工作...",
  "choices": [...],
  "usage": { ... },
  "cached": false
}
```

| 字段      | 类型    | 说明              |
| --------- | ------- | ----------------- |
| `summary` | string  | AI 生成的工作日志 |
| `choices` | array   | LLM 原始返回      |
| `usage`   | object  | Token 用量        |
| `cached`  | boolean | 是否命中缓存      |

---

### 2.4 AI 服务状态

**`GET /api/ai/status`**

获取 AI 服务和缓存的运行状态。

#### 响应体

```json
{
  "llm": {
    "model": "deepseek-chat",
    "baseURL": "https://api.deepseek.com",
    "configured": true,
    "activeCalls": 0,
    "maxConcurrency": 10
  },
  "cache": {
    "keys": 3,
    "hits": 12,
    "misses": 5,
    "ttl": 300
  }
}
```

---

## 3. 客户端接口

> **前缀**: `/api/client`  
> **鉴权**: 无

### 3.1 客户端心跳上报

**`POST /api/client/heartbeat`**

客户端定期上报心跳数据，服务端返回未读公告、远程配置和灰度更新指令。

#### 请求体

```json
{
  "clientId": "550e8400-e29b-41d4-a716-446655440000",
  "userInfo": {
    "id": "user_001",
    "name": "张三",
    "portrait": "https://example.com/avatar.jpg",
    "deptName": "技术部",
    "companyId": "company_001",
    "companyName": "融云科技"
  },
  "platform": "darwin",
  "appVersion": "5.8.3.116",
  "coreVersion": "1.0.2",
  "plugins": [
    { "id": "ai-memo", "version": "1.0.0", "enabled": true },
    { "id": "dark-mode-toggle", "version": "1.1.0", "enabled": true }
  ]
}
```

| 字段                   | 类型    | 必填   | 说明                                  |
| ---------------------- | ------- | ------ | ------------------------------------- |
| `clientId`             | string  | **是** | 客户端唯一标识（UUID）                |
| `userInfo`             | object  | 否     | 当前登录用户信息                      |
| `userInfo.id`          | string  | 否     | 用户 ID                               |
| `userInfo.name`        | string  | 否     | 用户名                                |
| `userInfo.portrait`    | string  | 否     | 头像 URL                              |
| `userInfo.deptName`    | string  | 否     | 部门名称                              |
| `userInfo.companyId`   | string  | 否     | 公司 ID                               |
| `userInfo.companyName` | string  | 否     | 公司名称                              |
| `platform`             | string  | 否     | 操作系统 `win32` / `darwin` / `linux` |
| `appVersion`           | string  | 否     | IM 客户端版本号                       |
| `coreVersion`          | string  | 否     | 核心组件版本号                        |
| `plugins`              | array   | 否     | 当前已安装的插件列表                  |
| `plugins[].id`         | string  | 否     | 插件 ID                               |
| `plugins[].version`    | string  | 否     | 插件版本                              |
| `plugins[].enabled`    | boolean | 否     | 是否启用                              |

#### 响应体

```json
{
  "ok": true,
  "serverTime": "2026-03-16T09:00:00.000Z",
  "announcements": [
    {
      "id": 1,
      "title": "系统升级通知",
      "content": "将于今晚22:00进行系统升级...",
      "type": "warning"
    }
  ],
  "remoteConfig": {
    "plugin:ai-memo:enabled": true,
    "global:ai-enabled": true
  },
  "update": {
    "ai-memo": {
      "version": "1.2.0",
      "file": "plugins/ai-memo.js",
      "hash": "sha256:abc123..."
    }
  }
}
```

| 字段            | 类型    | 说明                                             |
| --------------- | ------- | ------------------------------------------------ |
| `ok`            | boolean | 操作是否成功                                     |
| `serverTime`    | string  | 服务器当前时间 (ISO 8601)                        |
| `announcements` | array   | 未读公告列表（已过滤已读和过期的）               |
| `remoteConfig`  | object  | 远程配置键值对（仅返回启用且匹配当前客户端的）   |
| `update`        | object  | 需要更新的插件信息（由灰度引擎决策），键为插件ID |

---

### 3.2 标记公告已读

**`POST /api/client/announcements/:id/read`**

客户端标记某条公告为已读。

#### 路径参数

| 参数 | 类型   | 说明    |
| ---- | ------ | ------- |
| `id` | number | 公告 ID |

#### 请求体

```json
{
  "clientId": "550e8400-e29b-41d4-a716-446655440000"
}
```

| 字段       | 类型   | 必填   | 说明           |
| ---------- | ------ | ------ | -------------- |
| `clientId` | string | **是** | 客户端唯一标识 |

#### 响应体

```json
{
  "ok": true
}
```

---

## 4. 管理接口 (Admin API)

> **前缀**: `/api/admin`  
> **鉴权**: `Authorization: Bearer <ADMIN_KEY>`

### 4.1 发布插件/核心组件

**`POST /api/admin/publish`**

上传并发布一个插件或核心组件。旧版本自动归档（保留最近 5 个版本）。

#### 请求格式

`Content-Type: multipart/form-data`

| 字段          | 类型   | 必填   | 说明                                      |
| ------------- | ------ | ------ | ----------------------------------------- |
| `type`        | string | **是** | `"plugin"` 或 `"core"`                    |
| `id`          | string | **是** | 组件 ID（如 `ai-memo`、`plugin-manager`） |
| `version`     | string | **是** | 版本号（如 `1.2.0`）                      |
| `file`        | file   | **是** | `.js` 文件（上限 2MB）                    |
| `name`        | string | 否     | 显示名称（仅插件）                        |
| `description` | string | 否     | 描述                                      |
| `changelog`   | string | 否     | 更新日志                                  |

#### 响应体

```json
{
  "message": "插件 ai-memo v1.2.0 发布成功",
  "file": "plugins/ai-memo.js",
  "hash": "sha256:a1b2c3d4...",
  "isNew": false
}
```

| 字段      | 类型    | 说明                             |
| --------- | ------- | -------------------------------- |
| `message` | string  | 操作结果说明                     |
| `file`    | string  | 文件相对路径                     |
| `hash`    | string  | 文件 SHA256 哈希                 |
| `isNew`   | boolean | 是否为新增插件（仅 type=plugin） |

#### curl 示例

```bash
curl -X POST http://localhost:8080/api/admin/publish \
  -H "Authorization: Bearer your-admin-key" \
  -F "type=plugin" \
  -F "id=ai-memo" \
  -F "version=1.2.0" \
  -F "name=AI 备忘" \
  -F "changelog=修复备忘生成超时问题" \
  -F "file=@./dist/ai-memo.js"
```

---

### 4.2 查看 Manifest

**`GET /api/admin/manifest`**

获取当前 `manifest.json` 的完整内容。

#### 响应体

```json
{
  "version": "1.0.0",
  "updatedAt": "2026-03-16T09:00:00.000Z",
  "core": {
    "pluginManager": {
      "version": "1.0.2",
      "file": "core/plugin-manager.js",
      "hash": "sha256:...",
      "changelog": ""
    }
  },
  "plugins": [
    {
      "id": "ai-memo",
      "name": "AI 备忘",
      "version": "1.2.0",
      "file": "plugins/ai-memo.js",
      "hash": "sha256:...",
      "description": "",
      "changelog": "修复超时"
    }
  ]
}
```

---

### 4.3 移除插件

**`DELETE /api/admin/plugins/:id`**

从 manifest 中移除一个插件条目（不删除服务器上的文件）。

#### 路径参数

| 参数 | 类型   | 说明    |
| ---- | ------ | ------- |
| `id` | string | 插件 ID |

#### 响应体

```json
{
  "message": "插件 ai-memo 已从 manifest 移除",
  "removed": {
    "id": "ai-memo",
    "name": "AI 备忘",
    "version": "1.2.0",
    "file": "plugins/ai-memo.js"
  }
}
```

---

## 5. 管理后台 AJAX 接口

> **前缀**: `/admin/api`  
> **鉴权**: Session Cookie（需先登录管理后台）  
> **说明**: 这些接口供管理后台前端页面 AJAX 调用，浏览器登录后自动携带 Session Cookie

### 5.1 用户管理

#### 用户列表

**`GET /admin/api/users`**

分页查询已注册的客户端用户列表，支持搜索和筛选。

| 参数       | 类型   | 默认值 | 说明                                           |
| ---------- | ------ | ------ | ---------------------------------------------- |
| `page`     | number | 1      | 页码                                           |
| `pageSize` | number | 20     | 每页条数                                       |
| `search`   | string | —      | 模糊搜索（匹配 user_name、user_id、client_id） |
| `status`   | string | —      | 在线状态筛选：`online` / `offline`             |
| `platform` | string | —      | 平台筛选：`win32` / `darwin` / `linux`         |

**响应体**

```json
{
  "items": [
    {
      "id": "550e8400-...",
      "user_id": "user_001",
      "user_name": "张三",
      "dept_name": "技术部",
      "platform": "darwin",
      "app_version": "5.8.3",
      "last_heartbeat": "2026-03-16 09:00:00",
      "ip_address": "192.168.1.100",
      "isOnline": true
    }
  ],
  "total": 42,
  "page": 1,
  "pageSize": 20,
  "totalPages": 3
}
```

#### 用户详情

**`GET /admin/api/users/:clientId`**

获取单个用户的完整信息。

**响应体**

```json
{
  "id": "550e8400-...",
  "user_id": "user_001",
  "user_name": "张三",
  "portrait": "https://...",
  "dept_name": "技术部",
  "company_id": "company_001",
  "company_name": "融云科技",
  "platform": "darwin",
  "app_version": "5.8.3.116",
  "core_version": "1.0.2",
  "plugin_config": "[{\"id\":\"ai-memo\",\"version\":\"1.0.0\",\"enabled\":true}]",
  "first_seen": "2026-03-10 08:00:00",
  "last_heartbeat": "2026-03-16 09:00:00",
  "ip_address": "192.168.1.100"
}
```

---

### 5.2 统计数据

#### 概览数据

**`GET /admin/api/stats/overview`**

获取 Dashboard 概览卡片数据。

```json
{
  "totalUsers": 42,
  "onlineUsers": 8,
  "pluginCount": 5,
  "todayApiCalls": 120
}
```

#### 用户活跃趋势

**`GET /admin/api/stats/trend`**

| 参数   | 类型   | 默认值 | 说明     |
| ------ | ------ | ------ | -------- |
| `days` | number | 7      | 查询天数 |

```json
[
  { "date": "2026-03-10", "count": 5 },
  { "date": "2026-03-11", "count": 8 },
  ...
]
```

#### 平台分布

**`GET /admin/api/stats/platforms`**

```json
[
  { "platform": "darwin", "count": 15 },
  { "platform": "win32", "count": 22 },
  { "platform": "linux", "count": 5 }
]
```

#### 插件使用统计

**`GET /admin/api/stats/plugins`**

```json
[
  { "name": "ai-memo", "total": 30, "active": 12 },
  { "name": "dark-mode-toggle", "total": 28, "active": 10 }
]
```

#### AI 调用统计

**`GET /admin/api/stats/api-usage`**

| 参数       | 类型   | 默认值  | 说明                                 |
| ---------- | ------ | ------- | ------------------------------------ |
| `period`   | string | `today` | 时间范围：`today` / `week` / `month` |
| `endpoint` | string | —       | 筛选特定接口路径                     |

```json
{
  "totalCalls": 120,
  "errorCount": 3,
  "errorRate": "2.5",
  "avgDuration": 1234.5,
  "byEndpoint": [
    {
      "endpoint": "/api/ai/summary",
      "count": 80,
      "avg_duration": 1100,
      "error_count": 1
    },
    {
      "endpoint": "/api/ai/memo",
      "count": 40,
      "avg_duration": 1500,
      "error_count": 2
    }
  ],
  "byUser": [
    { "user_id": "user_001", "count": 25 },
    { "user_id": "user_002", "count": 18 }
  ],
  "trend": [{ "date": "2026-03-16", "count": 120 }]
}
```

#### 用户增长趋势

**`GET /admin/api/stats/user-growth`**

| 参数   | 类型   | 默认值 | 说明     |
| ------ | ------ | ------ | -------- |
| `days` | number | 30     | 查询天数 |

```json
[
  { "date": "2026-03-01", "newUsers": 5, "totalUsers": 120 },
  { "date": "2026-03-02", "newUsers": 8, "totalUsers": 128 }
]
```

#### API 调用趋势

**`GET /admin/api/stats/api-call-trend`**

| 参数   | 类型   | 默认值 | 说明     |
| ------ | ------ | ------ | -------- |
| `days` | number | 30     | 查询天数 |

```json
{
  "trend": [
    {
      "date": "2026-03-01",
      "total": 120,
      "success": 118,
      "error": 2,
      "byEndpoint": {
        "/api/ai/summary": 80,
        "/api/ai/memo": 40
      }
    }
  ],
  "endpoints": ["/api/ai/summary", "/api/ai/memo"]
}
```

---

### 5.3 灰度发布

#### 获取所有规则

**`GET /admin/api/grayscale`**

```json
[
  {
    "id": 1,
    "plugin_id": "ai-memo",
    "version": "1.2.0",
    "strategy": "percentage",
    "rule_config": { "percentage": 30 },
    "enabled": 1,
    "created_at": "2026-03-16 09:00:00"
  }
]
```

#### 创建规则

**`POST /admin/api/grayscale`**

```json
{
  "pluginId": "ai-memo",
  "version": "1.2.0",
  "strategy": "percentage",
  "ruleConfig": { "percentage": 30 }
}
```

| 字段         | 类型   | 必填   | 说明                                              |
| ------------ | ------ | ------ | ------------------------------------------------- |
| `pluginId`   | string | **是** | 关联的插件 ID                                     |
| `version`    | string | **是** | 目标版本号                                        |
| `strategy`   | string | **是** | 灰度策略：`percentage` / `whitelist` / `platform` |
| `ruleConfig` | object | **是** | 策略配置（见下表）                                |

**策略配置格式**

| 策略         | `ruleConfig` 格式                     | 说明                 |
| ------------ | ------------------------------------- | -------------------- |
| `percentage` | `{"percentage": 30}`                  | 按百分比灰度，0-100  |
| `whitelist`  | `{"clientIds": ["uuid-1", "uuid-2"]}` | 指定客户端 ID 白名单 |
| `platform`   | `{"platforms": ["darwin", "win32"]}`  | 按操作系统平台       |

**响应**

```json
{ "ok": true, "id": 1 }
```

#### 更新规则

**`PUT /admin/api/grayscale/:id`**

支持部分字段更新。

```json
{
  "enabled": false
}
```

**响应**

```json
{ "ok": true }
```

#### 删除规则

**`DELETE /admin/api/grayscale/:id`**

**响应**

```json
{ "ok": true }
```

#### 转为全量发布

**`POST /admin/api/grayscale/:id/promote`**

将灰度版本写入 `manifest.json`，使所有客户端生效。

**响应**

```json
{
  "ok": true,
  "promoted": {
    "plugin_id": "ai-memo",
    "version": "1.2.0"
  }
}
```

---

### 5.4 插件管理（扩展）

#### 获取插件历史版本

**`GET /admin/api/plugins/:id/archive`**

```json
[
  {
    "filename": "ai-memo-1.0.0.js",
    "version": "1.0.0",
    "size": 15360,
    "modifiedAt": "2026-03-15T10:00:00.000Z"
  }
]
```

#### 回滚插件版本

**`POST /admin/api/plugins/:id/rollback`**

```json
{
  "version": "1.0.0"
}
```

| 字段      | 类型   | 必填   | 说明                 |
| --------- | ------ | ------ | -------------------- |
| `version` | string | **是** | 要回滚到的目标版本号 |

**响应**

```json
{
  "ok": true,
  "message": "插件 ai-memo 已回滚到 v1.0.0"
}
```

---

### 5.5 公告管理

#### 查询公告列表

**`GET /admin/api/announcements`**

返回所有公告（含已读统计）。

```json
[
  {
    "id": 1,
    "title": "系统升级通知",
    "content": "将于今晚22:00进行系统升级...",
    "type": "warning",
    "target": "*",
    "active": 1,
    "expires_at": "2026-03-20 00:00:00",
    "created_at": "2026-03-16 09:00:00",
    "readCount": 15
  }
]
```

#### 创建公告

**`POST /admin/api/announcements`**

```json
{
  "title": "系统升级通知",
  "content": "将于今晚22:00进行系统升级，预计维护1小时",
  "type": "warning",
  "target": "*",
  "expiresAt": "2026-03-20T00:00"
}
```

| 字段        | 类型   | 必填   | 说明                                                 |
| ----------- | ------ | ------ | ---------------------------------------------------- |
| `title`     | string | **是** | 公告标题                                             |
| `content`   | string | **是** | 公告内容（支持简单 Markdown）                        |
| `type`      | string | 否     | 类型：`info` / `warning` / `critical`（默认 `info`） |
| `target`    | string | 否     | 投放目标：`*` 全部或 clientId 列表（默认 `*`）       |
| `expiresAt` | string | 否     | 过期时间 `YYYY-MM-DDTHH:mm`，不传则不过期            |

**响应**

```json
{ "ok": true, "id": 1 }
```

#### 更新公告

**`PUT /admin/api/announcements/:id`**

支持部分字段更新。

```json
{
  "title": "更新后的标题",
  "active": false
}
```

**可更新字段**: `title`, `content`, `type`, `target`, `active` (boolean), `expiresAt`

**响应**

```json
{ "ok": true }
```

#### 删除公告

**`DELETE /admin/api/announcements/:id`**

同时删除该公告的所有已读标记。

**响应**

```json
{ "ok": true }
```

---

### 5.6 远程配置

#### 查询配置列表

**`GET /admin/api/remote-config`**

```json
[
  {
    "id": 1,
    "config_key": "plugin:ai-memo:enabled",
    "config_value": "true",
    "target": "*",
    "description": "全局启用 AI 备忘插件",
    "enabled": 1,
    "created_at": "2026-03-16 09:00:00",
    "updated_at": "2026-03-16 09:00:00"
  }
]
```

#### 创建配置

**`POST /admin/api/remote-config`**

```json
{
  "configKey": "plugin:ai-memo:enabled",
  "configValue": "true",
  "target": "*",
  "description": "全局启用 AI 备忘插件"
}
```

| 字段          | 类型   | 必填   | 说明                                        |
| ------------- | ------ | ------ | ------------------------------------------- |
| `configKey`   | string | **是** | 配置键（格式见下表）                        |
| `configValue` | string | **是** | 配置值                                      |
| `target`      | string | 否     | 目标：`*` 全部 或 clientId 列表（默认 `*`） |
| `description` | string | 否     | 配置说明                                    |

**配置键格式约定**

| 格式                             | 用途              | 示例                                             |
| -------------------------------- | ----------------- | ------------------------------------------------ |
| `plugin:<pluginId>:enabled`      | 强制启用/禁用插件 | `plugin:ai-memo:enabled` → `false`               |
| `plugin:<pluginId>:config:<key>` | 覆盖插件配置项    | `plugin:water-reminder:config:interval` → `"30"` |
| `global:<key>`                   | 全局配置          | `global:ai-enabled` → `true`                     |

**响应**

```json
{ "ok": true, "id": 1 }
```

#### 更新配置

**`PUT /admin/api/remote-config/:id`**

支持部分字段更新。

```json
{
  "configValue": "false",
  "enabled": false
}
```

**可更新字段**: `configKey`, `configValue`, `target`, `description`, `enabled` (boolean)

**响应**

```json
{ "ok": true }
```

#### 删除配置

**`DELETE /admin/api/remote-config/:id`**

**响应**

```json
{ "ok": true }
```

---

### 5.7 审计日志

#### 查询审计日志

**`GET /admin/api/audit-logs`**

| 参数        | 类型   | 默认值 | 说明                   |
| ----------- | ------ | ------ | ---------------------- |
| `page`      | number | 1      | 页码                   |
| `pageSize`  | number | 20     | 每页条数               |
| `action`    | string | —      | 操作类型筛选（见下表） |
| `startDate` | string | —      | 开始日期 `YYYY-MM-DD`  |
| `endDate`   | string | —      | 结束日期 `YYYY-MM-DD`  |

**操作类型 (`action`) 枚举**

| 值                    | 说明         |
| --------------------- | ------------ |
| `login`               | 登录成功     |
| `login_failed`        | 登录失败     |
| `logout`              | 退出登录     |
| `publish`             | 插件发布     |
| `rollback`            | 版本回滚     |
| `grayscale_create`    | 创建灰度规则 |
| `grayscale_update`    | 更新灰度规则 |
| `grayscale_delete`    | 删除灰度规则 |
| `grayscale_promote`   | 灰度转全量   |
| `announcement_create` | 创建公告     |
| `announcement_update` | 更新公告     |
| `announcement_delete` | 删除公告     |
| `config_create`       | 创建远程配置 |
| `config_update`       | 更新远程配置 |
| `config_delete`       | 删除远程配置 |

**响应体**

```json
{
  "items": [
    {
      "id": 1,
      "action": "login",
      "target": null,
      "operator": "admin",
      "detail": null,
      "ip_address": "127.0.0.1",
      "created_at": "2026-03-16 09:00:00"
    }
  ],
  "total": 56,
  "page": 1,
  "pageSize": 20,
  "totalPages": 3
}
```

---

### 5.8 AI 调用统计

> 同 [5.2 统计数据 — AI 调用统计](#ai-调用统计)

**`GET /admin/api/stats/api-usage`**

---

## 6. 系统接口

### 6.1 健康检查

**`GET /api/health`**

无需鉴权的健康检查接口。

```json
{
  "status": "ok",
  "timestamp": "2026-03-16T09:00:00.000Z",
  "uptime": 3600,
  "llm": {
    "model": "deepseek-chat",
    "baseURL": "https://api.deepseek.com",
    "configured": true,
    "activeCalls": 0,
    "maxConcurrency": 10
  }
}
```

---

### 6.2 静态文件

以下静态文件由 Express 直接托管（`public/` 目录），无需鉴权：

| URL                          | 说明                             |
| ---------------------------- | -------------------------------- |
| `GET /manifest.json`         | 插件清单文件，客户端据此检查更新 |
| `GET /plugins/<id>.js`       | 插件文件下载                     |
| `GET /core/<id>.js`          | 核心组件文件下载                 |
| `GET /admin/css/style.css`   | 管理后台静态样式                 |
| `GET /admin/js/dashboard.js` | 管理后台 Dashboard 脚本          |

---

## 7. 错误码说明

### 通用错误格式

```json
{
  "error": "错误描述信息",
  "code": "ERROR_CODE"
}
```

### 错误码表

| HTTP 状态码 | `code`               | 说明                           |
| ----------- | -------------------- | ------------------------------ |
| 400         | `INVALID_PARAMS`     | 请求参数缺失或格式错误         |
| 401         | —                    | 未授权（API Key 无效或未提供） |
| 404         | —                    | 资源不存在                     |
| 429         | `RATE_LIMITED`       | 请求频率超过限制               |
| 500         | —                    | 服务器内部错误                 |
| 502         | `LLM_UNREACHABLE`    | LLM 服务连接失败               |
| 503         | `LLM_NOT_CONFIGURED` | LLM 未配置 API Key             |

---

## 附录：管理后台页面路由

管理后台使用 EJS 服务端渲染，浏览器直接访问以下路径：

| URL                                 | 说明             |
| ----------------------------------- | ---------------- |
| `GET /admin/login`                  | 登录页面         |
| `POST /admin/login`                 | 登录提交         |
| `GET /admin/logout`                 | 退出登录         |
| `GET /admin/dashboard`              | 概览 Dashboard   |
| `GET /admin/users`                  | 用户管理列表     |
| `GET /admin/users/:clientId`        | 用户详情         |
| `GET /admin/plugins`                | 插件管理         |
| `GET /admin/plugins/publish`        | 发布插件表单     |
| `GET /admin/grayscale`              | 灰度规则列表     |
| `GET /admin/grayscale/create`       | 创建灰度规则表单 |
| `GET /admin/announcements`          | 公告列表         |
| `GET /admin/announcements/create`   | 创建公告表单     |
| `GET /admin/announcements/:id/edit` | 编辑公告表单     |
| `GET /admin/remote-config`          | 远程配置管理     |
| `GET /admin/api-stats`              | AI 调用统计      |
| `GET /admin/audit-logs`             | 审计日志         |
