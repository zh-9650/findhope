import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT_DIR = path.resolve(__dirname, '../../');

// 简单轻量加载 .env，不依赖 dotenv 库
export function loadEnv(envPath = path.join(ROOT_DIR, '.env')) {
  if (fs.existsSync(envPath)) {
    const content = fs.readFileSync(envPath, 'utf8');
    for (const line of content.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const eqIdx = trimmed.indexOf('=');
      if (eqIdx > 0) {
        const key = trimmed.slice(0, eqIdx).trim();
        const val = trimmed.slice(eqIdx + 1).trim();
        if (!process.env[key]) {
          process.env[key] = val;
        }
      }
    }
  }
}

loadEnv();

export function maskToken(token) {
  if (!token) return '';
  if (token.length <= 8) return '***';
  return `${token.slice(0, 3)}***${token.slice(-4)}`;
}

/**
 * 动态更新并持久化环境变量到 .env 文件
 */
export function updateEnvFile(updates = {}) {
  const envPath = path.join(ROOT_DIR, '.env');
  if (!fs.existsSync(envPath)) return;
  let content = fs.readFileSync(envPath, 'utf8');
  for (const [key, val] of Object.entries(updates)) {
    const regex = new RegExp(`^${key}=.*$`, 'm');
    if (regex.test(content)) {
      content = content.replace(regex, `${key}=${val}`);
    } else {
      content += `\n${key}=${val}`;
    }
    process.env[key] = String(val);
  }
  fs.writeFileSync(envPath, content, 'utf8');
}

export const config = {
  rootDir: ROOT_DIR,
  port: parseInt(process.env.PORT || '3456', 10),
  host: process.env.HOST || '127.0.0.1',
  dbPath: path.resolve(ROOT_DIR, process.env.DATABASE_PATH || './data/agent.db'),
  anthropicBaseUrl: process.env.ANTHROPIC_BASE_URL || 'http://192.168.31.86:30247',
  anthropicAuthToken: process.env.ANTHROPIC_AUTH_TOKEN || '',
  anthropicModel: process.env.ANTHROPIC_DEFAULT_SONNET_MODEL || 'cangjie-code[1M]',
  claudeCliPath: process.env.CLAUDE_CLI_PATH || 'C:\\Users\\17381\\.local\\bin\\claude.exe',
  executionMode: process.env.EXECUTION_MODE || 'DRAFT_ONLY', // DRAFT_ONLY | REAL_SEND_WITH_GUARD
  autoInterviewConfirm: process.env.AUTO_INTERVIEW_CONFIRM === 'true',

  // 默认求职画像与硬性规则（由控制台可动态修改并升级版本）
  candidateProfile: {
    name: "张洪",
    education: "全日制专升本",
    targetRole: "测试工程师 / 测试开发",
    targetCities: ["成都"],
    cityCodeMap: { "成都": "101270100" },
    searchKeywords: ["测试工程师", "自动化测试", "AI测试"],
    yearsOfExperience: 2,
    currentStatus: "在职-考虑机会", // 在职-考虑机会 | 在职-月内到岗 | 离职-随时到岗
    availableTime: "1周左右（可快速交接）",
    currentSalary: "4.5K",
    salaryExpectationMin: 8, // 最低8K
    salaryExpectationMax: 12, // 期望8-12K
    reasonForLeaving: "当前薪资待遇较低（4.5K）且晋升调薪空间受限，希望寻求具备合理回报体系（8K+）与更大技术成长空间的测试团队",
    interviewPreference: "线上或线下面试均可",
    wechatStrategy: "EXCHANGE_THEN_HANDOFF", // 点击交换微信后，立即交由人工亲自接管
    followupEnabled: true, // 是否启用“已读未回/送达”定时扫描二次评估与追发
    followupIntervalMinutes: 60, // 定时扫描与追发间隔（默认 60 分钟 = 1 小时）
    maxFollowupCount: 3, // 连续扫描命中多少次仍未回则放弃并标记“无结果”（默认 3 次）
    followupMinScore: 80, // 二次严选评估最低分数线（重业务契合、不卡年限，默认 80 分）
    blacklistKeywords: ["外包", "派遣", "驻场", "客服", "销售"],
    preferredSkills: [
      "自动化测试", "Python", "Playwright", "Selenium", "Pytest",
      "接口测试", "Postman", "Requests", "JMeter",
      "性能测试", "并发压测", "性能瓶颈分析",
      "Linux", "Shell脚本", "MySQL", "SQL复杂查询与调优",
      "微服务", "Docker", "容器化", "Jenkins", "CI/CD持续集成",
      "AI测试", "Agent智能体评测", "RAG检索增强验证"
    ],
    resumeSummary: "张洪，全日制专升本，2年测试工程师经验。具备全面的测试能力：精通自动化测试（Python/Playwright/Pytest）、接口测试与性能测试（JMeter/压测调优）；熟悉Linux常用命令与Shell脚本、MySQL数据库增删改查与调优；熟悉Docker容器化部署与微服务架构测试；深入参与过企业级AI智能体（Agent）与RAG应用的落地测试与评测体系构建。"
  }
};
