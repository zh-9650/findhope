let currentTab = 'approvals';
let allPostingsCache = [];
let modelPresetsCache = [];
let activePresetId = null;

async function fetchStatus() {
  try {
    const res = await fetch('/api/status');
    const data = await res.json();

    // 更新指标
    document.getElementById('valTotalDiscovered').innerText = data.metrics.search.totalDiscovered;
    document.getElementById('valPendingScrape').innerText = `待抓取详情: ${data.metrics.search.pendingScrape}`;
    document.getElementById('valPassRate').innerText = data.metrics.assessment.passRate;
    document.getElementById('valMatchReject').innerText = `通过: ${data.metrics.assessment.matched} / 淘汰: ${data.metrics.assessment.rejected}`;
    document.getElementById('valConversing').innerText = data.metrics.funnel.conversing;
    document.getElementById('valContacted').innerText = `已打招呼: ${data.metrics.funnel.contacted} / 面试: ${data.metrics.funnel.interview}`;
    document.getElementById('valPendingApprovals').innerText = data.metrics.governance.pendingApprovals;
    document.getElementById('tabApprovalCount').innerText = data.metrics.governance.pendingApprovals;
    if (document.getElementById('tabRejectionCount')) {
      document.getElementById('tabRejectionCount').innerText = data.metrics.governance.rejectionCount || 0;
    }
    if (document.getElementById('tabFollowupCount')) {
      document.getElementById('tabFollowupCount').innerText = data.metrics.governance.followupPoolCount || 0;
    }

    // 更新调度器状态指示
    const indicator = document.getElementById('statusIndicator');
    const statusText = document.getElementById('statusText');
    const toggleText = document.getElementById('toggleText');

    if (data.scheduler.isRunning && !data.scheduler.isPaused) {
      indicator.className = 'status-indicator running';
      statusText.innerText = '正在运行';
      toggleText.innerText = '暂停调度';
    } else {
      indicator.className = 'status-indicator paused';
      statusText.innerText = data.scheduler.isPaused ? '已暂停' : '已停止';
      toggleText.innerText = '启动调度';
    }

    // 更新模式
    document.getElementById('execMode').value = data.scheduler.executionMode;
  } catch (err) {
    console.error('获取系统状态失败:', err);
  }
}

async function loadApprovals() {
  try {
    const res = await fetch('/api/approvals');
    const data = await res.json();
    const container = document.getElementById('approvalsList');

    if (!data.approvals || data.approvals.length === 0) {
      container.innerHTML = '<div class="empty-tip">当前暂无待核准事项，系统运行安全平稳。</div>';
      return;
    }

    container.innerHTML = data.approvals.map(app => `
      <div class="approval-card">
        <div class="approval-info">
          <div class="approval-target">
            <span class="badge ${app.action_kind === 'SEND_RESUME' ? 'badge-match' : 'badge-review'}">${app.action_kind}</span>
            ${app.company_name ? app.company_name + ' · ' : ''}${app.hr_name || '未命名HR'}
          </div>
          <div class="approval-payload">${app.payload}</div>
        </div>
        <div class="approval-actions">
          <button class="btn btn-sm btn-success" onclick="approveAction('${app.action_id}')">批准执行</button>
          <button class="btn btn-sm btn-danger" onclick="rejectAction('${app.action_id}')">拒绝</button>
        </div>
      </div>
    `).join('');
  } catch (err) {
    console.error('加载待审批失败:', err);
  }
}

async function approveAction(actionId) {
  await fetch(`/api/approvals/${actionId}/approve`, { method: 'POST' });
  loadApprovals();
  fetchStatus();
}

async function rejectAction(actionId) {
  await fetch(`/api/approvals/${actionId}/reject`, { method: 'POST' });
  loadApprovals();
  fetchStatus();
}

