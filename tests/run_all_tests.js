import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const suites = [
  { name: "I0/I1: 数据层与崩溃现场恢复", script: "test_db_crash.js" },
  { name: "I2: Ego 浏览器 IPC 桥接与 TaskSpace 认领", script: "test_ego_bridge.js" },
  { name: "I3: Claude CLI 仓颉模型智能匹配", script: "test_claude_cli.js" },
  { name: "I4: 聊天决策与记忆账本回写", script: "test_chat_engine.js" },
  { name: "I5: 任务调度与 Web 控制台 API 集成", script: "test_full_system.js" }
];

console.log("=================================================================");
console.log("    BOSS 自主求职 Agent · 全阶段全量自动化测试汇总运行");
console.log("=================================================================\n");

let allPassed = true;

for (const suite of suites) {
  console.log(`>>> 正在运行套件: ${suite.name} (${suite.script})...`);
  const scriptPath = path.join(__dirname, suite.script);
  const res = spawnSync(process.execPath, [scriptPath], { stdio: 'inherit' });

  if (res.status !== 0) {
    console.error(`\n❌ [FAILED] 套件 ${suite.name} 运行失败，退出码: ${res.status}\n`);
    allPassed = false;
    break;
  }
  console.log(`✔ [SUCCESS] 套件 ${suite.name} 通过！\n`);
}

if (allPassed) {
  console.log("=================================================================");
  console.log("    🎉 恭喜！5 大核心模块全套测试 100% PASS！系统已具备上线可用条件！");
  console.log("=================================================================\n");
  process.exit(0);
} else {
  process.exit(1);
}
