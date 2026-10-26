import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { config, updateEnvFile, maskToken } from '../config/index.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PUBLIC_DIR = path.join(__dirname, 'public');

export function createWebServer(db, scheduler, rejectionAnalyzer = null) {
  const server = http.createServer(async (req, res) => {
    const parsedUrl = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    const pathname = parsedUrl.pathname;
    const method = req.method;

    // 通用 JSON 响应
    const sendJson = (data, statusCode = 200) => {
      res.writeHead(statusCode, {
        'Content-Type': 'application/json; charset=utf-8',
        'Access-Control-Allow-Origin': '*'
      });
      res.end(JSON.stringify(data));
    };

    // 读取请求体
    const readBody = () => new Promise((resolve) => {
      let body = '';
      req.on('data', chunk => body += chunk);
      req.on('end', () => {
        try {
          resolve(body ? JSON.parse(body) : {});
        } catch (e) {
          resolve({});
        }
      });
    });

    // --- REST API 路由 ---
    if (pathname === '/api/status' && method === 'GET') {
      const metrics = db.getDashboardMetrics();
      return sendJson({
        scheduler: {
          isRunning: scheduler ? scheduler.isRunning : false,
          isPaused: scheduler ? scheduler.isPaused : true,
          executionMode: config.executionMode
        },
        metrics,
        serverTime: new Date().toISOString()
      });
    }

    if (pathname === '/api/logs' && method === 'GET') {
      const limit = parseInt(parsedUrl.searchParams.get('limit') || '30', 10);
      const logs = db.getRecentLogs(limit);
      return sendJson({ logs });
    }

    if (pathname === '/api/actions/trigger-search' && method === 'POST') {
      const kw = config.candidateProfile.searchKeywords[0] || '测试工程师';
      const task = {
        task_id: `MANUAL_SEARCH_${Date.now()}`,
        task_type: 'SEARCH',
        target_id: kw,
        priority: 99
      };
      db.enqueueTask(task);
      db.logEvent("SCHEDULER", `收到用户指令：立即触发 "${kw}" 搜岗任务`, "INFO");

      if (scheduler && (!scheduler.isRunning || scheduler.isPaused)) {
        scheduler.executeSingleTask(task).catch(err => {
          db.logEvent("SCHEDULER", `单轮搜岗执行失败: ${err.message}`, "ERROR");
        });
        return sendJson({ success: true, message: `已触发单轮搜岗 (单步执行，不会唤醒后台自动循环): ${kw}` });
      }

      return sendJson({ success: true, message: `已触发搜岗: ${kw}` });
    }

    if (pathname === '/api/actions/trigger-chat-sync' && method === 'POST') {
      const task = {
        task_id: `MANUAL_CHAT_${Date.now()}`,
        task_type: 'CHAT_SYNC',
        priority: 100
      };
      db.enqueueTask(task);
      db.logEvent("SCHEDULER", `收到用户指令：立即同步 BOSS 聊天会话与未读消息`, "INFO");

      if (scheduler && (!scheduler.isRunning || scheduler.isPaused)) {
        scheduler.executeSingleTask(task).catch(err => {
          db.logEvent("SCHEDULER", `单轮聊天巡检执行失败: ${err.message}`, "ERROR");
        });
        return sendJson({ success: true, message: `已触发单轮聊天同步 (单步执行，不会唤醒后台自动循环)` });
      }

      return sendJson({ success: true, message: `已触发聊天同步` });
    }

    if (pathname === '/api/actions/trigger-followup-scan' && method === 'POST') {
      const task = {
        task_id: `MANUAL_FOLLOWUP_${Date.now()}`,
        task_type: 'FOLLOWUP_SCAN',
        priority: 95
      };
      db.enqueueTask(task);
      db.logEvent("FOLLOWUP", `收到用户指令：立即扫描【已读未回/送达】会话并进行二次评估与追发`, "INFO");

      if (scheduler && (!scheduler.isRunning || scheduler.isPaused)) {
        scheduler.executeSingleTask(task).catch(err => {
          db.logEvent("FOLLOWUP", `单轮已读未回扫描执行失败: ${err.message}`, "ERROR");
        });
        return sendJson({ success: true, message: `已触发单轮【已读未回/送达】扫描重评与追发（单步独立执行）` });
      }

      return sendJson({ success: true, message: `已排入【已读未回/送达】扫描重评与追发队列` });
    }

    if (pathname === '/api/followups' && method === 'GET') {
      const lastScanTime = scheduler ? scheduler.lastFollowupScanTime : 0;
      const intervalMs = (Number(config.candidateProfile.followupIntervalMinutes) || 60) * 60 * 1000;
      const nextScanTime = lastScanTime > 0 ? (lastScanTime + intervalMs) : 0;
      return sendJson({
        conversations: db.getFollowupConversations(),
        lastScanTime,
        nextScanTime,
        config: {
          followupEnabled: config.candidateProfile.followupEnabled !== false,
          followupIntervalMinutes: config.candidateProfile.followupIntervalMinutes || 60,
          maxFollowupCount: config.candidateProfile.maxFollowupCount || 3,
          followupMinScore: config.candidateProfile.followupMinScore || 80
        }
      });
    }

    if (pathname === '/api/control/toggle' && method === 'POST') {
      if (!scheduler) return sendJson({ error: 'Scheduler not initialized' }, 500);
      if (scheduler.isRunning && !scheduler.isPaused) {
        scheduler.pause();
        if (rejectionAnalyzer) {
          db.logEvent("ANALYSIS", "检测到系统已暂停/停止，正在自动汇总本轮收集到的 HR 拒绝原因并生成诊断方案...", "INFO");
          await rejectionAnalyzer.analyzeAll(false);
          rejectionAnalyzer.analyzeAll(true).catch(err => {
            db.logEvent("ANALYSIS", `后台深度被拒复盘异常: ${err.message}`, "WARN");
          });
        }
      } else if (scheduler.isPaused) {
        scheduler.resume();
      } else {
        scheduler.start();
      }
      return sendJson({ isRunning: scheduler.isRunning, isPaused: scheduler.isPaused });
    }

    if (pathname === '/api/rejections' && method === 'GET') {
      if (rejectionAnalyzer) {
        rejectionAnalyzer.syncHistoricalRejections();
      }
      return sendJson({
        feedbacks: db.getAllRejectionFeedbacks(),
        latestReport: db.getLatestRejectionReport()
      });
    }

    if (pathname === '/api/rejections/analyze' && method === 'POST') {
      if (!rejectionAnalyzer) return sendJson({ error: 'RejectionAnalyzer not initialized' }, 500);
      db.logEvent("ANALYSIS", "收到手动复盘指令：正在结合最新 HR 拒绝原因反馈生成优化诊断报告...", "INFO");
      await rejectionAnalyzer.analyzeAll(false);
      rejectionAnalyzer.analyzeAll(true).catch(() => {});
      return sendJson({
        success: true,
        feedbacks: db.getAllRejectionFeedbacks(),
        latestReport: db.getLatestRejectionReport()
      });
    }

    if (pathname === '/api/control/mode' && method === 'POST') {
      const body = await readBody();
      if (body.mode) {
        config.executionMode = body.mode;
        db.logEvent("GUARD", `切换系统运行模式为: ${body.mode}`, "WARN");
      }
      return sendJson({ executionMode: config.executionMode });
    }

    if (pathname === '/api/approvals' && method === 'GET') {
      const pending = db.getPendingApprovals();
      return sendJson({ approvals: pending });
    }

    if (pathname.match(/^\/api\/approvals\/([^/]+)\/approve$/) && method === 'POST') {
      const actionId = pathname.split('/')[3];
      db.approveAction(actionId);
      const task = {
        task_id: `TASK_EXEC_ACT_${actionId}`,
        task_type: 'EXECUTE_CHAT_ACTION',
        target_id: actionId,
        priority: 950
      };
      db.enqueueTask(task);
      db.logEvent("GUARD", `用户人工核准动作: ${actionId}，已排入最高优先级执行`, "SUCCESS");

      if (scheduler && (!scheduler.isRunning || scheduler.isPaused)) {
        scheduler.executeSingleTask(task).catch(err => {
          db.logEvent("GUARD", `执行已核准动作 ${actionId} 失败: ${err.message}`, "ERROR");
        });
      }
      return sendJson({ success: true, actionId });
    }

    if (pathname.match(/^\/api\/approvals\/([^/]+)\/reject$/) && method === 'POST') {
      const actionId = pathname.split('/')[3];
      db.db.prepare(`UPDATE action_attempts SET status = 'VERIFIED_FAILURE', error_message = 'REJECTED_BY_USER' WHERE action_id = ?`).run(actionId);
      db.logEvent("GUARD", `用户人工拒绝动作: ${actionId}`, "WARN");
      return sendJson({ success: true, actionId });
    }

    if (pathname === '/api/postings' && method === 'GET') {
      const limit = parseInt(parsedUrl.searchParams.get('limit') || '50', 10);
      const rows = db.db.prepare(`
        SELECT p.*, s.plain_salary, s.hr_active_tag, a.decision, a.match_score, a.reason, a.filter_stage
        FROM postings p
        LEFT JOIN (
          SELECT posting_id, plain_salary, hr_active_tag, MAX(snapshot_id)
          FROM posting_snapshots
          GROUP BY posting_id
        ) s ON p.posting_id = s.posting_id
        LEFT JOIN assessments a ON p.posting_id = a.posting_id
        WHERE p.company_name IS NOT NULL AND TRIM(p.company_name) != ''
        GROUP BY p.posting_id
        ORDER BY p.updated_at DESC
        LIMIT ?
      `).all(limit);
      return sendJson({ postings: rows });
    }

    // --- 多模型预设与连通性接口 ---
    if (pathname === '/api/model-presets' && method === 'GET') {
      const list = db.getModelPresets().map(p => ({
        ...p,
        api_key_masked: maskToken(p.api_key),
        api_key_raw: p.api_key
      }));
      return sendJson({
        success: true,
        presets: list,
        currentRuntime: {
          activeModel: config.anthropicModel,
          baseUrl: config.anthropicBaseUrl,
          maskedToken: maskToken(config.anthropicAuthToken)
        }
      });
    }

    if (pathname === '/api/model-presets' && method === 'POST') {
      const body = await readBody();
      if (!body.model_name || !body.base_url) {
        return sendJson({ success: false, error: '模型名称 (model_name) 和接口网关 (base_url) 不能为空' }, 400);
      }

      const saved = db.saveModelPreset(body);
      if (body.is_active) {
        db.activateModelPreset(saved.preset_id);
        config.anthropicModel = body.model_name.trim();
        config.anthropicBaseUrl = body.base_url.trim();
        if (body.api_key && !body.api_key.includes('***')) {
          config.anthropicAuthToken = body.api_key.trim();
        }
        updateEnvFile({
          ANTHROPIC_DEFAULT_SONNET_MODEL: config.anthropicModel,
          ANTHROPIC_BASE_URL: config.anthropicBaseUrl,
          ...(body.api_key && !body.api_key.includes('***') ? { ANTHROPIC_AUTH_TOKEN: config.anthropicAuthToken } : {})
        });
        db.logEvent("CONFIG", `已激活并保存模型预设 [${body.preset_name}] -> ${config.anthropicModel}`, "SUCCESS");
      }
      return sendJson({ success: true, preset: saved });
    }

    if (pathname.match(/^\/api\/model-presets\/([^/]+)\/activate$/) && method === 'POST') {
      const presetId = pathname.split('/')[3];
      const activated = db.activateModelPreset(presetId);
      if (!activated) {
        return sendJson({ success: false, error: '预设不存在' }, 404);
      }

      config.anthropicModel = activated.model_name;
      config.anthropicBaseUrl = activated.base_url;
      if (activated.api_key) {
        config.anthropicAuthToken = activated.api_key;
      }

      updateEnvFile({
        ANTHROPIC_DEFAULT_SONNET_MODEL: activated.model_name,
        ANTHROPIC_BASE_URL: activated.base_url,
        ANTHROPIC_AUTH_TOKEN: activated.api_key
      });

      db.logEvent("CONFIG", `一键切换生效预设: [${activated.preset_name}] (模型: ${activated.model_name}, 网关: ${activated.base_url})`, "SUCCESS");
      return sendJson({
        success: true,
        preset: activated,
        currentRuntime: {
          activeModel: config.anthropicModel,
          baseUrl: config.anthropicBaseUrl,
          maskedToken: maskToken(config.anthropicAuthToken)
        }
      });
    }

    if (pathname.match(/^\/api\/model-presets\/([^/]+)$/) && method === 'DELETE') {
      const presetId = pathname.split('/')[3];
      db.deleteModelPreset(presetId);
      db.logEvent("CONFIG", `已删除模型预设: ${presetId}`, "INFO");
      return sendJson({ success: true });
    }

    // --- 连通性测试与模型探针 ---
    if (pathname === '/api/models/test-connection' && method === 'POST') {
      const body = await readBody();
      const testBaseUrl = (body.baseUrl || config.anthropicBaseUrl || '').trim();
      let testToken = (body.apiKey || '').trim();
      if (!testToken || testToken.includes('***')) {
        testToken = config.anthropicAuthToken;
      }
      const testModel = (body.model || config.anthropicModel || '').trim();

      const startTime = Date.now();
      try {
        const targetUrl = `${testBaseUrl.replace(/\/+$/, '')}/v1/models`;
        const resp = await fetch(targetUrl, {
          headers: {
            'Authorization': `Bearer ${testToken}`
          },
          signal: AbortSignal.timeout(5000)
        });
        const latencyMs = Date.now() - startTime;

        if (resp.ok) {
          const bodyData = await resp.json();
          const models = Array.isArray(bodyData.data) ? bodyData.data.map(m => m.id) : [];
          return sendJson({
            success: true,
            status: resp.status,
            latencyMs,
            models,
            message: `连通性测试成功 (HTTP 200, 耗时 ${latencyMs}ms)! 网关支持 ${models.length} 个模型`
          });
        } else {
          const errText = await resp.text();
          return sendJson({
            success: false,
            status: resp.status,
            latencyMs,
            message: `网关返回错误 (HTTP ${resp.status}): ${errText.slice(0, 180)}`
          });
        }
      } catch (err) {
        const latencyMs = Date.now() - startTime;
        return sendJson({
          success: false,
          latencyMs,
          message: `连接网关失败 (${err.message})，请检查网络或 Base URL 是否可达`
        });
      }
    }

    // --- 模型列表查询 ---
    if (pathname === '/api/models' && method === 'GET') {
      let availableModels = [];
      try {
        const targetUrl = `${config.anthropicBaseUrl.replace(/\/+$/, '')}/v1/models`;
        const resp = await fetch(targetUrl, {
          headers: {
            'Authorization': `Bearer ${config.anthropicAuthToken || 'sk-test'}`
          },
          signal: AbortSignal.timeout(3500)
        });
        if (resp.ok) {
          const bodyData = await resp.json();
          if (Array.isArray(bodyData.data)) {
            availableModels = bodyData.data.map(m => m.id);
          }
        }
      } catch (err) {
        // 请求超时或网关不可达，使用推荐备用模型列表
      }

      if (availableModels.length === 0) {
        availableModels = [
          'cangjie-agent',
          'cangjie-code',
          'cangjie-code-flash',
          'claude-3-5-sonnet-20241022'
        ];
      }

      const cur = config.anthropicModel.replace(/\[1m\]/i, '');
      if (!availableModels.includes(cur)) {
        availableModels.unshift(cur);
      }

      return sendJson({
        success: true,
        models: availableModels,
        activeModel: config.anthropicModel,
        baseUrl: config.anthropicBaseUrl
      });
    }

    // --- 配置获取与更新 ---
    if (pathname === '/api/config' && method === 'GET') {
      return sendJson({
        config: config.candidateProfile,
        modelSettings: {
          activeModel: config.anthropicModel,
          baseUrl: config.anthropicBaseUrl,
          apiKey: config.anthropicAuthToken,
          maskedToken: maskToken(config.anthropicAuthToken)
        }
      });
    }

    if (pathname === '/api/config' && method === 'POST') {
      const body = await readBody();
      const envUpdates = {};

      // 更新求职者画像
      if (body.candidateProfile) {
        Object.assign(config.candidateProfile, body.candidateProfile);
      } else if (!body.modelSettings) {
        Object.assign(config.candidateProfile, body);
      }

      // 更新模型与网关与 API Key 设置
      if (body.modelSettings) {
        if (body.modelSettings.activeModel && body.modelSettings.activeModel !== config.anthropicModel) {
          const oldModel = config.anthropicModel;
          config.anthropicModel = body.modelSettings.activeModel.trim();
          envUpdates.ANTHROPIC_DEFAULT_SONNET_MODEL = config.anthropicModel;
          db.logEvent("CONFIG", `AI 决策模型已从 ${oldModel} 热切换为: ${config.anthropicModel}`, "SUCCESS");
        }
        if (body.modelSettings.baseUrl && body.modelSettings.baseUrl !== config.anthropicBaseUrl) {
          config.anthropicBaseUrl = body.modelSettings.baseUrl.trim();
          envUpdates.ANTHROPIC_BASE_URL = config.anthropicBaseUrl;
          db.logEvent("CONFIG", `AI 网关地址已更新为: ${config.anthropicBaseUrl}`, "INFO");
        }
        if (body.modelSettings.apiKey && !body.modelSettings.apiKey.includes('***') && body.modelSettings.apiKey !== config.anthropicAuthToken) {
          config.anthropicAuthToken = body.modelSettings.apiKey.trim();
          envUpdates.ANTHROPIC_AUTH_TOKEN = config.anthropicAuthToken;
          db.logEvent("CONFIG", `AI 认证 API Key 已更新`, "SUCCESS");
        }
      }

      if (Object.keys(envUpdates).length > 0) {
        updateEnvFile(envUpdates);
      }

      db.logEvent("CONFIG", `系统画像与 AI 配置已由控制台更新并实时生效`, "SUCCESS");

      return sendJson({
        success: true,
        config: config.candidateProfile,
        modelSettings: {
          activeModel: config.anthropicModel,
          baseUrl: config.anthropicBaseUrl,
          apiKey: config.anthropicAuthToken,
          maskedToken: maskToken(config.anthropicAuthToken)
        }
      });
    }

    // --- 静态文件托管 (public) ---
    let filePath = path.join(PUBLIC_DIR, pathname === '/' ? 'index.html' : pathname);
    if (!fs.existsSync(filePath)) {
      filePath = path.join(PUBLIC_DIR, 'index.html');
    }

    const ext = path.extname(filePath).toLowerCase();
    const mimeTypes = {
      '.html': 'text/html; charset=utf-8',
      '.js': 'application/javascript; charset=utf-8',
      '.css': 'text/css; charset=utf-8',
      '.json': 'application/json; charset=utf-8',
      '.svg': 'image/svg+xml'
    };

    fs.readFile(filePath, (err, content) => {
      if (err) {
        res.writeHead(404, { 'Content-Type': 'text/plain' });
        res.end('Not Found');
      } else {
        res.writeHead(200, { 'Content-Type': mimeTypes[ext] || 'application/octet-stream' });
        res.end(content);
      }
    });
  });

  return server;
}