async function loadPostings() {
  try {
    const res = await fetch('/api/postings?limit=60');
    const data = await res.json();
    const rawList = data.postings || [];
    const map = new Map();
    for (const p of rawList) {
      if (p.posting_id && !map.has(p.posting_id)) {
        map.set(p.posting_id, p);
      }
    }
    allPostingsCache = Array.from(map.values());
    renderPostings(allPostingsCache);
  } catch (err) {
    console.error('加载职位池失败:', err);
  }
}

function filterPostings(filterVal) {
  if (filterVal === 'ALL') {
    renderPostings(allPostingsCache);
  } else {
    const filtered = allPostingsCache.filter(p => p.decision === filterVal);
    renderPostings(filtered);
  }
}

function renderPostings(postings) {
  const tbody = document.getElementById('postingsTbody');
  if (!postings || postings.length === 0) {
    tbody.innerHTML = '<tr><td colspan="7" class="empty-tip">暂无匹配的职位数据</td></tr>';
    return;
  }

  tbody.innerHTML = postings.map(p => {
    let badgeClass = 'badge-review';
    if (p.decision === 'MATCH') badgeClass = 'badge-match';
    if (p.decision === 'REJECT') badgeClass = 'badge-reject';

    let salary = p.plain_salary;
    if (!salary) {
      if (p.list_salary_raw && !/[\uE000-\uF8FF]/.test(p.list_salary_raw)) {
        salary = p.list_salary_raw;
      } else {
        salary = '<span style="color:var(--text-muted);font-weight:normal">详情提取中...</span>';
      }
    }
    const activeTag = p.hr_active_tag || '-';

    return `
      <tr>
        <td><strong><a href="${p.detail_url}" target="_blank" style="color:var(--text-main);text-decoration:none">${p.job_title} ↗</a></strong></td>
        <td>${p.company_name} <br><span style="font-size:11px;color:var(--text-muted)">${p.recruiter_name || ''} ${p.recruiter_title || ''}</span></td>
        <td style="color:var(--accent);font-weight:600">${salary}</td>
        <td><span style="font-size:12px;color:var(--text-muted)">${activeTag}</span></td>
        <td><span class="badge ${badgeClass}">${p.decision || '未评估'}</span></td>
        <td>${p.match_score ? (p.match_score * 100).toFixed(0) + '分' : '-'}</td>
        <td style="max-width:320px;font-size:12px;color:#cbd5e1">${p.reason || (p.status === 'DISCOVERED' ? '待抓取明文JD' : '-')}</td>
      </tr>
    `;
  }).join('');
}

async function loadLogs() {
  try {
    const res = await fetch('/api/logs?limit=50');
    const data = await res.json();
    const container = document.getElementById('terminalLogs');

    if (!data.logs || data.logs.length === 0) {
      container.innerHTML = '<div class="log-line log-info">[SYSTEM] 暂无活动日志...</div>';
      return;
    }

    container.innerHTML = data.logs.map(log => {
      const timeStr = log.created_at ? log.created_at.split('T')[1] || log.created_at : '';
      return `
        <div class="log-line">
          <span class="log-time">[${timeStr}]</span>
          <span class="log-module">[${log.module}]</span>
          <span class="log-level-${log.level}">${log.message}</span>
        </div>
      `;
    }).join('');

    container.scrollTop = container.scrollHeight;
  } catch (err) {
    console.error('加载日志失败:', err);
  }
}

async function triggerSearch() {
  const res = await fetch('/api/actions/trigger-search', { method: 'POST' });
  const data = await res.json();
  alert(data.message || '已触发搜岗');
  fetchStatus();
  if (currentTab === 'logs') loadLogs();
}

async function triggerChatSync() {
  const res = await fetch('/api/actions/trigger-chat-sync', { method: 'POST' });
  const data = await res.json();
  alert(data.message || '已触发聊天同步');
  fetchStatus();
  if (currentTab === 'logs') loadLogs();
}

async function triggerFollowupScan() {
  const res = await fetch('/api/actions/trigger-followup-scan', { method: 'POST' });
  const data = await res.json();
  alert(data.message || '已触发已读未回/送达扫描重评与追发');
  fetchStatus();
  if (currentTab === 'followups') setTimeout(loadFollowups, 1500);
  if (currentTab === 'logs') loadLogs();
}

