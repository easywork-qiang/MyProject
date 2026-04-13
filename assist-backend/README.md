# rongcloud-assist 后端服务

为「新点即时通讯插件系统」提供后端支撑，包含 AI 总结服务和插件更新分发。

## 快速开始

```bash
# 1. 安装依赖
npm install

# 2. 创建并配置环境变量
cp .env.example .env
# 编辑 .env，至少配置 LLM_API_KEY

# 3. 同步前端插件文件到 public 目录（首次需要）
chmod +x scripts/publish.sh
./scripts/publish.sh sync

# 4. 启动服务
npm run dev
```

## 目录结构

```
assist-backend/
├── server.js               ← 主入口
├── config/
│   └── index.js             ← 配置管理
├── routes/
│   ├── ai-summary.js        ← POST /api/ai/summary（AI 总结）
│   ├── admin.js             ← 管理接口（发布插件）
│   └── health.js            ← 健康检查
├── services/
│   └── llm.js               ← LLM 调用封装
├── middleware/
│   ├── auth.js              ← 鉴权中间件
│   └── error-handler.js     ← 错误处理
├── public/                  ← 静态文件（客户端更新源）
│   ├── manifest.json        ← 版本清单
│   ├── core/                ← 核心组件文件
│   └── plugins/             ← 插件文件
├── scripts/
│   └── publish.sh           ← 发布脚本
├── .env.example             ← 环境变量模板
└── package.json
```

## API 接口

### AI 总结

```bash
# 调用 AI 总结
curl -X POST http://localhost:8080/api/ai/summary \
  -H "Content-Type: application/json" \
  -d '{
    "messages": [{"role": "user", "content": "请总结以下群聊消息..."}],
    "metadata": {"groupId": "group123", "groupName": "测试群"}
  }'

# 查看 AI 服务状态
curl http://localhost:8080/api/ai/status
```

### 插件更新

客户端 `updater.js` 配置的更新地址指向：

```
http://<服务器地址>:8080/manifest.json
```

### 管理接口

```bash
# 查看当前 manifest
curl http://localhost:8080/api/admin/manifest \
  -H "Authorization: Bearer <ADMIN_KEY>"

# 发布插件更新
curl -X POST http://localhost:8080/api/admin/publish \
  -H "Authorization: Bearer <ADMIN_KEY>" \
  -F "type=plugin" \
  -F "id=group-ai-summary" \
  -F "version=1.2.0" \
  -F "changelog=优化总结质量" \
  -F "file=@../assist-frontpage/src/plugins/group-ai-summary.js"

# 或使用发布脚本（更方便）
./scripts/publish.sh plugin group-ai-summary 1.2.0 \
  ../assist-frontpage/src/plugins/group-ai-summary.js "优化总结质量"

# 移除插件
curl -X DELETE http://localhost:8080/api/admin/plugins/some-plugin \
  -H "Authorization: Bearer <ADMIN_KEY>"
```

### 健康检查

```bash
curl http://localhost:8080/api/health
```

## 生产部署

```bash
# 安装 PM2
npm install -g pm2

# 启动服务（2 个进程）
pm2 start server.js -i 2 --name assist-backend

# 查看状态
pm2 status

# 查看日志
pm2 logs assist-backend
```

## LLM 供应商配置

在 `.env` 中配置 `LLM_BASE_URL` 和 `LLM_MODEL` 即可切换不同供应商：

| 供应商      | LLM_BASE_URL                                        | LLM_MODEL       |
| ----------- | --------------------------------------------------- | --------------- |
| OpenAI      | `https://api.openai.com/v1`                         | `gpt-4o-mini`   |
| 通义千问    | `https://dashscope.aliyuncs.com/compatible-mode/v1` | `qwen-turbo`    |
| DeepSeek    | `https://api.deepseek.com`                          | `deepseek-chat` |
| 本地 Ollama | `http://localhost:11434/v1`                         | `qwen2.5`       |
