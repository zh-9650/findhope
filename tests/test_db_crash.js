import { AgentDatabase } from '../src/db/database.js';
import { spawn } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const TEST_DB_PATH = path.join(__dirname, '../data/test_crash.db');

// 清理旧测试库
if (fs.existsSync(TEST_DB_PATH)) fs.unlinkSync(TEST_DB_PATH);
if (fs.existsSync(TEST_DB_PATH + '-wal')) fs.unlinkSync(TEST_DB_PATH + '-wal');
if (fs.existsSync(TEST_DB_PATH + '-shm')) fs.unlinkSync(TEST_DB_PATH + '-shm');

let failCount = 0;
function assert(desc, condition, detail = "") {
  if (condition) {
    console.log(`  [PASS] ${desc}`);
  } else {
    console.error(`  [FAIL] ${desc} - ${detail}`);
    failCount++;
  }
}

console.log("=================================================");
console.log("  TEST SUITE: I0/I1 数据层与崩溃恢复测试套件");
console.log("=================================================\n");

// --- 阶段 1: 基础 CRUD 与幂等性测试 ---
console.log("[1] 测试基础实体持久化与指纹幂等性...");
const db = new AgentDatabase(TEST_DB_PATH);

// 职位去重
const p1 = db.recordPosting({ posting_id: "JOB_REAL_001", job_title: "AI测试工程师", company_name: "美云智数", detail_url: "/job/001" });
const p2 = db.recordPosting({ posting_id: "JOB_REAL_001", job_title: "AI测试工程师", company_name: "美云智数", detail_url: "/job/001" });
assert("相同 posting_id 首次写入成功 (isNew=true)", p1.isNew === true);
assert("相同 posting_id 二次写入被去重并累加发现数 (isNew=false)", p2.isNew === false);

// JD 快照落库
const snapId = db.recordSnapshot({
  posting_id: "JOB_REAL_001",
  jd_text: "负责企业级 AI 智能体与 RAG 系统自动化测试与质量保障体系建设",
  plain_salary: "8-9K",
  hr_active_tag: "刚刚活跃",
  is_active_within_3days: 1
});
assert("明文 JD 快照成功落库并返回快照 ID", snapId > 0);

// 会话与消息指纹去重
db.upsertConversation({
  conversation_id: "CONV_HR_001",
  posting_id: "JOB_REAL_001",
  hr_name: "李女士",
  company_name: "美云智数",
  send_resume_status: "AVAILABLE"
});

const m1 = db.recordMessage({
  conversation_id: "CONV_HR_001",
  sender_type: "HR",
  sender_name: "李女士",
  content: "您好，方便发一份您的详细简历吗？",
  message_type: "TEXT"
});
const m2 = db.recordMessage({
  conversation_id: "CONV_HR_001",
  sender_type: "HR",
  sender_name: "李女士",
  content: "您好，方便发一份您的详细简历吗？", // 相同内容指纹
  message_type: "TEXT"
});
assert("首次消息成功插入", m1.inserted === true);
assert("相同会话内相同指纹消息被安全忽略，不产生重复气泡", m2.inserted === false);

// --- 阶段 2: 单 Actor 租约锁与僵尸锁 TTL 超时自动回收 ---
console.log("\n[2] 测试单 Actor 租约互斥锁与僵尸锁回收...");
const lease1 = db.acquireLease("EGO_BROWSER", "WORKER_A", 500); // 500ms 快速超时
const lease2 = db.acquireLease("EGO_BROWSER", "WORKER_B", 500);
assert("WORKER_A 成功获取浏览器租约锁", lease1.acquired === true);
assert("WORKER_B 并发申请同一锁被拒绝", lease2.acquired === false);

console.log("  等待 600ms 让 WORKER_A 锁超时，测试僵尸锁回收...");
await new Promise(r => setTimeout(r, 600));

const lease3 = db.acquireLease("EGO_BROWSER", "WORKER_B", 2000);
assert("原持有人超时后，WORKER_B 成功自动接管僵尸锁", lease3.acquired === true);
db.releaseLease("EGO_BROWSER", "WORKER_B");