async function loadFollowups() {
  try {
    const res = await fetch('/api/followups');
    const data = await res.json();
    const tbody = document.getElementById('followupsTbody');
    const descEl = document.getElementById('followupRuleDesc');
    if (descEl && data.config) {
      descEl.innerText = `当前生效配置：每 ${data.config.followupIntervalMinutes} 分钟定时扫描一轮已读未回/送达会话，按业务契合度（≥${data.config.followupMinScore}分，不卡年限）二次评估并定制破冰追发；连续 ${data.config.maxFollowupCount} 次扫描未回自动放弃并标记“无结果”`;
    }

    const rawList = data.conversations || [];
    const map = new Map();
    for (const c of rawList) {
      if (c.conversation_id && !map.has(c.conversation_id)) {
        map.set(c.conversation_id, c);
      }
    }
    const list = Array.from(map.values());
    if (list.length === 0) {
      tbody.innerHTML = '<tr><td colspan="6" class="empty-tip">暂无处于已读未回/送达跟进池中的会话</td></tr>';
      return;
    }

    const maxCnt = (data.config && data.config.maxFollowupCount) || 3;
    tbody.innerHTML = list.map(c => {
      const cnt = c.followup_count || 0;
      const st = c.followup_status || 'PENDING';
      let statusBadge = `<span class="badge badge-review">待扫描评估 (${cnt}/${maxCnt})</span>`;
      if (st === 'WAITING_HR') statusBadge = `<span class="badge badge-match">已追发·等待回复 (${cnt}/${maxCnt})</span>`;
      else if (st === 'NO_RESPONSE') statusBadge = `<span class="badge badge-reject">满${maxCnt}次未回·无结果放弃</span>`;
      else if (st === 'NOT_WORTH_FOLLOWUP') statusBadge = `<span class="badge badge-reject">业务不符·不追发</span>`;
      else if (st === 'HR_REPLIED') statusBadge = `<span class="badge badge-match">🎉 破冰成功·HR已回复</span>`;

      const scoreText = c.followup_eval_score != null ? `<strong>${Math.round(c.followup_eval_score * 100)}分</strong> · ` : '';
      const evalReason = c.followup_eval_reason || '<span style="color:#64748b">等待定时扫描或点击右上角“立即执行一轮扫描”</span>';
      const lastMsg = (c.last_message_text || '').slice(0, 48);

      return `
        <tr>
          <td><strong>${c.company_name || '-'}</strong><br><span style="font-size:12px;color:var(--text-muted)">${c.hr_name || ''}</span></td>
          <td>${c.job_title || '测试工程师'}<br><span style="font-size:12px;color:var(--accent)">${c.plain_salary || c.list_salary_raw || ''}</span></td>
          <td style="max-width:210px;font-size:12px;color:#cbd5e1;">${lastMsg}</td>
          <td style="max-width:250px;font-size:12px;color:#e2e8f0;">${scoreText}${evalReason}</td>
          <td style="max-width:240px;font-size:12.5px;color:#38bdf8;">${c.last_followup_text || '<span style="color:#64748b">-</span>'}</td>
          <td>${statusBadge}<br><span style="font-size:11px;color:#94a3b8">${c.last_followup_sent_at || c.last_followup_scan_at || ''}</span></td>
        </tr>
      `;
    }).join('');
  } catch (err) {
    console.error('加载已读未回跟进池失败:', err);
  }
}

// ==========================================
// AI 多模型、多 Key、独立网关预设池系统
// ==========================================

function onModelSelectChange(val) {
  const customInput = document.getElementById('cfgModelCustom');
  if (val === 'custom') {
    if (customInput) {
      customInput.style.display = 'block';
      customInput.focus();
    }
  } else {
    if (customInput) customInput.style.display = 'none';
  }
}

