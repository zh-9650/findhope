import { AgentDatabase } from '../src/db/database.js';
import { createWebServer } from '../src/web/server.js';
import { TaskScheduler } from '../src/core/scheduler.js';
import path from 'node:path';
import fs from 'node:fs';
import http from 'node:http';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const TEST_DB = path.join(__dirname, '../data/test_full.db');

if (fs.existsSync(TEST_DB)) fs.unlinkSync(TEST_DB);

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
console.log("  TEST SUITE: I5 任务调度与 Web 控制台集成测试");
console.log("=================================================\n");

const db = new AgentDatabase(TEST_DB);
const scheduler = new TaskScheduler(db, null, null, null, null, null);
const server = createWebServer(db, scheduler);

const TEST_PORT = 3899;
await new Promise(r => server.listen(TEST_PORT, '127.0.0.1', r));
console.log(`  临时 Web 测试服务已监听端口 ${TEST_PORT}`);

function request(path, options = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request(`http://127.0.0.1:${TEST_PORT}${path}`, options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          resolve({ status: res.statusCode, data: JSON.parse(data) });
        } catch (e) {
          resolve({ status: res.statusCode, text: data });
        }
      });
    });
    if (options.body) req.write(JSON.stringify(options.body));
    req.end();
  });
}

// 准备测试数据
db.recordPosting({
  posting_id: "JOB_WEB_01",
  job_title: "全栈测试开发",
  company_name: "蚂蚁集团",
  detail_url: "/job/ant"
});
db.prepareAction({
  action_id: "ACT_WEB_APPROVAL_01",
  conversation_id: "CONV_ANT_01",
  action_kind: "CONFIRM_INTERVIEW",
  payload: "同意参加周三下午2点在线初试",
  requires_approval: true
});

console.log("[1] 测试 GET /api/status 接口多维指标聚合与调度器状态...");
const statusRes = await request('/api/status');
assert("状态接口返回 200", statusRes.status === 200);
assert("指标包含已扫描职位数与待审批数", statusRes.data.metrics.search.totalDiscovered === 1 && statusRes.data.metrics.governance.pendingApprovals === 1);

console.log("\n[2] 测试 POST /api/control/toggle 启停调度器...");
const toggleRes1 = await request('/api/control/toggle', { method: 'POST' });
assert("首次 toggle 成功启动调度器", toggleRes1.data.isRunning === true && toggleRes1.data.isPaused === false);
const toggleRes2 = await request('/api/control/toggle', { method: 'POST' });
assert("二次 toggle 成功暂停调度器", toggleRes2.data.isPaused === true);

console.log("\n[3] 测试 GET /api/approvals 与 POST /api/approvals/:id/approve 人工审批流...");
const appRes = await request('/api/approvals');
assert("待审批列表准确返回 1 条事项", appRes.data.approvals.length === 1 && appRes.data.approvals[0].action_id === "ACT_WEB_APPROVAL_01");

const approveActionRes = await request('/api/approvals/ACT_WEB_APPROVAL_01/approve', { method: 'POST' });
assert("审批接口执行成功", approveActionRes.data.success === true);

const appResAfter = await request('/api/approvals');
assert("用户批准后，待核准清单清空", appResAfter.data.approvals.length === 0);

console.log("\n[4] 测试 GET /api/postings 职位决策池接口...");
const postingsRes = await request('/api/postings');
assert("职位池接口正常返回已发现岗位", postingsRes.data.postings.length === 1 && postingsRes.data.postings[0].posting_id === "JOB_WEB_01");

// 关闭测试服务
server.close();
db.close();

console.log("\n=================================================");
if (failCount === 0) {
  console.log("  🎉 批次 5 (I5) 全部测试 PASS！退出码 0");
  console.log("=================================================\n");
  process.exit(0);
} else {
  console.error(`  ❌ 批次 5 测试未完全通过，共有 ${failCount} 个失败项！退出码 1`);
  console.log("=================================================\n");
  process.exit(1);
}
