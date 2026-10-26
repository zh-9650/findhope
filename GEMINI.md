# GEMINI.md - BOSS 自主求职 Agent 开发规范与架构指南

> **适用对象**：Antigravity / Gemini 及本地代码编写助手  
> **项目定位**：基于 Node.js ESM + SQLite + Claude Code CLI + Ego 浏览器的自动化求职决策与执行系统  
> **核心规范依据**：[`docs/specs/BOSS自主求职Agent_V1.1_独立审查与正式开发实施方案.md`](file:///docs/specs/BOSS自主求职Agent_V1.1_独立审查与正式开发实施方案.md)

---

## 1. 核心开发原则与红线

1. **模块化分批全量推进**：
   - 按照 I0（安全底座） -> I1（持久化存储与调度中枢） -> I2（Ego 只读采集引擎） -> I3（Claude 智能匹配） -> I4（聊天决策与草稿引擎） -> I5（HTML 控制台）连续开发；
   - 每个模块必须附带完整的自动化测试套件（Unit/Integration Test），且退出码严格受控。
2. **凭据安全（P0 级红线）**：
   - 严禁在代码、日志、测试用例或 Git 中硬编码任何 API Key 或模型凭据；
   - 统一由本地 `.env` 运行时注入，日志全量脱敏（敏感 Token 遮蔽为 `sk-***`）。
3. **对外操作物理隔离（P0 级红线）**：
   - Claude CLI 仅作为“纯决策大脑”，严禁赋予自由 Shell 写操作权限；
   - 所有浏览器写操作（打招呼、发消息、发简历）必须经过 `ActionGuard` 守卫，并支持在控制台一键切换“全自动 / 严格人工审批”模式；
   - 严格遵循四态防重状态机：`PREPARED` -> `ATTEMPTED` -> `UNKNOWN` -> `外部页面核查`，未核实前绝不盲发。
4. **数据库与并发规范**：
   - 使用 Node.js 原生 `DatabaseSync`，强制开启 `WAL` 模式、外键约束与 `busy_timeout = 5000`；
   - 真实落盘持久化（禁止默认使用 `:memory:`），必须具备进程 Crash 后的检查点恢复能力。

---

## 2. 工程目录结构规划

```
findhope/
├── docs/                     # 历史探索、可行性验收与正式技术规范
│   ├── archive/              # 历史探索报告与旧版任务书归档
│   ├── feasibility_v1.1/     # 87项集中可行性验收完整成果包
│   └── specs/                # GPT 审阅定稿的官方实施规范
├── src/
│   ├── config/               # 环境变量、求职者画像与硬性规则配置
│   ├── db/                   # SQLite 架构迁移、DAO 与事务管理
│   │   ├── migrations/       # SQL DDL 迁移脚本
│   │   └── schema.sql        # 5大核心实体表结构
│   ├── core/                 # 核心控制与调度中枢
│   │   ├── scheduler.js      # 单 Actor 任务调度器、租约锁、HR消息插队
│   │   ├── action_guard.js   # 外部写操作四态状态机与防重核验
│   │   └── claude_runner.js  # Claude CLI 进程池、Envelope 组装与 JSON Schema 校验
│   ├── ego/                  # Ego 浏览器适配器
│   │   ├── bridge.js         # 与 ego-browser nodejs 子进程的 IPC 桥接器
│   │   ├── search_scraper.js # 岗位列表懒加载滚动扫描与 ID 去重
│   │   ├── detail_scraper.js # 明文 JD、薪资与 HR 活跃标签提取
│   │   └── chat_sync.js      # 聊天窗口增量同步、工具 unable 感知与消息锚点
│   └── web/                  # 本地可视化控制台
│       ├── server.js         # 轻量级本地 HTTP API 服务（无额外重型框架）
│       └── public/           # 单页面控制台 UI（HTML5 + Tailwind/Vanilla CSS）
├── tests/                    # 单元与集成测试套件
│   ├── test_db_crash.js      # 进程 kill 重启现场恢复单测
│   ├── test_claude_cli.js    # CLI 结构化返回与异常熔断单测
│   └── test_ego_bridge.js    # Ego 进程桥接与 TaskSpace 认领单测
├── .env.example              # 环境变量配置模板
├── CLAUDE.md                 # 供 Claude Code CLI 启动时自动读取的专属系统指令
├── GEMINI.md                 # 本开发指南
└── package.json              # 项目描述与启动命令
```

---

## 3. 五大核心实体与状态机契约

- **Posting**（职位）：`platform_job_id` 唯一索引，记录职位名称、公司、搜索来源、抓取时间戳。
- **PostingSnapshot**（JD 快照）：记录明文薪资、分段职责原文、HR 活跃标签原文（不武断将“2月内活跃”当超时）。
- **Assessment**（智能评估）：绑定 `posting_id` + `jd_version` + `config_version`，输出 `MATCH` / `REJECT` / `REVIEW` 及结构化理由。
- **Opportunity**（求职机会）：候选人与 HR 的长期关系，状态：`CONTACT_PENDING` -> `CONTACTED` -> `CONVERSING` -> `INTERVIEW_PENDING` -> `INTERVIEW_CONFIRMED` / `HUMAN_HANDOFF` / `DORMANT`。
- **Conversation & Message**（会话与消息）：会话绑定工具独立状态（`send_resume`, `exchange_wechat`, `exchange_phone`），消息通过复合指纹去重。
- **ActionAttempt**（执行意图）：`PREPARED` -> `ATTEMPTED` -> `VERIFIED_SUCCESS` / `VERIFIED_FAILURE` / `UNKNOWN`。
