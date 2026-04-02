# Deploy To Aliyun

## Goal

把 `newagent` 作为远程服务器项目总管部署到阿里云，并通过飞书长连接接收任务。

## Runtime Shape

- 代码目录：`/root/newagent`
- 命令目录：`/root/newagent/code`
- 运行数据：`/root/newagent/storage`
- 常驻方式：`pm2`
- 主入口：`newagent manager feishu-serve`

## Required Environment

最少需要这些环境变量：

- `NEWAGENT_BAILIAN_API_KEY`
- `NEWAGENT_FEISHU_APP_ID`
- `NEWAGENT_FEISHU_APP_SECRET`
- `NEWAGENT_FEISHU_ENCRYPT_KEY`
- `NEWAGENT_FEISHU_VERIFICATION_TOKEN`

可选覆盖：

- `NEWAGENT_BAILIAN_PLANNER_BASE_URL`
- `NEWAGENT_BAILIAN_EXECUTION_BASE_URL`
- `NEWAGENT_BAILIAN_SUMMARIZATION_BASE_URL`
- `NEWAGENT_ENABLE_EXTERNAL_REVIEW`
- `NEWAGENT_EXTERNAL_REVIEW_MODEL`
- `OPENROUTER_API_KEY`
- `NEWAGENT_OPENROUTER_BASE_URL`
- `NEWAGENT_OPENROUTER_APP_NAME`
- `NEWAGENT_OPENROUTER_SITE_URL`
- `NEWAGENT_STORAGE_ROOT`
- `NEWAGENT_SCRAPLING_BASE_URL`

参考模板：

- [code/.env.example](/Users/tingchi/Desktop/newagent/code/.env.example)

推荐做法：

- 远端真实 key 不要放进仓库目录
- 推荐放到 repo 外环境变量，例如 `/root/.config/newagent/env.sh`
- 这个文件可以保持 `.env` 风格的 `KEY=value`
- 进程环境变量优先于 `.env`
- `.env` 只保留给本地开发或临时调试
- 远端默认建议设置 `NEWAGENT_DISABLE_CODEX=true`
- 如需第二裁判，推荐同时设置：
  - `NEWAGENT_ENABLE_EXTERNAL_REVIEW=true`
  - `NEWAGENT_EXTERNAL_REVIEW_MODEL=stepfun/step-3.5-flash:free`
  - `OPENROUTER_API_KEY=...`

## Install

```bash
mkdir -p /root/newagent
rsync -az ./ /root/newagent/
cd /root/newagent/code
npm install
mkdir -p /root/newagent/storage
python3 -m pip install -r ./workers/scrapling_worker/requirements.txt
```

然后在远端 repo 外准备环境变量文件：

```bash
install -d -m 700 /root/.config/newagent
cp /root/newagent/code/.env.example /root/.config/newagent/env.sh
chmod 600 /root/.config/newagent/env.sh
```

完成迁移后，项目目录里的 `code/.env` 可以删除，不再作为远端长期配置基线。

如果目标机是 Debian / Ubuntu，可以继续执行：

```bash
scrapling install
```

如果目标机是 Alibaba Cloud Linux 3，不要直接用 `scrapling install`。
它会在内部调用 `playwright install-deps` 并假设系统存在 `apt-get`。
已验证可用的替代方式是：

```bash
yum install -y atk at-spi2-atk at-spi2-core libXcomposite libXdamage libXfixes libXrandr mesa-libgbm pango alsa-lib gtk3 libdrm libxkbcommon libX11 libXcursor libXext libXi libXinerama libXScrnSaver libXtst cups-libs dbus-libs nss nspr liberation-fonts fontconfig
python3 -m playwright install chromium
python3 -m patchright install chromium
```

## Bootstrap Check

先做本地自检：

```bash
cd /root/newagent/code
node ./bin/newagent.js profile show --json
node ./bin/newagent.js channel feishu-profile --json
node ./bin/newagent.js manager bootstrap --storage-root /root/newagent/storage --json
node ./bin/newagent.js manager intake-message --storage-root /root/newagent/storage --text "盘一下服务器上的股票项目" --json
node ./bin/newagent.js manager loop-run --storage-root /root/newagent/storage --session-id <session-id> --max-steps 4 --json
curl -s http://127.0.0.1:7771/healthz
curl -s http://127.0.0.1:7771/v1/extract \
  -H 'Content-Type: application/json' \
  -d '{"url":"https://example.com","mode":"static","selector":"h1","output":"text"}'
```

## Start

前台启动：

```bash
set -a
source /root/.config/newagent/env.sh
set +a
cd /root/newagent/code
node ./bin/newagent.js manager feishu-serve --storage-root /root/newagent/storage
```

PM2 启动：

```bash
pm2 start /root/.config/newagent/start-manager.sh --name newagent-manager
pm2 save
```

可选启动 Scrapling worker：

```bash
cd /root/newagent/code
pm2 start pm2/scrapling-worker.config.cjs --only newagent-scrapling-worker
pm2 save
```

## Current Behavior

当前这版部署后可以做到：

- 启动飞书长连接
- 使用飞书长连接的加密密钥和校验 token
- 自动加载远端 6 个项目基线
- 接住飞书消息
- 飞书通道固定复用一个统一总管会话
- 用户确认信号会写回 project memory，后续规划会复用
- 自动把最近几轮 transcript 和长期压缩记忆带进 planner
- 后台维护循环每 5 分钟巡检一次，并在 5 小时间隔到点后自动压缩统一会话上下文
- 前台记忆写入与后台压缩互斥，重复触发时会走 pending + trailing run
- 自动调用百炼 Coding Plan 通道上的 `qwen3.5-plus`
  - 规划语义仍然标记为 `codingplan`
  - 请求体会附带 `extra_body.enable_thinking=true`
- 如已启用 OpenRouter 外部复核：
  - 计划结果会先走第二模型复核，再决定是否自动推进
  - 压缩结果会走第二模型复核，并把可复用约束写回 session memory
- 自动回一条中文确认摘要
- 自动推进第一版 manager loop
  - 读取项目注册表
  - 读取单个项目信息
  - 读取 PM2 进程状态
  - 检查源码 / runtime / publish 路径
  - 探活项目服务端点
  - 在 `report` 步骤生成阶段汇报
  - 远端默认不生成 `review / repair`
  - 如需启用 `codex` 适配，需显式关闭 `NEWAGENT_DISABLE_CODEX`
  - 在 `operate / deploy` 步骤调用 execution model 生成 shell 命令
  - 生成后的命令会通过 `run_shell_command` 进入同一套审批流
- 在 `NEWAGENT_SCRAPLING_BASE_URL` 已配置且 worker 在线时
  - `web_extract_scrapling` 会转发到 `/v1/extract`
  - 支持 `static / dynamic / stealth`
  - 支持 `text / html / markdown`

当前运维约束：

- 以远端 `/root/newagent` 为主仓库
- GitHub 从远端更新维护
- 真实 key 留在 repo 外环境变量

## Next Deployment Milestones

部署后的下一步顺序建议是：

1. 固化 repo 外环境变量和 PM2 启动方式
2. 从远端仓库提交并推送 GitHub
3. 开始接管真实线上任务
