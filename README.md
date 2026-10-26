# findhope

本地运行的 BOSS 直聘求职助手，使用 Node.js、SQLite、Claude CLI 和 Ego 浏览器。

## 实现方式

- Node.js 调度搜索、岗位详情采集、评估、建联与聊天巡检。
- Ego 执行预先编写的浏览器采集和交互脚本。
- Claude CLI 负责岗位匹配、聊天决策及拒绝原因复盘。
- SQLite 保存岗位、会话、消息、任务、动作账本和日志。
- 本地 Web 控制台提供状态查看、配置、启停及动作审批。

## 本地运行

需要支持 `node:sqlite` 的 Node.js（建议 Node.js 24）、已安装的 Claude CLI，以及已配置并登录的 Ego 浏览器。当前 package.json 未声明第三方 npm 依赖。

PowerShell：

```powershell
Copy-Item .env.example .env
# 编辑 .env，配置模型网关、凭据和 Claude CLI 路径
npm start
```

默认控制台地址：http://127.0.0.1:3456/ 。服务启动后通过控制台启动调度。

首次使用前检查 `src/config/index.js` 中的求职画像及规则；源码保留当前个人使用配置。

## 目录

```text
src/config/       环境与求职配置
src/db/           SQLite 表结构与数据访问
src/core/         调度、模型调用、匹配、聊天及动作执行
src/ego/          浏览器桥接与页面采集、交互
src/web/          本地 HTTP API 与网页控制台
tests/            现有测试脚本
docs/specs/       正式方案文档
```

## 验证与当前限制

`npm test` 执行现有测试套件，其中包含真实 Claude CLI 和 Ego 环境调用，运行前应阅读对应脚本。上传仓库不代表这些测试已经在本次执行。

当前版本仍在完善：动作完成核验、统一审批路径、最新聊天上下文、记忆更新时机和配置版本管理需要进一步核对。`DRAFT_ONLY` 尚不能保证覆盖所有首次建联路径，实际运行前请审查相关实现。

仓库不包含 `.env`、本地数据库、聊天截图、临时操作脚本，以及含凭据的历史验证材料。
