import { config, maskToken } from './config/index.js';
import { AgentDatabase } from './db/database.js';
import { EgoBridge } from './ego/bridge.js';
import { SearchScraper } from './ego/search_scraper.js';
import { DetailScraper } from './ego/detail_scraper.js';
import { ChatSync } from './ego/chat_sync.js';
import { ContactExecutor } from './ego/contact_executor.js';
import { ClaudeRunner } from './core/claude_runner.js';
import { JobMatcher } from './core/matcher.js';
import { ActionGuard } from './core/action_guard.js';
import { ChatEngine } from './core/chat_engine.js';
import { FollowupEngine } from './core/followup_engine.js';
import { RejectionAnalyzer } from './core/rejection_analyzer.js';
import { TaskScheduler } from './core/scheduler.js';
import { createWebServer } from './web/server.js';

console.log("==========================================================");
console.log("   BOSS 自主求职 Agent 系统初始化启动中...");
console.log("==========================================================");
console.log(`[配置信息] 模型网关: ${config.anthropicBaseUrl}`);
console.log(`[配置信息] 模型名称: ${config.anthropicModel}`);
console.log(`[配置信息] 凭据状态: ${config.anthropicAuthToken ? maskToken(config.anthropicAuthToken) : '未配置'}`);
console.log(`[配置信息] 运行模式: ${config.executionMode}`);
console.log(`[配置信息] 本地数据库: ${config.dbPath}`);

// 1. 初始化 SQLite
const db = new AgentDatabase(config.dbPath);

// 2. 初始化核心适配器与引擎
const bridge = new EgoBridge();
const searchScraper = new SearchScraper(bridge, db);
const detailScraper = new DetailScraper(bridge, db);
const chatSync = new ChatSync(bridge, db);
const contactExecutor = new ContactExecutor(bridge, db);

const runner = new ClaudeRunner();
const matcher = new JobMatcher(runner, db);
const guard = new ActionGuard(db, bridge);
const chatEngine = new ChatEngine(runner, guard, db);
const followupEngine = new FollowupEngine(runner, guard, chatSync, db);
const rejectionAnalyzer = new RejectionAnalyzer(runner, db);

// 启动时自动回填历史被拒记录并初始化首份复盘报告
rejectionAnalyzer.syncHistoricalRejections();
if (!db.getLatestRejectionReport()) {
  rejectionAnalyzer.analyzeAll(false).catch(() => {});
}

// 3. 初始化调度中枢 (注入 contactExecutor 与 followupEngine)
const scheduler = new TaskScheduler(db, bridge, searchScraper, detailScraper, chatSync, chatEngine, matcher, contactExecutor, followupEngine);

// 4. 挂载本地 Web 控制台
const server = createWebServer(db, scheduler, rejectionAnalyzer);

server.listen(config.port, config.host, () => {
  console.log(`\n🚀 [控制台服务] Web 控制台已成功启动并在本地监听:`);
  console.log(`👉 http://${config.host}:${config.port}/\n`);
  console.log("💡 调度器准备就绪，支持全链路端到端自动化求职。");
});

// 优雅退出处理
process.on('SIGINT', () => {
  console.log("\n正在安全关闭服务并释放浏览器资源锁...");
  scheduler.stop();
  db.close();
  server.close(() => {
    console.log("服务已平稳退出。");
    process.exit(0);
  });
});
