import { spawn } from 'node:child_process';
import { config, maskToken } from '../config/index.js';

export class ClaudeRunner {
  constructor(options = {}) {
    this.cliPath = options.cliPath || config.claudeCliPath;
    this.customBaseUrl = options.baseUrl || null;
    this.customAuthToken = options.authToken || null;
    this.customModel = options.model || null;
    this.timeoutMs = options.timeoutMs || 180000; // 默认 3 分钟 (180s)，保障深度推理与大上下文稳定完成
  }

  /**
   * 获取当前生效的模型名称（支持动态热更新）
   */
  getActiveModel() {
    const rawModel = this.customModel || config.anthropicModel || 'cangjie-agent';
    return rawModel.replace(/\[1m\]/i, '');
  }

  /**
   * 获取当前生效的 Base URL
   */
  getActiveBaseUrl() {
    return this.customBaseUrl || config.anthropicBaseUrl || 'http://192.168.31.86:30247';
  }

  /**
   * 获取当前生效的 Auth Token / API Key
   */
  getActiveAuthToken() {
    return this.customAuthToken || config.anthropicAuthToken || '';
  }

  /**
   * 调用 Claude CLI 执行纯推理，返回严格的结构化 JSON 对象
   */
  async invokeReasoning(prompt, expectedDecisionType = "JOB_ASSESSMENT", customTimeoutMs = null) {
    const effectiveTimeout = customTimeoutMs || this.timeoutMs;
    const activeModel = this.getActiveModel();
    const activeBaseUrl = this.getActiveBaseUrl();
    const activeAuthToken = this.getActiveAuthToken();

    const systemInstruction = `你是一个结构化纯决策引擎。严格依据提供的数据进行客观分析，严禁编造事实。必须且只能输出一段严格合法的 JSON 对象，不要输出任何 markdown 格式化标记（如 \`\`\`json ），前言或结语。注意：JSON 字符串值内部如需引用文字，必须使用中文书名号或括号（如【...】或『...』），严禁在字符串值内部使用英文双引号！`;
    const fullPrompt = `${systemInstruction}\n\n${prompt}`;

    const env = {
      ...process.env,
      ANTHROPIC_BASE_URL: activeBaseUrl,
      ANTHROPIC_AUTH_TOKEN: activeAuthToken,
      ANTHROPIC_DEFAULT_SONNET_MODEL: activeModel
    };

    return new Promise((resolve, reject) => {
      let isDone = false;
      const child = spawn(this.cliPath, ['-p', fullPrompt, '--model', activeModel, '--tools', ''], {
        env,
        stdio: ['ignore', 'pipe', 'pipe']
      });

      let stdout = '';
      let stderr = '';

      const timer = setTimeout(() => {
        if (!isDone) {
          isDone = true;
          child.kill('SIGKILL');
          reject(new Error(`ClaudeRunner execution timed out after ${effectiveTimeout}ms`));
        }
      }, effectiveTimeout);

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
