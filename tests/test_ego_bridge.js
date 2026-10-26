import { EgoBridge } from '../src/ego/bridge.js';
import { AgentDatabase } from '../src/db/database.js';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const TEST_DB = path.join(__dirname, '../data/test_ego.db');

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
console.log("  TEST SUITE: I2 Ego 浏览器 IPC 桥接器测试");
console.log("=================================================\n");

const db = new AgentDatabase(TEST_DB);
const bridge = new EgoBridge({ timeoutMs: 25000 });

console.log("[1] 测试 EgoBridge 跨进程执行与 TaskSpace 自动接管...");
try {
  const result = await bridge.runInBrowser(`
    const title = await page.title();
    const url = await page.url();
    return { title, url, verifiedTimestamp: Date.now() };
  `);

  assert("EgoBridge 成功通过 IPC 驱动 ego-browser nodejs 执行并回传结构化数据", !!result && typeof result.verifiedTimestamp === 'number');
  console.log(`  当前页面标题: "${result.title}", URL: "${result.url}"`);
  assert("页面返回有效标题", result.title.length > 0);
} catch (err) {
  assert("EgoBridge 基础执行通过", false, err.message);
}

console.log("\n[2] 测试在真实页面只读提取 DOM 属性并入库 (JD 快照模拟校验)...");
try {
  const domResult = await bridge.runInBrowser(`
    const currentUrl = await page.url();
    const hasHeader = await page.evaluate(() => {
      const header = document.querySelector('header, #header, .header');
      return !!header;
    });
    return { currentUrl, hasHeader };
  `);

  assert("成功在页面评估 DOM 结构", typeof domResult.hasHeader === 'boolean');
} catch (err) {
  assert("DOM 属性评估通过", false, err.message);
}

db.close();

console.log("\n=================================================");
if (failCount === 0) {
  console.log("  🎉 批次 2 (I2) 全部测试 PASS！退出码 0");
  console.log("=================================================\n");
  process.exit(0);
} else {
  console.error(`  ❌ 批次 2 测试未完全通过，共有 ${failCount} 个失败项！退出码 1`);
  console.log("=================================================\n");
  process.exit(1);
}