function toggleKeyVisibility() {
  const keyInput = document.getElementById('cfgModelApiKey');
  const btn = document.getElementById('btnToggleKey');
  if (!keyInput) return;
  if (keyInput.type === 'password') {
    keyInput.type = 'text';
    if (btn) btn.innerText = '🙈';
  } else {
    keyInput.type = 'password';
    if (btn) btn.innerText = '👁️';
  }
}

function fillPresetForm(preset) {
  if (!preset) return;
  if (document.getElementById('cfgPresetName')) document.getElementById('cfgPresetName').value = preset.preset_name || '';
  if (document.getElementById('cfgModelBaseUrl')) document.getElementById('cfgModelBaseUrl').value = preset.base_url || '';
  if (document.getElementById('cfgModelApiKey')) document.getElementById('cfgModelApiKey').value = preset.api_key_raw || preset.api_key || '';
  if (document.getElementById('cfgModelTimeout')) document.getElementById('cfgModelTimeout').value = preset.timeout_seconds || 180;

  const select = document.getElementById('cfgModelSelect');
  const customInput = document.getElementById('cfgModelCustom');
  const targetModel = preset.model_name || 'cangjie-agent';

  let found = false;
  if (select) {
    for (const opt of select.options) {
      if (opt.value === targetModel) {
        select.value = targetModel;
        found = true;
        break;
      }
    }
    if (!found) {
      select.value = 'custom';
      if (customInput) {
        customInput.style.display = 'block';
        customInput.value = targetModel;
      }
    } else {
      if (customInput) customInput.style.display = 'none';
    }
  }
}

async function loadModelPresets(selectPresetId = null) {
  try {
    const res = await fetch('/api/model-presets');
    const data = await res.json();
    modelPresetsCache = data.presets || [];

    const select = document.getElementById('cfgPresetSelect');
    const tag = document.getElementById('activeModelTag');

    if (data.currentRuntime && tag) {
      tag.innerText = `当前生效: ${data.currentRuntime.activeModel}`;
    }

    if (!select) return;

    if (modelPresetsCache.length === 0) {
      select.innerHTML = '<option value="">(暂无保存的预设)</option>';
      return;
    }

    let activePreset = modelPresetsCache.find(p => p.is_active === 1) || modelPresetsCache[0];
    if (selectPresetId) {
      const target = modelPresetsCache.find(p => p.preset_id === selectPresetId);
      if (target) activePreset = target;
    }
    activePresetId = activePreset ? activePreset.preset_id : null;

    select.innerHTML = modelPresetsCache.map(p => {
      const isCur = (p.preset_id === activePresetId);
      const activeTag = p.is_active ? ' [🟢当前生效]' : '';
      return `<option value="${p.preset_id}" ${isCur ? 'selected' : ''}>${p.preset_name} (${p.model_name})${activeTag}</option>`;
    }).join('');

    fillPresetForm(activePreset);
  } catch (err) {
    console.error('加载模型预设失败:', err);
  }
}

function onPresetSelectChange(presetId) {
  activePresetId = presetId;
  const p = modelPresetsCache.find(item => item.preset_id === presetId);
  if (p) {
    fillPresetForm(p);
  }
}

async function activateSelectedPreset() {
  const select = document.getElementById('cfgPresetSelect');
  const presetId = select ? select.value : activePresetId;
  if (!presetId) {
    alert('请先选择一个预设');
    return;
  }

  const res = await fetch(`/api/model-presets/${presetId}/activate`, { method: 'POST' });
  const data = await res.json();
  if (data.success) {
    const tag = document.getElementById('activeModelTag');
    if (tag && data.preset) {
      tag.innerText = `当前生效: ${data.preset.model_name}`;
    }
    alert(`🎉 已成功激活预设 [${data.preset.preset_name}]！模型切换为 [${data.preset.model_name}]，对应网关与 Key 已热生效并回写 .env！`);
    loadModelPresets(presetId);
    fetchStatus();
  } else {
    alert('激活失败: ' + (data.error || '未知错误'));
  }
}

