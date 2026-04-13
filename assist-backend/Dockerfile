# ============================================================
#  rongcloud-assist-backend Dockerfile
#  Node.js Express 后端服务
# ============================================================

# ---------- 阶段 1: 安装依赖 ----------
FROM node:20-alpine AS deps

WORKDIR /app

# 配置国内镜像加速
RUN npm config set registry https://registry.npmmirror.com

# 只复制 package 文件，利用 Docker 缓存层加速后续构建
COPY package.json package-lock.json ./

# 仅安装生产依赖
RUN npm ci --omit=dev

# ---------- 阶段 2: 生产镜像 ----------
FROM node:20-alpine AS runner

# 配置 Alpine apk 阿里云镜像 + 安装 tini
RUN sed -i 's/dl-cdn.alpinelinux.org/mirrors.aliyun.com/g' /etc/apk/repositories \
    && apk add --no-cache tini

# 创建非 root 用户
RUN addgroup -S appgroup && adduser -S appuser -G appgroup

WORKDIR /app

# 从 deps 阶段复制已安装好的 node_modules
COPY --from=deps /app/node_modules ./node_modules

# 复制应用源码
COPY config ./config
COPY database ./database
COPY middleware ./middleware
COPY routes ./routes
COPY services ./services
COPY utils ./utils
COPY views ./views
COPY static ./static
COPY server.js ./
COPY package.json ./

# 创建运行时数据目录并赋权
RUN mkdir -p /app/public/plugins /app/public/core /app/public/archive \
    && chown -R appuser:appgroup /app

# 切换为非 root 用户
USER appuser

# 默认暴露端口（HTTP）
EXPOSE 8080

# 持久化存储卷（插件包、核心组件、版本归档）
VOLUME ["/app/public"]



# ======================== 环境变量默认值 ========================
# 部署时可通过 docker run -e 或 --env-file 覆盖

# --- 服务配置 ---
ENV NODE_ENV=production \
    PORT=8080 \
    # --- API 鉴权 ---
    API_KEY= \
    ADMIN_KEY=CHANGE-ME-TO-STRONG-KEY \
    # --- 数据库（MySQL） ---
    MYSQL_HOST=mysql \
    MYSQL_PORT=3306 \
    MYSQL_USER=assist \
    MYSQL_PASSWORD=CHANGE-ME-DB-PASSWORD \
    MYSQL_DATABASE=rongcloud-assist \
    # --- LLM 配置 ---
    LLM_API_KEY=sk-your-api-key-here \
    LLM_BASE_URL=https://api.deepseek.com \
    LLM_MODEL=deepseek-chat \
    LLM_TIMEOUT=60 \
    LLM_MAX_CONCURRENCY=10 \
    # --- 缓存 ---
    CACHE_TTL=300 \
    # --- 管理后台 ---
    ADMIN_USERNAME=admin \
    ADMIN_PASSWORD=CHANGE-ME-ADMIN-PASSWORD \
    SESSION_SECRET=CHANGE-ME-RANDOM-SESSION-SECRET \
    SESSION_MAX_AGE=24 \
    # --- 客户端心跳 ---
    CLIENT_OFFLINE_THRESHOLD=7200

# 健康检查
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
    CMD wget -qO- http://localhost:${PORT}/api/health || exit 1

# 使用 tini 作为入口，正确处理信号
ENTRYPOINT ["/sbin/tini", "--"]

# 启动服务
CMD ["node", "server.js"]
