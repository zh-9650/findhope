import { spawn } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';

const TASK_SPACE_NAME = "BOSS自主求职Agent_主工作台";
const RESULT_DELIMITER_START = "===JSON_RESULT_START===";
const RESULT_DELIMITER_END = "===JSON_RESULT_END===";

export class EgoBridge {
  constructor(options = {}) {
    this.timeoutMs = options.timeoutMs || 35000;
  }

  /**
   * 在 ego-browser nodejs 环境中执行指定的 async pageAction 代码块
   * @param {string} actionFnBody 形如: "const title = await page.title(); return { title };"
   * @param {object} contextData 注入给脚本的序列化参数
   */
  async runInBrowser(actionFnBody, contextData = {}) {
    const serializedContext = JSON.stringify(contextData);

    const fullScript = `
      const context = ${serializedContext};
      
      // 1. 定位或接管专属 TaskSpace
      const spaces = await listTaskSpaces();
      let targetSpace = spaces.find(s => s.name === "${TASK_SPACE_NAME}");
      let spaceId = null;

      if (targetSpace) {
        spaceId = targetSpace.id;
        if (targetSpace.ownership === 'user') {
          // 用户已授权，自动接管已存在的任务空间
          await claimTaskSpace(spaceId);
        }
      } else {
        const created = await taskSpace("${TASK_SPACE_NAME}");
        const updated = await listTaskSpaces();
        const found = updated.find(s => s.name === "${TASK_SPACE_NAME}");
        spaceId = found ? found.id : null;
      }

      const task = await taskSpace(spaceId);
      const page = task.page("p1");

      try {
        const executeAction = async (page, context) => {
          ${actionFnBody}
        };

        const result = await executeAction(page, context);
        console.log("${RESULT_DELIMITER_START}" + JSON.stringify({ success: true, data: result }) + "${RESULT_DELIMITER_END}");
      } catch (err) {
        console.log("${RESULT_DELIMITER_START}" + JSON.stringify({ success: false, error: err.message, stack: err.stack }) + "${RESULT_DELIMITER_END}");
      }
    `;

    return new Promise((resolve, reject) => {
      // 通过 cmd /c ego-browser nodejs 执行
      const child = spawn('cmd.exe', ['/c', 'ego-browser', 'nodejs'], {
        stdio: ['pipe', 'pipe', 'pipe']
      });

      let stdout = '';
      let stderr = '';
      let isDone = false;

      const timer = setTimeout(() => {
        if (!isDone) {
          isDone = true;
          child.kill('SIGKILL');
          reject(new Error(`EgoBridge execution timed out after ${this.timeoutMs}ms`));
        }
      }, this.timeoutMs);

      child.stdout.on('data', (d) => stdout += d.toString());
      child.stderr.on('data', (d) => stderr += d.toString());

      child.on('close', (code) => {
        clearTimeout(timer);
        if (isDone) return;
        isDone = true;

        const combined = stdout + "\n" + stderr;
        const startIdx = combined.indexOf(RESULT_DELIMITER_START);
        const endIdx = combined.indexOf(RESULT_DELIMITER_END);

        if (startIdx !== -1 && endIdx !== -1) {
          const jsonStr = combined.slice(startIdx + RESULT_DELIMITER_START.length, endIdx).trim();
          try {
            const parsed = JSON.parse(jsonStr);
            if (parsed.success) {
              resolve(parsed.data);
            } else {
              reject(new Error(parsed.error || 'EgoBridge internal error'));
            }
          } catch (e) {
            reject(new Error(`Failed to parse EgoBridge JSON result: ${e.message}\nRaw output: ${combined}`));
          }
        } else {
          reject(new Error(`Ego process exited with code ${code} without result delimiter.\nStdout: ${stdout}\nStderr: ${stderr}`));
        }
      });

      // 将脚本写入 stdin 并关闭输入流
      child.stdin.write(fullScript);
      child.stdin.end();
    });
  }
}