async function deleteCurrentPreset() {
  const select = document.getElementById('cfgPresetSelect');
  const presetId = select ? select.value : activePresetId;
  if (!presetId) return;

  if (presetId === 'preset_cangjie_agent') {
    alert('默认推荐预设不支持删除');
    return;
  }

  if (!confirm('确定要删除当前选中的预设配置吗？')) return;

  const res = await fetch(`/api/model-presets/${presetId}`, { method: 'DELETE' });
  const data = await res.json();
  if (data.success) {
    alert('预设已删除');
    loadModelPresets();
  }
}

async function saveAsNewPreset() {
  const selVal = document.getElementById('cfgModelSelect').value;
  const customVal = document.getElementById('cfgModelCustom').value.trim();
  const model_name = (selVal === 'custom' && customVal) ? customVal : selVal;
  const base_url = document.getElementById('cfgModelBaseUrl').value.trim();
  const api_key = document.getElementById('cfgModelApiKey').value.trim();
  const timeout_seconds = parseInt(document.getElementById('cfgModelTimeout').value, 10) || 180;
  const currentName = document.getElementById('cfgPresetName').value.trim();

  const newName = prompt('请输入新预设的别名 (例如: 备用MiniMax专线 / 官方Claude):', currentName ? `${currentName} (副本)` : `${model_name}-配置`);
  if (!newName) return;

  const payload = {
    preset_id: `preset_${Date.now()}`,
    preset_name: newName,
    model_name,
    base_url,
    api_key,
    timeout_seconds,
    is_active: 0
  };

  const res = await fetch('/api/model-presets', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  });
  const data = await res.json();
  if (data.success) {
    alert(`🎉 新预设 [${newName}] 已保存至预设库！`);
    loadModelPresets(payload.preset_id);
  } else {
    alert('保存预设失败: ' + (data.error || '未知错误'));
  }
}

async function testConnection() {
  const btn = document.getElementById('btnTestConn');
  const box = document.getElementById('connTestBox');
  if (!btn || !box) return;

  const selVal = document.getElementById('cfgModelSelect').value;
  const customVal = document.getElementById('cfgModelCustom').value.trim();
  const model = (selVal === 'custom' && customVal) ? customVal : selVal;
  const baseUrl = document.getElementById('cfgModelBaseUrl').value.trim();
  const apiKey = document.getElementById('cfgModelApiKey').value.trim();

  btn.disabled = true;
  btn.innerText = '⏳ 正在检测...';
  box.style.display = 'block';
  box.style.background = '#1e293b';
  box.style.border = '1px solid #475569';
  box.style.color = '#cbd5e1';
  box.innerHTML = '正在向接口网关发起测试探针，请稍候...';

  try {
    const res = await fetch('/api/models/test-connection', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ baseUrl, apiKey, model })
    });
    const data = await res.json();

    if (data.success) {
      box.style.background = '#064e3b';
      box.style.border = '1px solid #10b981';
      box.style.color = '#a7f3d0';
      box.innerHTML = `<strong>✅ 连通性测试通过！</strong> [耗时: ${data.latencyMs}ms] 网关运行正常，探针识别到 ${data.models?.length || 0} 个可用模型通道。`;
    } else {
      box.style.background = '#450a0a';
      box.style.border = '1px solid #ef4444';
      box.style.color = '#fecaca';
      box.innerHTML = `<strong>❌ 连通性测试失败：</strong> ${data.message || '网关不可达或鉴权无效'}`;
    }
  } catch (err) {
    box.style.background = '#450a0a';
    box.style.border = '1px solid #ef4444';
    box.style.color = '#fecaca';
    box.innerHTML = `<strong>❌ 请求失败：</strong> ${err.message}`;
  } finally {
    btn.disabled = false;
    btn.innerText = '⚡ 测试此配置连通性';
  }
}

// ==========================================
// 求职者画像与全量配置加载/保存
// ==========================================

