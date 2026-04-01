# Aliyun Deploy Status

更新时间: `2026-04-02`

## Current State

`newagent` 已经同步到阿里云服务器：

- 代码目录：`/root/newagent`
- 命令目录：`/root/newagent/code`
- 运行数据目录：`/root/newagent/storage`

已完成：

- 代码同步到远端
- `npm install` 完成
- `manager bootstrap` 通过
- `manager intake-message` 命令可运行
- 远端最新代码已同步
- 远端 `npm run test:all` 已复核通过：
  - Node 测试 `112/112`
  - worker 测试 `5/5`
- 飞书长连接加密密钥和校验 token 已纳入代码配置面
- 百炼规划调用已改成：
  - 路由语义：`codingplan`
  - 实际模型：`qwen3.5-plus`
  - 请求附带：`extra_body.enable_thinking=true`
- 飞书长连接前台验证通过
- `pm2` 常驻进程已上线：
  - 进程名：`newagent-manager`
  - 入口：`pm2/ecosystem.config.cjs`
  - 最新代码已完成重启生效并 `pm2 save`
- 本地已补齐 Scrapling worker：
  - 路径：`code/workers/scrapling_worker/app.py`
  - PM2 配置：`code/pm2/scrapling-worker.config.cjs`
  - 对接接口：`GET /healthz`、`POST /v1/extract`
- 远端 Scrapling worker 已上线：
  - 进程名：`newagent-scrapling-worker`
  - 常驻方式：`pm2`
  - `NEWAGENT_SCRAPLING_BASE_URL=http://127.0.0.1:7771`
- Alibaba Cloud Linux 3 上的浏览器依赖已手工装好：
  - 运行库通过 `yum install` 补齐
  - `python3 -m playwright install chromium`
  - `python3 -m patchright install chromium`
- 远端网页提取接口已实际验证通过：
  - `/healthz` 返回正常
  - `/v1/extract` 已对 `static / dynamic / stealth` 三种模式完成真实请求验证
  - 验证样例：`https://example.com` + `selector=h1`

## Verified Commands

这些命令已经在远端实际执行通过：

```bash
cd /root/newagent/code
node ./bin/newagent.js profile show --json
node ./bin/newagent.js manager bootstrap --storage-root /root/newagent/storage --json
npm run test:all
curl -s http://127.0.0.1:7771/healthz
curl -s http://127.0.0.1:7771/v1/extract \
  -H 'Content-Type: application/json' \
  -d '{"url":"https://example.com","mode":"static","selector":"h1","output":"text"}'
```

这条命令也已验证为“可优雅降级”：

```bash
cd /root/newagent/code
node ./bin/newagent.js manager intake-message \
  --storage-root /root/newagent/storage \
  --text "盘一下服务器上的股票项目" \
  --json
```

当前本地代码已经支持真实百炼 key 和真实飞书长连接配置。
后续远端只需要保持 `.env` 正确并重启常驻进程。
网页提取工具也已经接回总管 runtime，不再是待接入状态。

如果先只想验证执行面，也可以在远端跑：

```bash
cd /root/newagent/code
node ./bin/newagent.js manager step-run --storage-root /root/newagent/storage --session-id <session-id> --json
node ./bin/newagent.js manager loop-run --storage-root /root/newagent/storage --session-id <session-id> --max-steps 4 --json
```

## Missing Runtime Inputs

远端关键环境变量已经补齐：

- `NEWAGENT_BAILIAN_API_KEY`
- `NEWAGENT_FEISHU_APP_ID`
- `NEWAGENT_FEISHU_APP_SECRET`
- `NEWAGENT_FEISHU_ENCRYPT_KEY`
- `NEWAGENT_FEISHU_VERIFICATION_TOKEN`

## Remaining Acceptance Gaps

这些动作已经执行：

- `pm2 start pm2/ecosystem.config.cjs --only newagent-manager`
- 飞书长连接真实登录
- 百炼真实规划调用
- `manager intake-message` 已完成真实规划和首轮巡检
- `review / report / repair` 已接入自动 manager loop
- 最新代码已同步到阿里云并完成 `pm2 restart newagent-manager`
- `pm2 restart newagent-scrapling-worker`
- `web_extract_scrapling` 已完成线上 worker 接入与三种模式实测

这些动作还没执行：

- 用飞书真实发一条消息验证线上长连接收消息
- 用一次真实审批跑通 `codex repair` 在线闭环
- 把 `operate / deploy` 步骤接入真实自动执行

## Next Step

当前剩下这三件事：

1. 用飞书真实发一条消息验证线上长连接收消息
2. 用一次真实审批跑通 `codex repair` 在线闭环
3. 把 `operate / deploy` 步骤接入真实自动执行

Alibaba Cloud Linux 3 上 Scrapling worker 的已验证启动方式：

```bash
cd /root/newagent/code
python3 -m pip install -r ./workers/scrapling_worker/requirements.txt
yum install -y atk at-spi2-atk at-spi2-core libXcomposite libXdamage libXfixes libXrandr mesa-libgbm pango alsa-lib gtk3 libdrm libxkbcommon libX11 libXcursor libXext libXi libXinerama libXScrnSaver libXtst cups-libs dbus-libs nss nspr liberation-fonts fontconfig
python3 -m playwright install chromium
python3 -m patchright install chromium
pm2 start pm2/scrapling-worker.config.cjs --only newagent-scrapling-worker
curl -s http://127.0.0.1:7771/healthz
```
