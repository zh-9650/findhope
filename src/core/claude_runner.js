import { spawn } from 'node:child_process';
import { config, maskToken } from '../config/index.js';

export class ClaudeRunner {
  constructor(options = {}) {
    this.cliPath = options.cliPath || config.claudeCliPath;
    this.baseUrl = options.baseUrl || config.anthropicBaseUrl;
    this.authToken = options.authToken || config.anthropicAuthToken;
    this.model = options.model || config.anthropicModel;
    this.timeoutMs = options.timeoutMs || 180000; // 默认 3 分钟 (180s)，保障深度推理与大上下文稳定完成
  }

  /**
   * 调用 Claude CLI 执行纯推理，返回严格的结构化 JSON 对象
   */
  async invokeReasoning(prompt, expectedDecisionType = "JOB_ASSESSMENT") {
    const systemInstruction = `你是一个结构化纯决策引擎。严格依据提供的数据进行客观分析，严禁编造事实。必须且只能输出一段严格合法的 JSON 对象，不要输出任何 markdown 格式化标记（如 \`\`\`json ）、前言或结语。注意：JSON 字符串值内部如需引用文字，必须使用中文书名号或括号（如【...】或『...』），严禁在字符串值内部直接使用未转义的英文双引号 "！`;
    const fullPrompt = `${systemInstruction}\n\n${prompt}`;

    const env = {
      ...process.env,
      ANTHROPIC_BASE_URL: this.baseUrl,
      ANTHROPIC_AUTH_TOKEN: this.authToken,
      ANTHROPIC_DEFAULT_SONNET_MODEL: this.model
    };

    return new Promise((resolve, reject) => {
      let isDone = false;
      const child = spawn(this.cliPath, ['-p', fullPrompt, '--model', this.model], {
        env,
        stdio: ['ignore', 'pipe', 'pipe']
      });

      let stdout = '';
      let stderr = '';

      const timer = setTimeout(() => {
        if (!isDone) {
          isDone = true;
          child.kill('SIGKILL');
          reject(new Error(`ClaudeRunner execution timed out after ${this.timeoutMs}ms`));
        }
      }, this.timeoutMs);

      child.stdout.on('data', (d) => stdout += d.toString());
      child.stderr.on('data', (d) => stderr += d.toString());

      child.on('close', (code) => {
        clearTimeout(timer);
        if (isDone) return;
        isDone = true;

        if (code !== 0 && !stdout) {
          return reject(new Error(`Claude CLI exited with code ${code}. Stderr: ${stderr}`));
        }

        // 尝试从 stdout 中提取 JSON
        try {
          const jsonMatch = stdout.match(/\{[\s\S]*\}/);
          if (!jsonMatch) {
            throw new Error(`No JSON block found in CLI output: ${stdout}`);
          }
          const parsed = JSON.parse(jsonMatch[0]);
          resolve(parsed);
        } catch (err) {
          reject(new Error(`Failed to parse Claude CLI JSON: ${err.message}\nRaw output: ${stdout}`));
        }
      });
    });
  }
}