async function loadConfig() {
  try {
    const res = await fetch('/api/config');
    const data = await res.json();
    const c = data.config || {};

    // 载入模型预设系统
    await loadModelPresets();

    // 回填求职者画像设置
    document.getElementById('cfgName').value = c.name || '';
    if (document.getElementById('cfgEducation')) document.getElementById('cfgEducation').value = c.education || '全日制专升本';
    document.getElementById('cfgYears').value = c.yearsOfExperience || 0;
    if (document.getElementById('cfgStatus')) document.getElementById('cfgStatus').value = c.currentStatus || '在职-考虑机会';
    if (document.getElementById('cfgAvailableTime')) document.getElementById('cfgAvailableTime').value = c.availableTime || '1周左右（可快速交接）';
    if (document.getElementById('cfgCurrentSalary')) document.getElementById('cfgCurrentSalary').value = c.currentSalary || '4.5K';
    document.getElementById('cfgSalaryMin').value = c.salaryExpectationMin || 8;
    document.getElementById('cfgSalaryMax').value = c.salaryExpectationMax || 12;
    if (document.getElementById('cfgReasonLeaving')) document.getElementById('cfgReasonLeaving').value = c.reasonForLeaving || '';
    document.getElementById('cfgKeywords').value = (c.searchKeywords || []).join(', ');
    document.getElementById('cfgBlacklist').value = (c.blacklistKeywords || []).join(', ');
    if (document.getElementById('cfgFollowupInterval')) document.getElementById('cfgFollowupInterval').value = c.followupIntervalMinutes || 60;
    if (document.getElementById('cfgMaxFollowupCount')) document.getElementById('cfgMaxFollowupCount').value = c.maxFollowupCount || 3;
    if (document.getElementById('cfgFollowupMinScore')) document.getElementById('cfgFollowupMinScore').value = c.followupMinScore || 80;
    document.getElementById('cfgResume').value = c.resumeSummary || '';
  } catch (err) {
    console.error('加载配置失败:', err);
  }
}

