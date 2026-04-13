# 📋 RongCloud Assist 服务端功能清单 v1.0

> 生成时间：2026-03-16  
> 状态：待实施  
> 技术栈：Node.js + Express + SQLite + EJS

---

## 目录

- [一、技术选型](#一技术选型)
- [二、数据库设计](#二数据库设计)
- [三、功能模块](#三功能模块)
  - [模块 1：数据库基础设施](#模块-1数据库基础设施)
  - [模块 2：管理后台登录](#模块-2管理后台登录)
  - [模块 3：客户端心跳上报](#模块-3客户端心跳上报)
  - [模块 4：用户管理界面](#模块-4用户管理界面)
  - [模块 5：统计 Dashboard](#模块-5统计-dashboard)
  - [模块 6：插件管理界面](#模块-6插件管理界面)
  - [模块 7：灰度发布](#模块-7灰度发布)
  - [模块 8：操作审计日志](#模块-8操作审计日志)
  - [模块 9：公告推送](#模块-9公告推送)
  - [模块 10：远程配置下发](#模块-10远程配置下发)
  - [模块 11：AI 调用统计](#模块-11ai-调用统计)
  - [模块 12：前端心跳改造](#模块-12前端心跳改造)
- [四、目录结构规划](#四目录结构规划)
- [五、环境变量新增](#五环境变量新增)
- [六、新增依赖](#六新增依赖)
- [七、实施优先级](#七实施优先级)

---

## 一、技术选型

| 项目     | 技术方案                        | 说明                             |
| -------- | ------------------------------- | -------------------------------- |
| 后端框架 | Express（沿用）                 | 已有成熟基础                     |
| 数据库   | SQLite（`better-sqlite3`）      | 零配置、单文件、适合内部工具量级 |
| 模板引擎 | EJS                             | 服务端渲染，简单快速             |
| Session  | `express-session` + SQLite 存储 | 登录会话管理                     |
| 密码哈希 | `bcryptjs`                      | 纯 JS 实现，无需编译             |
| 图表     | Chart.js（CDN 引入）            | 前端统计可视化                   |

---

## 二、数据库设计

### 文件位置：`data/assist.db`

### 表结构

#### 2.1 clients — 客户端注册信息

> 用户信息来源：客户端 `localStorage` 中 key 为 `{appId}auth` 的条目（如 `ik1qhwwyj5r3pauth`）。

```sql
CREATE TABLE IF NOT EXISTS clients (
  id              TEXT PRIMARY KEY,           -- clientId (UUID, 客户端生成)
  user_id         TEXT,                       -- IM 用户 ID (auth.data.id)
  user_name       TEXT,                       -- IM 用户显示名 (auth.data.name)
  portrait        TEXT,                       -- 用户头像 URL (auth.data.portrait)
  dept_name       TEXT,                       -- 所属部门 (auth.data.orgsInfo[0].name)
  company_id      TEXT,                       -- 公司 ID (auth.data.companyId)
  company_name    TEXT,                       -- 公司名称 (auth.data.orgsInfo[0].path[0].name)
  platform        TEXT,                       -- win32 | darwin | linux
  app_version     TEXT,                       -- 宿主 IM 版本号
  core_version    TEXT,                       -- 插件框架核心版本
  plugin_config   TEXT,                       -- JSON: 完整的插件配置快照
  user_extra      TEXT,                       -- JSON: auth 原始数据中的其他字段
  first_seen      DATETIME DEFAULT (datetime('now')),
  last_heartbeat  DATETIME,                   -- 最后一次心跳时间
  ip_address      TEXT,                       -- 客户端 IP
  extra           TEXT                        -- JSON: 预留扩展字段
);

CREATE INDEX idx_clients_user_id ON clients(user_id);
CREATE INDEX idx_clients_last_heartbeat ON clients(last_heartbeat);
CREATE INDEX idx_clients_company_id ON clients(company_id);
```

#### 2.2 plugin_stats — 插件使用统计（按日快照）

```sql
CREATE TABLE IF NOT EXISTS plugin_stats (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  plugin_id     TEXT NOT NULL,               -- 插件 ID
  date          DATE NOT NULL,               -- 统计日期
  active_users  INTEGER DEFAULT 0,           -- 当日活跃启用人数
  total_users   INTEGER DEFAULT 0,           -- 历史总启用人数
  UNIQUE(plugin_id, date)
);

CREATE INDEX idx_plugin_stats_date ON plugin_stats(date);
```

#### 2.3 audit_logs — 操作审计日志

```sql
CREATE TABLE IF NOT EXISTS audit_logs (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  action      TEXT NOT NULL,                  -- 操作类型: login / publish / rollback / config_push / announcement
  target      TEXT,                           -- 操作对象（插件 ID 等）
  operator    TEXT DEFAULT 'admin',           -- 操作者
  detail      TEXT,                           -- JSON: 操作详情
  ip_address  TEXT,                           -- 操作来源 IP
  created_at  DATETIME DEFAULT (datetime('now'))
);

CREATE INDEX idx_audit_logs_action ON audit_logs(action);
CREATE INDEX idx_audit_logs_created_at ON audit_logs(created_at);
```

#### 2.4 announcements — 公告通知

```sql
CREATE TABLE IF NOT EXISTS announcements (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  title       TEXT NOT NULL,                  -- 公告标题
  content     TEXT NOT NULL,                  -- 公告内容（支持 markdown）
  type        TEXT DEFAULT 'info',            -- info / warning / critical
  active      BOOLEAN DEFAULT 1,             -- 是否生效
  target      TEXT DEFAULT '*',              -- 目标: * 全部 | 逗号分隔的 clientId
  created_at  DATETIME DEFAULT (datetime('now')),
  expires_at  DATETIME                       -- 过期时间（null=不过期）
);
```

#### 2.5 announcement_reads — 公告已读记录

```sql
CREATE TABLE IF NOT EXISTS announcement_reads (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  announcement_id   INTEGER NOT NULL,
  client_id         TEXT NOT NULL,
  read_at           DATETIME DEFAULT (datetime('now')),
  UNIQUE(announcement_id, client_id),
  FOREIGN KEY (announcement_id) REFERENCES announcements(id)
);
```

#### 2.6 grayscale_rules — 灰度发布规则

```sql
CREATE TABLE IF NOT EXISTS grayscale_rules (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  plugin_id     TEXT NOT NULL,                -- 关联的插件 ID
  version       TEXT NOT NULL,                -- 灰度目标版本
  strategy      TEXT NOT NULL,                -- 策略: percentage | whitelist | platform
  rule_config   TEXT NOT NULL,                -- JSON: 策略参数
  enabled       BOOLEAN DEFAULT 1,
  created_at    DATETIME DEFAULT (datetime('now')),
  updated_at    DATETIME DEFAULT (datetime('now'))
);

CREATE INDEX idx_grayscale_plugin ON grayscale_rules(plugin_id);
```

`rule_config` 示例：

```json
// percentage 策略 — 按比例灰度
{ "percentage": 30 }

// whitelist 策略 — 指定客户端
{ "clientIds": ["uuid-1", "uuid-2"] }

// platform 策略 — 按平台
{ "platforms": ["darwin"] }
```

#### 2.7 api_usage — AI 接口调用统计

```sql
CREATE TABLE IF NOT EXISTS api_usage (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  endpoint      TEXT NOT NULL,                -- /api/ai/summary | /api/ai/memo | /api/ai/work-log
  client_id     TEXT,                         -- 调用方客户端 ID
  user_id       TEXT,                         -- 调用方用户 ID
  status        TEXT DEFAULT 'success',       -- success | error
  duration_ms   INTEGER,                      -- 耗时（毫秒）
  tokens_used   INTEGER,                      -- Token 消耗（如可获取）
  error_message TEXT,                         -- 错误信息
  created_at    DATETIME DEFAULT (datetime('now'))
);

CREATE INDEX idx_api_usage_endpoint ON api_usage(endpoint);
CREATE INDEX idx_api_usage_created_at ON api_usage(created_at);
```

#### 2.8 remote_configs — 远程配置下发

```sql
CREATE TABLE IF NOT EXISTS remote_configs (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  config_key    TEXT NOT NULL UNIQUE,         -- 配置键，如 plugin:ai-memo:enabled
  config_value  TEXT NOT NULL,                -- JSON 值
  target        TEXT DEFAULT '*',             -- 目标: * | clientId 列表
  description   TEXT,                         -- 配置说明
  enabled       BOOLEAN DEFAULT 1,
  updated_at    DATETIME DEFAULT (datetime('now'))
);
```

---

## 三、功能模块

---

### 模块 1：数据库基础设施

> 优先级：🔴 P0（最先实施，其他模块依赖）

#### 1.1 新增文件

| 文件                     | 说明                         |
| ------------------------ | ---------------------------- |
| `database/index.js`      | 数据库初始化、建表、获取连接 |
| `database/migrations.js` | 表结构版本管理（可选）       |

#### 1.2 功能点

- [ ] 服务启动时自动初始化 SQLite 数据库
- [ ] 自动创建所有表结构（`IF NOT EXISTS`）
- [ ] 导出 `db` 实例供各模块使用
- [ ] 数据库文件位于 `data/assist.db`，.gitignore 忽略 `data/` 目录

#### 1.3 接口设计

无对外 API，仅内部模块。

---

### 模块 2：管理后台登录

> 优先级：🔴 P0

#### 2.1 新增文件

| 文件                         | 说明                             |
| ---------------------------- | -------------------------------- |
| `routes/dashboard.js`        | 管理后台路由（登录、页面、登出） |
| `middleware/session.js`      | Session 中间件配置               |
| `views/login.ejs`            | 登录页面                         |
| `views/layout.ejs`           | 页面公共布局模板                 |
| `public/admin/css/style.css` | 管理后台样式                     |

#### 2.2 功能点

- [ ] 登录页面（简洁表单：用户名 + 密码）
- [ ] 账号密码从 `.env` 读取（`ADMIN_USERNAME` / `ADMIN_PASSWORD`）
- [ ] 登录验证：bcrypt 哈希比对
- [ ] Session 管理（`express-session`，SQLite 持久化存储）
- [ ] 登出功能
- [ ] 登录失败限流（同一 IP 5 分钟内最多 5 次）
- [ ] 已登录状态检查中间件（`requireLogin`）
- [ ] 登录/登出操作记录到审计日志

#### 2.3 页面路由

| 路由            | 方法 | 说明         | 鉴权    |
| --------------- | ---- | ------------ | ------- |
| `/admin/login`  | GET  | 登录页面     | 无      |
| `/admin/login`  | POST | 提交登录     | 无      |
| `/admin/logout` | GET  | 登出         | Session |
| `/admin`        | GET  | 跳转到概览页 | Session |

#### 2.4 环境变量

```env
ADMIN_USERNAME=admin
ADMIN_PASSWORD=your-secure-password
SESSION_SECRET=random-session-secret-string
```

> 首次启动时，服务端用 bcryptjs 对 `ADMIN_PASSWORD` 做哈希加密后缓存，后续登录比对哈希值。

---

### 模块 3：客户端心跳上报

> 优先级：🔴 P0

#### 3.1 新增文件

| 文件               | 说明                     |
| ------------------ | ------------------------ |
| `routes/client.js` | 客户端 API（心跳、注册） |

#### 3.2 功能点

- [ ] 接收客户端心跳数据并存入数据库
- [ ] 新客户端自动注册（INSERT OR REPLACE）
- [ ] 记录客户端 IP 地址
- [ ] 心跳响应中携带：待处理公告、远程配置、灰度更新指令
- [ ] 定时任务：超过 2 小时无心跳的客户端标记为离线

#### 3.3 API 设计

**POST /api/client/heartbeat**

请求：

```json
{
  "clientId": "uuid-generated-by-client",
  "userInfo": {
    "id": "3e3240b1-fdcc-448c-a25c-3706bdb79032",
    "name": "朱枫",
    "portrait": "https://oa.epoint.com.cn/950soa/rest/...",
    "companyId": "J_h8odzPSTotfH0VRKrRhs",
    "companyName": "国泰新点软件股份有限公司",
    "deptId": "2bece575-45a8-4667-914e-c3f1e5cefc75",
    "deptName": "技术架构部",
    "isStaff": true
  },
  "platform": "darwin",
  "appVersion": "1.8.2",
  "coreVersion": "2.0.0",
  "plugins": [
    {
      "id": "ai-memo",
      "version": "1.1.0",
      "enabled": true,
      "config": {}
    },
    {
      "id": "auto-lock-screen",
      "version": "1.0.0",
      "enabled": true,
      "config": { "timeout": "5", "password": "***" }
    }
  ]
}
```

> **userInfo 数据来源**：客户端从 `localStorage` 中读取 key 为 `{appId}auth` 的条目（如 `ik1qhwwyj5r3pauth`），该条目的 `data` 字段包含完整的用户登录信息。客户端提取并映射需要的字段后上报，**不上报 token、code、rceToken 等敏感鉴权信息**。

响应：

```json
{
  "ok": true,
  "serverTime": "2026-03-16T09:00:00Z",
  "announcements": [
    {
      "id": 1,
      "title": "系统维护通知",
      "content": "今晚 22:00-23:00 服务维护",
      "type": "warning"
    }
  ],
  "remoteConfig": {
    "plugin:water-reminder:enabled": false
  },
  "update": null
}
```

> 注意：`plugins[].config` 中的敏感字段（如密码）客户端上报时应脱敏处理（用 `***` 替代）。

---

### 模块 4：用户管理界面

> 优先级：🟡 P1

#### 4.1 新增文件

| 文件                    | 说明                       |
| ----------------------- | -------------------------- |
| `views/users.ejs`       | 用户列表页面               |
| `views/user-detail.ejs` | 用户详情页面（含配置信息） |

#### 4.2 功能点

- [ ] 用户列表页：展示所有注册客户端
  - 用户名、平台、版本、最后心跳时间、在线状态
  - 支持按用户名搜索
  - 支持按在线/离线筛选
  - 支持按平台筛选
- [ ] 用户详情页：展示单个客户端完整信息
  - 基本信息（userId、clientId、平台、版本）
  - 完整插件配置列表（从 `plugin_config` JSON 解析展示）
  - 心跳历史（首次上线、最后在线时间）
- [ ] 在线/离线状态指示（绿/灰圆点）

#### 4.3 页面路由

| 路由                     | 方法 | 说明     |
| ------------------------ | ---- | -------- |
| `/admin/users`           | GET  | 用户列表 |
| `/admin/users/:clientId` | GET  | 用户详情 |

#### 4.4 API 路由（给页面 AJAX 调用）

| 路由                         | 方法 | 说明                                 |
| ---------------------------- | ---- | ------------------------------------ |
| `/api/admin/users`           | GET  | 获取用户列表（支持分页、搜索、筛选） |
| `/api/admin/users/:clientId` | GET  | 获取单个用户详情                     |

---

### 模块 5：统计 Dashboard

> 优先级：🟡 P1

#### 5.1 新增文件

| 文件                  | 说明                |
| --------------------- | ------------------- |
| `views/dashboard.ejs` | 概览 Dashboard 页面 |
| `services/stats.js`   | 统计数据计算服务    |

#### 5.2 功能点

- [ ] **概览卡片**
  - 总注册用户数
  - 当前在线用户数
  - 已发布插件数
  - 今日 AI 调用次数
- [ ] **插件使用统计**（柱状图）
  - 每个插件的启用人数
  - 可切换查看：当日活跃 / 历史总量
- [ ] **用户活跃趋势**（折线图）
  - 最近 7 天 / 30 天日活用户数
- [ ] **平台分布**（饼图）
  - Windows / macOS / Linux 占比
- [ ] **版本分布**（表格 / 饼图）
  - 各插件版本的用户分布
- [ ] **最近上线用户**（列表）
  - 最新 10 个发送心跳的用户

#### 5.3 页面路由

| 路由               | 方法 | 说明           |
| ------------------ | ---- | -------------- |
| `/admin/dashboard` | GET  | 统计 Dashboard |

#### 5.4 API 路由

| 路由                         | 方法 | 说明                             |
| ---------------------------- | ---- | -------------------------------- |
| `/api/admin/stats/overview`  | GET  | 概览数据                         |
| `/api/admin/stats/plugins`   | GET  | 插件使用统计                     |
| `/api/admin/stats/trend`     | GET  | 用户活跃趋势（参数：days=7\|30） |
| `/api/admin/stats/platforms` | GET  | 平台分布                         |

---

### 模块 6：插件管理界面

> 优先级：🟡 P1

#### 6.1 新增文件

| 文件                       | 说明             |
| -------------------------- | ---------------- |
| `views/plugins.ejs`        | 插件管理页面     |
| `views/plugin-publish.ejs` | 插件发布表单页面 |

#### 6.2 功能点

- [ ] **插件列表**
  - 展示 manifest.json 中所有已发布的插件
  - 显示：插件名、版本、hash、更新时间、更新日志
  - 操作按钮：更新、回滚、删除、配置灰度
- [ ] **发布/更新插件**
  - Web 表单上传 `.js` 文件
  - 填写：类型（plugin/core）、ID、版本号、更新日志、名称、描述
  - 复用现有 `POST /api/admin/publish` 接口
- [ ] **版本回滚**
  - 展示 `archive/` 目录下的历史版本列表
  - 一键回滚到指定版本
  - 回滚操作记录审计日志
- [ ] **删除插件**
  - 从 manifest 中移除（复用现有 `DELETE /api/admin/plugins/:id`）
  - 可选：同时删除文件
- [ ] **下载插件文件**
  - 管理端可下载当前版本和历史版本的 `.js` 文件

#### 6.3 页面路由

| 路由                     | 方法 | 说明         |
| ------------------------ | ---- | ------------ |
| `/admin/plugins`         | GET  | 插件列表     |
| `/admin/plugins/publish` | GET  | 发布表单页面 |

#### 6.4 新增 API 路由

| 路由                              | 方法 | 说明             |
| --------------------------------- | ---- | ---------------- |
| `/api/admin/plugins/:id/rollback` | POST | 回滚到指定版本   |
| `/api/admin/plugins/:id/archive`  | GET  | 获取历史版本列表 |

---

### 模块 7：灰度发布

> 优先级：🟡 P1

#### 7.1 新增文件

| 文件                    | 说明             |
| ----------------------- | ---------------- |
| `services/grayscale.js` | 灰度发布决策引擎 |
| `views/grayscale.ejs`   | 灰度规则管理页面 |

#### 7.2 功能点

- [ ] **灰度策略管理**
  - 新建灰度规则（关联插件 ID + 目标版本）
  - 支持三种策略：
    - `percentage`：按百分比灰度（如 30% 用户先更新）
    - `whitelist`：按 clientId 白名单指定
    - `platform`：按平台灰度（如先推 macOS）
  - 启用/禁用/删除灰度规则
- [ ] **灰度决策逻辑**
  - 客户端心跳时，检查是否命中灰度规则
  - 命中则在心跳响应中下发更新指令
  - 未命中则返回当前稳定版本
  - `percentage` 策略使用 `clientId` 的 hash 取模实现一致性分配
- [ ] **灰度监控**
  - 查看灰度版本的实际覆盖用户数
  - 灰度版本用户的版本分布
- [ ] **灰度转全量**
  - 一键将灰度版本转为全量发布（更新 manifest + 删除灰度规则）

#### 7.3 灰度决策流程

```
客户端心跳 → 服务端收到 clientId + plugins 信息
           ↓
     检查 grayscale_rules 表
           ↓
     [无灰度规则] → 返回 manifest 中的稳定版本
           ↓
     [有灰度规则] → 判断是否命中:
        - percentage: hash(clientId) % 100 < percentage → 命中
        - whitelist:  clientId in whitelist → 命中
        - platform:   client.platform in platforms → 命中
           ↓
     [命中] → 心跳响应中 update 字段携带灰度版本信息
     [未命中] → 返回稳定版本 / 不更新
```

#### 7.4 页面路由

| 路由                      | 方法 | 说明             |
| ------------------------- | ---- | ---------------- |
| `/admin/grayscale`        | GET  | 灰度规则列表     |
| `/admin/grayscale/create` | GET  | 创建灰度规则页面 |

#### 7.5 API 路由

| 路由                               | 方法   | 说明             |
| ---------------------------------- | ------ | ---------------- |
| `/api/admin/grayscale`             | GET    | 获取所有灰度规则 |
| `/api/admin/grayscale`             | POST   | 创建灰度规则     |
| `/api/admin/grayscale/:id`         | PUT    | 更新灰度规则     |
| `/api/admin/grayscale/:id`         | DELETE | 删除灰度规则     |
| `/api/admin/grayscale/:id/promote` | POST   | 灰度转全量       |

---

### 模块 8：操作审计日志

> 优先级：🟢 P2

#### 8.1 新增文件

| 文件                   | 说明             |
| ---------------------- | ---------------- |
| `services/audit.js`    | 审计日志写入服务 |
| `views/audit-logs.ejs` | 审计日志查看页面 |

#### 8.2 功能点

- [ ] **自动记录以下操作**
  - 管理员登录 / 登出
  - 插件发布 / 更新 / 删除 / 回滚
  - 灰度规则创建 / 修改 / 删除 / 转全量
  - 公告发布 / 修改 / 删除
  - 远程配置创建 / 修改 / 删除
- [ ] **日志查看页面**
  - 按时间倒序展示
  - 支持按操作类型筛选
  - 支持按日期范围筛选
  - 展示操作详情（JSON 格式化展示）

#### 8.3 审计服务 API

```javascript
// 内部调用接口（非 HTTP API）
audit.log({
  action: "publish", // 操作类型
  target: "ai-memo", // 操作对象
  operator: "admin", // 操作者
  detail: { version: "1.2.0", changelog: "..." },
  ipAddress: req.ip,
});
```

#### 8.4 页面路由

| 路由                | 方法 | 说明         |
| ------------------- | ---- | ------------ |
| `/admin/audit-logs` | GET  | 审计日志列表 |

#### 8.5 API 路由

| 路由                    | 方法 | 说明                        |
| ----------------------- | ---- | --------------------------- |
| `/api/admin/audit-logs` | GET  | 获取日志列表（分页 + 筛选） |

---

### 模块 9：公告推送

> 优先级：🟢 P2

#### 9.1 新增文件

| 文件                          | 说明         |
| ----------------------------- | ------------ |
| `views/announcements.ejs`     | 公告管理页面 |
| `views/announcement-form.ejs` | 公告编辑表单 |

#### 9.2 功能点

- [ ] **发布公告**
  - 填写标题、内容（支持简单 markdown）
  - 选择类型：info / warning / critical
  - 选择目标：全部用户 / 指定客户端
  - 设置过期时间（可选）
- [ ] **管理公告**
  - 公告列表：启用/禁用/编辑/删除
  - 查看已读/未读状态统计
- [ ] **客户端获取公告**
  - 心跳响应中自动携带未读公告
  - 客户端展示后调用已读接口标记

#### 9.3 页面路由

| 路由                            | 方法 | 说明         |
| ------------------------------- | ---- | ------------ |
| `/admin/announcements`          | GET  | 公告列表     |
| `/admin/announcements/create`   | GET  | 发布公告页面 |
| `/admin/announcements/:id/edit` | GET  | 编辑公告页面 |

#### 9.4 API 路由

| 路由                                 | 方法   | 说明           |
| ------------------------------------ | ------ | -------------- |
| `/api/admin/announcements`           | GET    | 获取公告列表   |
| `/api/admin/announcements`           | POST   | 发布公告       |
| `/api/admin/announcements/:id`       | PUT    | 更新公告       |
| `/api/admin/announcements/:id`       | DELETE | 删除公告       |
| `/api/client/announcements/:id/read` | POST   | 客户端标记已读 |

---

### 模块 10：远程配置下发

> 优先级：🟢 P2

#### 10.1 新增文件

| 文件                      | 说明             |
| ------------------------- | ---------------- |
| `views/remote-config.ejs` | 远程配置管理页面 |

#### 10.2 功能点

- [ ] **管理远程配置**
  - 新增/编辑/删除配置项
  - 支持的配置键格式和用途：
    - `plugin:<pluginId>:enabled` → 强制启用/禁用某插件
    - `plugin:<pluginId>:config:<key>` → 覆盖插件某个配置项
    - `global:<key>` → 全局配置（如 AI 功能总开关）
  - 设置配置目标（全部 / 指定客户端）
- [ ] **客户端应用配置**
  - 心跳响应中携带 `remoteConfig` 对象
  - 客户端合并远程配置到本地（远程优先级高于本地）
  - 客户端 UI 中标记被远程管控的配置项（灰色不可编辑）

#### 10.3 页面路由

| 路由                   | 方法 | 说明         |
| ---------------------- | ---- | ------------ |
| `/admin/remote-config` | GET  | 远程配置管理 |

#### 10.4 API 路由

| 路由                           | 方法   | 说明         |
| ------------------------------ | ------ | ------------ |
| `/api/admin/remote-config`     | GET    | 获取所有配置 |
| `/api/admin/remote-config`     | POST   | 创建配置     |
| `/api/admin/remote-config/:id` | PUT    | 更新配置     |
| `/api/admin/remote-config/:id` | DELETE | 删除配置     |

---

### 模块 11：AI 调用统计

> 优先级：🟢 P2

#### 11.1 新增文件

| 文件                        | 说明                  |
| --------------------------- | --------------------- |
| `middleware/api-tracker.js` | AI API 调用追踪中间件 |
| `views/api-stats.ejs`       | AI 调用统计页面       |

#### 11.2 功能点

- [ ] **自动追踪 AI 接口调用**
  - 在 `/api/ai/*` 路由上挂载追踪中间件
  - 记录：接口路径、调用方 clientId/userId、耗时、状态（成功/失败）、错误信息
  - 可选：记录 Token 消耗（如果 LLM SDK 返回了 usage 信息）
- [ ] **统计展示**
  - 今日 / 本周 / 本月调用次数和趋势
  - 按接口分类的调用量
  - 按用户分类的调用量排行
  - 平均响应时间
  - 错误率
  - Token 消耗汇总（可选）
- [ ] **用量告警**（可选）
  - 每日调用达到阈值时在 Dashboard 提示

#### 11.3 中间件设计

```javascript
// middleware/api-tracker.js

function apiTracker(req, res, next) {
  const startTime = Date.now();

  // 拦截响应完成事件
  res.on("finish", () => {
    const duration = Date.now() - startTime;
    db.prepare(
      `INSERT INTO api_usage (endpoint, client_id, user_id, status, duration_ms) VALUES (?, ?, ?, ?, ?)`,
    ).run(
      req.path,
      req.headers["x-client-id"],
      req.headers["x-user-id"],
      res.statusCode < 400 ? "success" : "error",
      duration,
    );
  });

  next();
}
```

#### 11.4 页面路由

| 路由               | 方法 | 说明            |
| ------------------ | ---- | --------------- |
| `/admin/api-stats` | GET  | AI 调用统计页面 |

#### 11.5 API 路由

| 路由                         | 方法 | 说明            |
| ---------------------------- | ---- | --------------- |
| `/api/admin/stats/api-usage` | GET  | AI 调用统计数据 |

---

### 模块 12：前端心跳改造

> 优先级：🔴 P0（客户端侧改动）

#### 12.1 修改文件

| 文件                                          | 说明                            |
| --------------------------------------------- | ------------------------------- |
| `assist-frontpage/src/core/updater.js`        | 增加心跳上报逻辑                |
| `assist-frontpage/src/core/plugin-manager.js` | 暴露获取 userId/userName 的接口 |

#### 12.2 用户信息获取方案

用户信息从客户端 IM 的 **localStorage** 中获取，key 格式为 `{appId}auth`。

**localStorage 数据位置**：

- key 名称规律：遍历 `localStorage` 找到以 `auth` 结尾的 key（如 `ik1qhwwyj5r3pauth`）
- 其中 `ik1qhwwyj5r3p` 是应用 ID（不同环境可能不同），固定后缀为 `auth`

**原始数据结构**（`localStorage.getItem('{appId}auth')` 解析后）：

```json
{
  "data": {
    "isExecutive": 0,
    "name": "朱枫",
    "portrait": "https://oa.epoint.com.cn/950soa/rest/mobileattachaction/getUserPicture?...",
    "id": "3e3240b1-fdcc-448c-a25c-3706bdb79032",
    "token": "aO07XEqHd...",
    "code": "CosV2fi...",
    "companyId": "J_h8odzPSTotfH0VRKrRhs",
    "deptId": "2bece575-45a8-4667-914e-c3f1e5cefc75",
    "isStaff": true,
    "isModifyPwd": false,
    "orgsInfo": [
      {
        "id": "2bece575-45a8-4667-914e-c3f1e5cefc75",
        "name": "技术架构部",
        "type": 1,
        "order": 9999,
        "path": [
          {
            "id": "J_h8odzPSTotfH0VRKrRhs",
            "name": "国泰新点软件股份有限公司",
            "type": 2
          },
          { "id": "...", "name": "新点软件", "type": 1 },
          { "id": "...", "name": "产品和解决方案体系", "type": 1 },
          { "id": "...", "name": "政务BG", "type": 1 },
          { "id": "...", "name": "技术架构部", "type": 1 }
        ]
      }
    ],
    "display_mobile": 0,
    "rceToken": "akpsWgVLQ3As..."
  },
  "type": "object"
}
```

**字段提取映射**：

| 心跳上报字段           | 来源路径                        | 说明                                 |
| ---------------------- | ------------------------------- | ------------------------------------ |
| `userInfo.id`          | `data.id`                       | 用户唯一 ID (GUID)                   |
| `userInfo.name`        | `data.name`                     | 用户姓名                             |
| `userInfo.portrait`    | `data.portrait`                 | 头像 URL                             |
| `userInfo.companyId`   | `data.companyId`                | 公司 ID                              |
| `userInfo.companyName` | `data.orgsInfo[0].path[0].name` | 公司名称（组织路径中 type=2 的节点） |
| `userInfo.deptId`      | `data.deptId`                   | 部门 ID                              |
| `userInfo.deptName`    | `data.orgsInfo[0].name`         | 部门名称                             |
| `userInfo.isStaff`     | `data.isStaff`                  | 是否在职员工                         |

> ⚠️ **安全要求**：`token`、`code`、`rceToken` 等鉴权字段**严禁上报**到服务端。

**前端提取代码参考**：

```javascript
/**
 * 从 localStorage 中读取当前 IM 用户信息
 * key 格式: {appId}auth，遍历查找以 'auth' 结尾的 key
 */
function getUserInfoFromStorage() {
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (key && key.endsWith("auth") && key.length > 4) {
        const raw = localStorage.getItem(key);
        const parsed = JSON.parse(raw);
        if (parsed && parsed.data && parsed.data.id) {
          const d = parsed.data;
          const orgInfo = d.orgsInfo && d.orgsInfo[0];
          const companyNode = orgInfo?.path?.find((p) => p.type === 2);
          return {
            id: d.id,
            name: d.name,
            portrait: d.portrait || "",
            companyId: d.companyId || "",
            companyName: companyNode?.name || "",
            deptId: d.deptId || "",
            deptName: orgInfo?.name || "",
            isStaff: d.isStaff || false,
          };
        }
      }
    }
  } catch (e) {
    console.error("[Heartbeat] 读取用户信息失败:", e);
  }
  // fallback: 从 RongIM 运行时对象获取基础信息
  try {
    const auth = window.RongIM?.instance?.auth;
    if (auth && auth.id) {
      return { id: auth.id, name: auth.name || auth.id };
    }
  } catch (e) {}
  return null;
}
```

> 已有参考实现：`now-playing` 插件的 `getAccessToken()` 方法（遍历 localStorage 查找 `tokenname` key），以及 `work-log-summary` 插件的 `_getCurrentUserId()` 方法（从 `window.RongIM.instance.auth` 获取 ID）。

#### 12.3 功能点

- [ ] **生成并持久化 clientId**
  - 首次启动时生成 UUID 并存储到 `.version.json`
  - 后续每次启动读取已有 clientId
- [ ] **从 localStorage 读取用户信息**
  - 遍历 localStorage 查找以 `auth` 结尾的 key
  - 解析 JSON，提取 `data` 中的用户字段
  - 过滤掉 `token`、`code`、`rceToken` 等敏感字段
  - Fallback：从 `window.RongIM.instance.auth` 获取基础信息
- [ ] **定时心跳上报**
  - 启动后 10 秒首次上报
  - 之后每 30 分钟上报一次
  - 收集当前用户信息 + 插件配置
  - 发送到 `POST /api/client/heartbeat`
- [ ] **处理心跳响应**
  - 获取并展示公告通知
  - 应用远程配置（与本地配置合并）
  - 处理灰度更新指令
- [ ] **插件配置脱敏**
  - 上报时自动将 `password` 等敏感字段替换为 `***`

---

## 四、目录结构规划

```text
assist-backend/
├── server.js                    ← 主入口（修改：挂载新路由和中间件）
├── config/
│   └── index.js                 ← 配置（修改：新增管理后台相关配置）
├── database/
│   └── index.js                 ← ⭐ 新增：SQLite 初始化 & 建表
├── data/
│   └── assist.db                ← ⭐ 新增：SQLite 数据库文件（.gitignore）
├── middleware/
│   ├── auth.js                  ← 现有：API 鉴权
│   ├── error-handler.js         ← 现有
│   ├── session.js               ← ⭐ 新增：Session 配置
│   └── api-tracker.js           ← ⭐ 新增：AI 调用追踪
├── routes/
│   ├── ai-summary.js            ← 现有
│   ├── ai-memo.js               ← 现有
│   ├── ai-work-log.js           ← 现有
│   ├── admin.js                 ← 现有（修改：增加新管理 API）
│   ├── health.js                ← 现有
│   ├── client.js                ← ⭐ 新增：客户端心跳 API
│   └── dashboard.js             ← ⭐ 新增：管理后台页面路由
├── services/
│   ├── llm.js                   ← 现有
│   ├── stats.js                 ← ⭐ 新增：统计计算服务
│   ├── audit.js                 ← ⭐ 新增：审计日志服务
│   └── grayscale.js             ← ⭐ 新增：灰度发布决策引擎
├── views/                       ← ⭐ 新增目录
│   ├── layout.ejs               ← 公共布局
│   ├── login.ejs                ← 登录页
│   ├── dashboard.ejs            ← 概览 Dashboard
│   ├── users.ejs                ← 用户列表
│   ├── user-detail.ejs          ← 用户详情
│   ├── plugins.ejs              ← 插件管理
│   ├── plugin-publish.ejs       ← 插件发布
│   ├── grayscale.ejs            ← 灰度规则管理
│   ├── announcements.ejs        ← 公告管理
│   ├── announcement-form.ejs    ← 公告编辑
│   ├── remote-config.ejs        ← 远程配置
│   ├── api-stats.ejs            ← AI 调用统计
│   └── audit-logs.ejs           ← 审计日志
├── public/
│   ├── manifest.json            ← 现有
│   ├── core/                    ← 现有
│   ├── plugins/                 ← 现有
│   ├── archive/                 ← 现有
│   └── admin/                   ← ⭐ 新增
│       ├── css/
│       │   └── style.css        ← 管理后台样式
│       └── js/
│           └── dashboard.js     ← 管理后台前端逻辑（图表等）
├── scripts/
│   └── publish.sh               ← 现有
├── .env.example                 ← 修改：新增管理后台配置项
├── .gitignore                   ← 修改：忽略 data/ 目录
├── package.json                 ← 修改：新增依赖
├── FEATURE-SPEC.md              ← 本文件
└── README.md                    ← 修改：补充管理后台文档
```

---

## 五、环境变量新增

在现有 `.env.example` 基础上追加：

```env
# ========== 管理后台 ==========
# 管理后台登录用户名
ADMIN_USERNAME=admin

# 管理后台登录密码（建议使用强密码）
ADMIN_PASSWORD=your-secure-password

# Session 密钥（随机字符串，用于加密 cookie）
SESSION_SECRET=change-me-to-random-string

# Session 过期时间（小时），默认 24 小时
SESSION_MAX_AGE=24

# ========== 客户端心跳 ==========
# 客户端离线判定阈值（秒），超过此时间无心跳视为离线，默认 7200 (2小时)
CLIENT_OFFLINE_THRESHOLD=7200
```

---

## 六、新增依赖

```json
{
  "dependencies": {
    "better-sqlite3": "^11.0.0",
    "express-session": "^1.18.0",
    "bcryptjs": "^2.4.3",
    "ejs": "^3.1.10",
    "connect-sqlite3": "^0.9.15",
    "uuid": "^10.0.0"
  }
}
```

| 依赖              | 说明                                  |
| ----------------- | ------------------------------------- |
| `better-sqlite3`  | SQLite 驱动，同步 API、高性能         |
| `express-session` | Express Session 中间件                |
| `bcryptjs`        | 密码哈希（纯 JS，无需 node-gyp 编译） |
| `ejs`             | 模板引擎，服务端渲染管理页面          |
| `connect-sqlite3` | Session 存储适配器（存入 SQLite）     |
| `uuid`            | UUID 生成（客户端 clientId 候选方案） |

---

## 七、实施优先级

### 🔴 P0 — 核心基础（必须先做）

| 序号 | 模块                       | 预计工时 |
| ---- | -------------------------- | -------- |
| 1    | 模块 1：数据库基础设施     | 0.5h     |
| 2    | 模块 2：管理后台登录       | 1.5h     |
| 3    | 模块 3：客户端心跳上报 API | 1h       |
| 4    | 模块 12：前端心跳改造      | 1h       |

### 🟡 P1 — 核心业务（紧随其后）

| 序号 | 模块                   | 预计工时 |
| ---- | ---------------------- | -------- |
| 5    | 模块 4：用户管理界面   | 2h       |
| 6    | 模块 5：统计 Dashboard | 2.5h     |
| 7    | 模块 6：插件管理界面   | 2h       |
| 8    | 模块 7：灰度发布       | 2.5h     |

### 🟢 P2 — 辅助增强（后续迭代）

| 序号 | 模块                  | 预计工时 |
| ---- | --------------------- | -------- |
| 9    | 模块 8：操作审计日志  | 1.5h     |
| 10   | 模块 9：公告推送      | 2h       |
| 11   | 模块 10：远程配置下发 | 1.5h     |
| 12   | 模块 11：AI 调用统计  | 2h       |

---

## 📌 备注

- 管理后台 UI 以 **简洁实用** 为主，使用 EJS 服务端渲染 + 少量 CSS 样式
- 图表使用 Chart.js 通过 CDN 引入，无需额外构建工具
- SQLite 数据库文件存储在 `data/` 目录，需确保该目录被 `.gitignore` 忽略
- 所有管理页面均需登录（Session 鉴权），现有 API 鉴权（`ADMIN_KEY`）保持不变
- 灰度发布与现有 OTA 更新机制集成，通过心跳响应下发更新指令
