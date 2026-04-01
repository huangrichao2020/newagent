# Code Workspace

This directory is reserved for runnable prototypes.

Current rule:

- no speculative framework dump
- no fake product shell
- no UI-first implementation

Start here only after the M1 interfaces are frozen in `docs/`.

Recommended initial layout for M1:

```text
code/
├── shell/
│   ├── session/
│   ├── context/
│   ├── planner/
│   ├── tools/
│   ├── permissions/
│   ├── memory/
│   └── ui/
└── storage/
```

The first implementation target is a terminal-first kernel for a remote server manager, not a full desktop app.

Clarification:

- `code/storage/` is for persistence code
- `storage/` at project root is for runtime data

Current implemented slice:

- `config/load-env.js`
- `config/load-env.test.js`
- `shell/session/session-store.js`
- `shell/session/session-store.test.js`
- `shell/cli/session-cli.js`
- `shell/cli/session-cli.test.js`
- `shell/context/context-router.js`
- `shell/context/context-router.test.js`
- `shell/hooks/hook-bus.js`
- `shell/hooks/hook-bus.test.js`
- `shell/memory/memory-store.js`
- `shell/memory/memory-store.test.js`
- `shell/executor/step-executor.js`
- `shell/executor/step-executor.test.js`
- `shell/tools/tool-runtime.js`
- `shell/tools/tool-runtime.test.js`
- `workers/scrapling_worker/app.py`
- `workers/scrapling_worker/tests/test_app.py`
- `storage/json-files.js`

Current tested surface:

- `createSession`
- `loadSession`
- `createPlan`
- `updateSessionStatus`
- `appendTimelineEvent`
- `requestApproval`
- `resolveApproval`
- `abortSession`
- `recoverInterruptedSession`

Current thin command surface:

- `profile show`
- `project seed-aliyun`
- `project list`
- `project get`
- `project register`
- `route resolve`
- `provider invoke`
- `channel feishu-profile`
- `channel feishu-send`
- `manager bootstrap`
- `manager feishu-serve`
- `manager intake-message`
- `manager step-run`
- `manager loop-run`
- `start`
- `plan-create`
- `resume`
- `status`
- `timeline`
- `hooks list`
- `context-build`
- `memory add`
- `memory search`
- `step-run`
- `approve`
- `reject`
- `abort`

Approval continuation:

- `approve --continue`

Current context-router surface:

- `buildExecutionContext`

Current tool-runtime surface:

- `listToolSpecs`
- `executeTool`
- `project_list_registry`
- `project_get_registry`
- `project_pm2_status`
- `project_probe_endpoint`
- `project_check_paths`
- `web_extract_scrapling`
- `codex_review_workspace`
- `codex_repair_workspace`

Current optional worker surface:

- `GET /healthz`
- `POST /v1/extract`

Current executor surface:

- `executeCurrentStep`

Current manager-executor surface:

- `executeCurrentManagerStep`
- `runManagerLoop`

Manual entry:

```bash
npm run cli -- start \
  --title "Draft M1" \
  --project-key newagent \
  --request "Create the first manual shell session" \
  --json
```

Environment loading:

- `node ./bin/newagent.js ...` will auto-load `.env` from `code/.env`
- if `code/.env` is missing, it will also try the parent project `.env`
- `NEWAGENT_ENV_FILE=/abs/path/.env` overrides both
- `NEWAGENT_SCRAPLING_BASE_URL=http://127.0.0.1:7771` enables the Scrapling extraction tool

Scrapling worker:

```bash
cd /root/newagent/code
python3 -m pip install -r ./workers/scrapling_worker/requirements.txt
# Debian / Ubuntu hosts
scrapling install
# Alibaba Cloud Linux 3 fallback: see ../docs/deploy-aliyun.md
python3 ./workers/scrapling_worker/app.py --host 127.0.0.1 --port 7771
```

PM2 entry for the worker:

```bash
cd /root/newagent/code
pm2 start pm2/scrapling-worker.config.cjs --only newagent-scrapling-worker
pm2 save
```

Worker test entry:

```bash
npm run test:workers
```

Reproducible demo:

```bash
npm run demo:m1
npm run demo:m1-approval
```

Manager bootstrap:

```bash
npm run manager:bootstrap
node ./bin/newagent.js manager intake-message \
  --storage-root ./storage \
  --text "检查股票项目发布链" \
  --json
node ./bin/newagent.js manager loop-run \
  --storage-root ./storage \
  --session-id <session-id> \
  --max-steps 4 \
  --json
```