async function saveConfig(e) {
  e.preventDefault();

  // 获取模型设置
  const selVal = document.getElementById('cfgModelSelect') ? document.getElementById('cfgModelSelect').value : 'cangjie-agent';
  const customVal = document.getElementById('cfgModelCustom') ? document.getElementById('cfgModelCustom').value.trim() : '';
  const chosenModel = (selVal === 'custom' && customVal) ? customVal : selVal;
  const baseUrl = document.getElementById('cfgModelBaseUrl') ? document.getElementById('cfgModelBaseUrl').value.trim() : 'http://192.168.31.86:30247';
  const apiKey = document.getElementById('cfgModelApiKey') ? document.getElementById('cfgModelApiKey').value.trim() : '';
  const timeoutSeconds = document.getElementById('cfgModelTimeout') ? parseInt(document.getElementById('cfgModelTimeout').value, 10) : 180;
  const presetName = document.getElementById('cfgPresetName') ? document.getElementById('cfgPresetName').value.trim() : '当前活跃配置';

  const candidateProfile = {
    name: document.getElementById('cfgName').value.trim(),
    education: document.getElementById('cfgEducation') ? document.getElementById('cfgEducation').value.trim() : '全日制专升本',
    yearsOfExperience: parseInt(document.getElementById('cfgYears').value, 10),
    currentStatus: document.getElementById('cfgStatus') ? document.getElementById('cfgStatus').value : '在职-考虑机会',
    availableTime: document.getElementById('cfgAvailableTime') ? document.getElementById('cfgAvailableTime').value.trim() : '1周左右（可快速交接）',
    currentSalary: document.getElementById('cfgCurrentSalary') ? document.getElementById('cfgCurrentSalary').value.trim() : '4.5K',
    salaryExpectationMin: parseInt(document.getElementById('cfgSalaryMin').value, 10),
    salaryExpectationMax: parseInt(document.getElementById('cfgSalaryMax').value, 10),
    reasonForLeaving: document.getElementById('cfgReasonLeaving') ? document.getElementById('cfgReasonLeaving').value.trim() : '',
    searchKeywords: document.getElementById('cfgKeywords').value.split(',').map(s => s.trim()).filter(Boolean),
    blacklistKeywords: document.getElementById('cfgBlacklist').value.split(',').map(s => s.trim()).filter(Boolean),
    followupIntervalMinutes: document.getElementById('cfgFollowupInterval') ? parseInt(document.getElementById('cfgFollowupInterval').value, 10) : 60,
    maxFollowupCount: document.getElementById('cfgMaxFollowupCount') ? parseInt(document.getElementById('cfgMaxFollowupCount').value, 10) : 3,
    followupMinScore: document.getElementById('cfgFollowupMinScore') ? parseInt(document.getElementById('cfgFollowupMinScore').value, 10) : 80,
    resumeSummary: document.getElementById('cfgResume').value.trim()
  };

  const payload = {
    candidateProfile,
    modelSettings: {
      activeModel: chosenModel,
      baseUrl,
      apiKey,
      timeoutSeconds
    }
  };

  // 同步更新保存当前预设
  if (activePresetId) {
    await fetch('/api/model-presets', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        preset_id: activePresetId,
        preset_name: presetName,
        model_name: chosenModel,
        base_url: baseUrl,
        api_key: apiKey,
        timeout_seconds: timeoutSeconds,
        is_active: 1
      })
    });
  }

  const res = await fetch('/api/config', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  });
  const data = await res.json();

  if (data.success) {
    const tag = document.getElementById('activeModelTag');
    if (tag && data.modelSettings) {
      tag.innerText = `当前生效: ${data.modelSettings.activeModel}`;
    }
    alert(`🎉 全套配置保存成功！\n模型 [${chosenModel}]、网关 [${baseUrl}] 与 API Key 已全面热更新并写入 .env！`);
    loadModelPresets(activePresetId);
  } else {
    alert('保存失败，请检查网络或日志');
  }

  fetchStatus();
}

async function toggleScheduler() {
  const res = await fetch('/api/control/toggle', { method: 'POST' });
  const data = await res.json();
  await fetchStatus();
  if (data.isPaused || !data.isRunning) {
    switchTab('rejections');
  }
}

