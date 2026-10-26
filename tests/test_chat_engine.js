import { ClaudeRunner } from '../src/core/claude_runner.js';
import { ActionGuard } from '../src/core/action_guard.js';
import { ChatEngine } from '../src/core/chat_engine.js';
import { AgentDatabase } from '../src/db/database.js';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const TEST_DB = path.join(__dirname, '../data/test_chat.db');

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
console.log("  TEST SUITE: I4 聊天决策与回复草稿引擎测试");
console.log("=================================================\n");

const db = new AgentDatabase(TEST_DB);
const runner = new ClaudeRunner();
const guard = new ActionGuard(db, null);
const engine = new ChatEngine(runner, guard, db);

// 准备测试会话与消息
db.recordPosting({
  posting_id: "JOB_CHAT_01",
  job_title: "中级测试开发工程师",
  company_name: "字节跳动",
  detail_url: "/job/bytedance"
});

db.upsertConversation({
  conversation_id: "CONV_BYTEDANCE_HR",
  posting_id: "JOB_CHAT_01",
  hr_name: "王主管",
  company_name: "字节跳动",
  send_resume_status: "AVAILABLE",
  memory_ledger: {
    commitments: {
      "到岗时间": "已离职随时到岗"
    }
  }
});

// 模拟 HR 发来复合提问
db.recordMessage({
  conversation_id: "CONV_BYTEDANCE_HR",
  sender_type: "CANDIDATE",
  content: "您好，我对该岗位很感兴趣，有2年自动化和AI测试经验。"
});
db.recordMessage({
  conversation_id: "CONV_BYTEDANCE_HR",
  sender_type: "HR",
  sender_name: "王主管",
  content: "你好，目前是在职还是离职状态？最快什么时候能来面试？另外麻烦发一份详细PDF简历看下。"
});

console.log("[1] 测试 ActionGuard 门禁拦截机制 (默认 DRAFT_ONLY 安全草稿模式)...");
const intent = guard.registerIntent({
  conversation_id: "CONV_BYTEDANCE_HR",
  action_kind: "SEND_RESUME",
  payload: "申请发送附件简历"
});
assert("默认安全模式下动作被正确拦截为待审批 (requiresApproval=true)", intent.requiresApproval === true);
assert("动作状态初始化为 PREPARED", intent.status === 'PREPARED');

console.log("\n[2] 测试 ChatEngine 真实多轮上下文提取与 Claude 回复起草...");
try {
  const result = await engine.processIncomingMessages("CONV_BYTEDANCE_HR");
  console.log("  Claude 决策输出:", JSON.stringify(result.decision, null, 2));

  assert("成功解析 HR 意图", !!result.decision.hr_intent);
  assert("起草了得体的回复草稿文本", typeof result.decision.draft_reply === 'string' && result.decision.draft_reply.length > 5);
  assert("动作意图成功注册至 ActionGuard", !!result.actionIntent && result.actionIntent.requiresApproval === true);

  // 验证记忆账本更新
  const updatedConv = db.db.prepare(`SELECT memory_ledger FROM conversations WHERE conversation_id = 'CONV_BYTEDANCE_HR'`).get();
  const parsedLedger = JSON.parse(updatedConv.memory_ledger);
  assert("结构化承诺记忆账本已成功持久化并回写 SQLite", !!parsedLedger.commitments);
} catch (err) {
  assert("ChatEngine 处理多轮消息通过", false, err.message);
}

db.close();

console.log("\n=================================================");
if (failCount === 0) {
  console.log("  🎉 批次 4 (I4) 全部测试 PASS！退出码 0");
  console.log("=================================================\n");
  process.exit(0);
} else {
  console.error(`  ❌ 批次 4 测试未完全通过，共有 ${failCount} 个失败项！退出码 1`);
  console.log("=================================================\n");
  process.exit(1);
}
