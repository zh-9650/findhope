import { ClaudeRunner } from '../src/core/claude_runner.js';
import { JobMatcher } from '../src/core/matcher.js';
import { AgentDatabase } from '../src/db/database.js';
import { config } from '../src/config/index.js';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const TEST_DB = path.join(__dirname, '../data/test_claude.db');

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
console.log("  TEST SUITE: I3 Claude 智能匹配与决策引擎测试");
console.log("=================================================\n");

const db = new AgentDatabase(TEST_DB);
const runner = new ClaudeRunner();
const matcher = new JobMatcher(runner, db);

// 准备测试岗位 A (外包，命中硬规则)
db.recordPosting({
  posting_id: "JOB_OUTSOURCE",
  job_title: "银行测试工程师(驻场外包)",
  company_name: "某软件外包公司",
  detail_url: "/job/outsource"
});
db.recordSnapshot({
  posting_id: "JOB_OUTSOURCE",
  jd_text: "要求派驻银行现场进行日常功能点点点测试，需接受高强度加班。",
  plain_salary: "6-8K",
  hr_active_tag: "刚刚活跃",
  is_active_within_3days: 1
});

// 准备测试岗位 B (契合岗位，走 Claude 语义评估)
db.recordPosting({
  posting_id: "JOB_AI_TEST",
  job_title: "AI测试工程师",
  company_name: "美云智数",
  detail_url: "/job/ai_test"
});
db.recordSnapshot({
  posting_id: "JOB_AI_TEST",
  jd_text: "岗位职责：1. 负责大模型评测与 Agent/RAG 自动化评测流水线搭建；2. 熟练掌握 Python 和自动化框架；3. 2年以上测试开发或AI测试经验者优先。",
  plain_salary: "8-9K",
  hr_active_tag: "刚刚活跃",
  is_active_within_3days: 1
});

console.log("[1] 测试 Level 1 本地硬规则秒级拦截 (排除外包)...");
const postA = db.getPostingWithLatestSnapshot("JOB_OUTSOURCE");
const resA = await matcher.evaluatePosting(postA, config.candidateProfile, 1);
assert("硬规则成功识别并拦截外包岗位 (REJECT)", resA.decision === 'REJECT' && resA.filter_stage === 'HARD_RULE');

console.log("\n[2] 测试 Level 2 真实调用 Claude CLI + 仓颉模型进行语义深度精筛...");
const postB = db.getPostingWithLatestSnapshot("JOB_AI_TEST");
try {
  const resB = await matcher.evaluatePosting(postB, config.candidateProfile, 1);
  console.log("  Claude 决策输出:", JSON.stringify(resB, null, 2));
  assert("Claude 语义评估成功返回 MATCH / REVIEW 决策", ['MATCH', 'REVIEW'].includes(resB.decision));
  assert("匹配打分正常落入区间 (score > 0)", resB.match_score > 0);

  // 检查是否自动生成 Opportunity
  const opp = db.db.prepare(`SELECT * FROM opportunities WHERE posting_id = 'JOB_AI_TEST'`).get();
  assert("MATCH 岗位已自动生成 CONTACT_PENDING 求职机会", !!opp && opp.stage === 'CONTACT_PENDING');
} catch (err) {
  assert("Claude CLI 语义评估执行通过", false, err.message);
}

db.close();

console.log("\n=================================================");
if (failCount === 0) {
  console.log("  🎉 批次 3 (I3) 全部测试 PASS！退出码 0");
  console.log("=================================================\n");
  process.exit(0);
} else {
  console.error(`  ❌ 批次 3 测试未完全通过，共有 ${failCount} 个失败项！退出码 1`);
  console.log("=================================================\n");
  process.exit(1);
}