async function loadRejections() {
  try {
    const res = await fetch('/api/rejections');
    const data = await res.json();
    const reportBox = document.getElementById('rejectionReportContainer');
    const tbody = document.getElementById('rejectionsTbody');

    const r = data.latestReport;
    if (r) {
      const catBadges = (r.category_breakdown || []).map(c =>
        `<span class="badge badge-review" style="margin-right:8px;padding:4px 10px;">${c.category}: ${c.count}家 (${c.ratio})</span>`
      ).join('');
      const resumeItems = (r.resume_suggestions || []).map(s => `<li style="margin-bottom:6px;">${s}</li>`).join('');
      const chatItems = (r.chat_suggestions || []).map(s => `<li style="margin-bottom:6px;">${s}</li>`).join('');

      reportBox.innerHTML = `
        <div style="background:#0f172a;border:1px solid #334155;border-left:4px solid #f59e0b;border-radius:8px;padding:16px;">
          <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:10px;">
            <strong style="color:#f8fafc;font-size:15px;">📊 停止时自动复盘诊断结论（共捕获 ${r.total_rejected} 起拒绝，${r.replied_count} 家已回复具体原因）</strong>
            <span style="font-size:12px;color:#94a3b8;">生成时间: ${r.created_at || '刚刚'}</span>
          </div>
          <div style="margin-bottom:12px;">${catBadges}</div>
          <p style="color:#e2e8f0;font-size:13.5px;line-height:1.6;margin-bottom:12px;background:#1e293b;padding:10px 12px;border-radius:6px;">
            <strong>🎯 核心症结剖析：</strong>${r.summary}
          </p>
          <div style="background:#172554;border:1px solid #1d4ed8;padding:12px;border-radius:6px;margin-bottom:12px;font-size:13px;color:#dbeafe;white-space:pre-line;line-height:1.6;">
            <strong>🚨 首句默认打招呼语诊断与替换模板：</strong><br>${r.greeting_diagnosis}
          </div>
          <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px;font-size:13px;color:#cbd5e1;">
            <div style="background:#1e293b;padding:12px;border-radius:6px;">
              <strong style="color:#38bdf8;display:block;margin-bottom:8px;">📄 简历与画像优化建议：</strong>
              <ul style="padding-left:18px;margin:0;line-height:1.5;">${resumeItems}</ul>
            </div>
            <div style="background:#1e293b;padding:12px;border-radius:6px;">
              <strong style="color:#4ade80;display:block;margin-bottom:8px;">💬 聊天方式与被拒追问策略：</strong>
              <ul style="padding-left:18px;margin:0;line-height:1.5;">${chatItems}</ul>
            </div>
          </div>
        </div>
      `;
    } else {
      reportBox.innerHTML = '<div class="empty-tip">暂无复盘报告，点击右上角“⚡ 立即复盘诊断”或“暂停调度”即可自动生成。</div>';
    }

    const list = data.feedbacks || [];
    if (list.length === 0) {
      tbody.innerHTML = '<tr><td colspan="6" class="empty-tip">暂未捕获到 HR 拒绝记录</td></tr>';
      return;
    }

    tbody.innerHTML = list.map(f => {
      let statusBadge = '<span class="badge badge-review">已追问·待HR回复</span>';
      if (f.status === 'COLLECTED') statusBadge = '<span class="badge badge-match">已收集真实原因</span>';
      else if (f.status === 'LEGACY_CLOSED') statusBadge = '<span class="badge badge-reject">旧版礼貌收尾</span>';

      return `
        <tr>
          <td><strong>${f.company_name || '-'}</strong><br><span style="font-size:12px;color:var(--text-muted)">${f.hr_name || ''}</span></td>
          <td>${f.job_title || '测试工程师'}</td>
          <td style="max-width:240px;font-size:12px;color:#fca5a5;">${f.hr_reject_message || '-'}</td>
          <td style="max-width:220px;font-size:12px;color:#94a3b8;">${f.followup_question || '-'}</td>
          <td style="max-width:240px;font-size:12.5px;color:#4ade80;font-weight:600;">${f.hr_reason_reply || '<span style="color:#64748b;font-weight:normal">等待 HR 回复中...</span>'}</td>
          <td>${statusBadge}<br><span style="font-size:11px;color:#cbd5e1">${f.inferred_category || ''}</span></td>
        </tr>
      `;
    }).join('');
  } catch (err) {
    console.error('加载被拒原因列表失败:', err);
  }
}

async function triggerRejectionAnalysis() {
  const res = await fetch('/api/rejections/analyze', { method: 'POST' });
  await res.json();
  await loadRejections();
  await fetchStatus();
}

async function switchMode(mode) {
  await fetch('/api/control/mode', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ mode })
  });
  fetchStatus();
}

function switchTab(tabId) {
  currentTab = tabId;
  document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
  document.querySelectorAll('.tab-pane').forEach(p => p.classList.remove('active'));

  const targetBtn = document.getElementById(`tabBtn-${tabId}`);
  if (targetBtn) targetBtn.classList.add('active');
  const targetPane = document.getElementById(`tab-${tabId}`);
  if (targetPane) targetPane.classList.add('active');

  if (tabId === 'approvals') loadApprovals();
  if (tabId === 'followups') loadFollowups();
  if (tabId === 'rejections') loadRejections();
  if (tabId === 'postings') loadPostings();
  if (tabId === 'logs') loadLogs();
  if (tabId === 'config') loadConfig();
}

// 初始化轮询
fetchStatus();
loadApprovals();
setInterval(() => {
  fetchStatus();
  if (currentTab === 'logs') loadLogs();
}, 3000);
