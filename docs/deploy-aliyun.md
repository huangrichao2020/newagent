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
- `NEWAGENT_STORAGE_ROOT`
- `NEWAGENT_SCRAPLING_BASE_URL`

参考模板：

- [code/.env.example](/Users/tingchi/Desktop/newagent/code/.env.example)

推荐做法：

- 把真实配置写到 `/root/newagent/code/.env`
- `newagent` 会在启动时自动读取 `code/.env`
- 如果不用默认位置，也可以设置 `NEWAGENT_ENV_FILE`

## Install

```bash
mkdir -p /root/newagent
rsync -az ./ /root/newagent/
cd /root/newagent/code
npm install
mkdir -p /root/newagent/storage
cp .env.example .env
python3 -m pip install -r ./workers/scrapling_worker/requirements.txt
```

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
cd /root/newagent/code
node ./bin/newagent.js manager feishu-serve --storage-root /root/newagent/storage
```

PM2 启动：

```bash
cd /root/newagent/code
pm2 start pm2/ecosystem.config.cjs --only newagent-manager
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
- 为每条飞书消息创建一个总管会话
- 自动调用百炼 Coding Plan 通道上的 `qwen3.5-plus`
  - 规划语义仍然标记为 `codingplan`
  - 请求体会附带 `extra_body.enable_thinking=true`
- 自动回一条中文确认摘要
- 自动推进第一版 manager loop
  - 读取项目注册表
  - 读取单个项目信息
  - 读取 PM2 进程状态
  - 检查源码 / runtime / publish 路径
  - 探活项目服务端点
  - 在 `report` 步骤生成阶段汇报
  - 在 `review` 步骤调用 `codex review`
  - 在 `repair` 步骤进入审批等待
- 在 `NEWAGENT_SCRAPLING_BASE_URL` 已配置且 worker 在线时
  - `web_extract_scrapling` 会转发到 `/v1/extract`
  - 支持 `static / dynamic / stealth`
  - 支持 `text / html / markdown`

还没做到的：

- `operate / deploy` 步骤的真实自动执行
- 飞书真实消息触发后的 repair 审批闭环验收

## Next Deployment Milestones

部署后的下一步顺序建议是：

1. 验证飞书长连接稳定在线
2. 验证百炼调用真实可用
3. 验证收到消息后自动触发规划、loop、回摘要
4. 用一次真实审批跑通 `codex repair`
5. 把 `operate / deploy` 步骤接入真实自动执行