// --- 阶段 3: 真实子进程强杀 (Crash) 与现场恢复 ---
console.log("\n[3] 测试真实外部子进程 Crash (SIGKILL) 后的数据恢复与 UNKNOWN 检测...");
db.close(); // 先关闭主连接，让子进程写入

// 编写临时 worker 子进程脚本
const workerScriptPath = path.join(__dirname, 'worker_crash_helper.mjs');
fs.writeFileSync(workerScriptPath, `
  import { AgentDatabase } from '../src/db/database.js';
  const db = new AgentDatabase('${TEST_DB_PATH.replace(/\\/g, '/')}');

  // 记录准备发消息的动作
  db.prepareAction({
    action_id: 'ACT_CRASH_TEST',
    conversation_id: 'CONV_HR_001',
    action_kind: 'REPLY_TEXT',
    payload: '好的，马上发送',
    requires_approval: false
  });

  // 标记进入 ATTEMPTED
  db.markActionAttempted('ACT_CRASH_TEST');

  // 模拟发送到一半异常发生，标记为 UNKNOWN
  db.markActionUnknown('ACT_CRASH_TEST', 'PROCESS_INTERRUPTED_BY_CRASH');

  // 保存检查点
  db.enqueueTask({
    task_id: 'TASK_SEARCH_LONG_RUN',
    task_type: 'SEARCH',
    priority: 10,
    checkpoint_data: { lastScannedPage: 3, lastJobId: 'JOB_PAGE3_09' }
  });
  db.saveTaskCheckpoint('TASK_SEARCH_LONG_RUN', 'YIELDED', { lastScannedPage: 3, lastJobId: 'JOB_PAGE3_09' });

  // 保持运行，等待被强杀
  process.stdout.write("READY_FOR_KILL\\n");
  setInterval(() => {}, 1000);
`);

const child = spawn(process.execPath, [workerScriptPath], { stdio: ['ignore', 'pipe', 'inherit'] });

await new Promise((resolve) => {
  child.stdout.on('data', (d) => {
    if (d.toString().includes("READY_FOR_KILL")) {
      console.log("  子进程已就绪并完成写盘，执行硬杀 (kill -9)...");
      child.kill('SIGKILL');
      resolve();
    }
  });
});

// 清理临时脚本
if (fs.existsSync(workerScriptPath)) fs.unlinkSync(workerScriptPath);

// 主进程重新启动数据库并复查现场
console.log("  主服务重新加载 SQLite 数据库...");
const recoveredDb = new AgentDatabase(TEST_DB_PATH);

const unknownList = recoveredDb.getUnknownActions();
assert("重启后准确识别到崩溃遗留的 UNKNOWN 外部动作", unknownList.length === 1 && unknownList[0].action_id === 'ACT_CRASH_TEST');

const nextTask = recoveredDb.getNextTask();
assert("重启后优先定位到 YIELDED 的搜岗检查点任务", nextTask && nextTask.task_id === 'TASK_SEARCH_LONG_RUN');
const chkData = JSON.parse(nextTask.checkpoint_data);
assert("检查点游标数据完整无损 (lastScannedPage=3)", chkData.lastScannedPage === 3 && chkData.lastJobId === 'JOB_PAGE3_09');

// 模拟回查核实动作
recoveredDb.verifyActionSuccess('ACT_CRASH_TEST', 'RECHECKED_VIA_BROWSER_PAGE');
assert("外部回查核实后 UNKNOWN 清零，绝无盲目重发", recoveredDb.getUnknownActions().length === 0);

// 多维指标聚合计算
const metrics = recoveredDb.getDashboardMetrics();
assert("多维全链路统计聚合计算准确", metrics.search.totalDiscovered === 1 && metrics.governance.unknownActions === 0);

recoveredDb.close();

console.log("\n=================================================");
if (failCount === 0) {
  console.log("  🎉 批次 1 (I0/I1) 全部测试 PASS！退出码 0");
  console.log("=================================================\n");
  process.exit(0);
} else {
  console.error(`  ❌ 测试未完全通过，共有 ${failCount} 个失败项！退出码 1`);
  console.log("=================================================\n");
  process.exit(1);
}
