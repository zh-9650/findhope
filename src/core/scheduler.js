import { config } from '../config/index.js';

export class TaskScheduler {
  constructor(db, egoBridge, searchScraper, detailScraper, chatSync, chatEngine, jobMatcher, contactExecutor, followupEngine = null) {
    this.db = db;
    this.bridge = egoBridge;
    this.searchScraper = searchScraper;
    this.detailScraper = detailScraper;
    this.chatSync = chatSync;
    this.chatEngine = chatEngine;
    this.jobMatcher = jobMatcher;
    this.contactExecutor = contactExecutor;
    this.followupEngine = followupEngine;

    this.isRunning = false;
    this.isPaused = false;
    this.loopTimer = null;
    this.workerId = `SCHEDULER_${process.pid}_${Date.now()}`;
    this.searchKwIndex = 0;
    this.lastChatSyncTime = 0;
    this.lastFollowupScanTime = Date.now();
  }

  start() {
    if (this.isRunning && !this.isPaused) return;
    this.isRunning = true;
    this.isPaused = false;
    this.db.logEvent("SCHEDULER", `调度中枢已启动 [运行模式: ${config.executionMode}]，监听求职关键词: ${config.candidateProfile.searchKeywords.join(', ')}`, "SUCCESS");
    console.log(`[TaskScheduler] 调度中枢已启动 (Worker: ${this.workerId})`);

    // 启动第一优先级 (P0)：立即巡检消息列表，清空未读与待回复会话
    this.lastChatSyncTime = Date.now();
    this.db.enqueueTask({
      task_id: `STARTUP_CHAT_SYNC_${Date.now()}`,
      task_type: 'CHAT_SYNC',
      priority: 999
    });

    this.scheduleNextTick(100);
  }

  pause() {
    this.isPaused = true;
    this.db.logEvent("SCHEDULER", `调度中枢已暂停`, "WARN");
    console.log(`[TaskScheduler] 调度中枢已暂停`);
  }

  resume() {
    this.isPaused = false;
    this.db.logEvent("SCHEDULER", `调度中枢已恢复运行，优先巡检未读会话`, "SUCCESS");
    console.log(`[TaskScheduler] 调度中枢已恢复运行`);

    this.lastChatSyncTime = Date.now();
    this.db.enqueueTask({
      task_id: `RESUME_CHAT_SYNC_${Date.now()}`,
      task_type: 'CHAT_SYNC',
      priority: 999
    });

    this.scheduleNextTick(100);
  }

  stop() {
    this.isRunning = false;
    if (this.loopTimer) clearTimeout(this.loopTimer);
    this.db.releaseLease("EGO_BROWSER", this.workerId);
    this.db.logEvent("SCHEDULER", `调度中枢已停止并释放浏览器锁`, "INFO");
    console.log(`[TaskScheduler] 调度中枢已停止并释放资源锁`);
  }

  scheduleNextTick(delayMs = 2500) {
    if (!this.isRunning || this.isPaused) return;
    this.loopTimer = setTimeout(async () => {
      try {
        await this.runTick();
      } catch (err) {
        console.error(`[TaskScheduler] 调度轮询异常:`, err.message);
        this.db.logEvent("SCHEDULER", `调度轮询发生异常: ${err.message}`, "ERROR");
      } finally {
        if (this.isRunning && !this.isPaused) {
          this.scheduleNextTick(3000);
        }
      }
    }, delayMs);
  }

  /**
   * 自动生成并编排全链路任务
   * 优先级顺序：
   * P0 (950): 用户在控制台已批准待执行的聊天动作 (APPROVED_CHAT_ACTION)
   * P0 (900): 周期性/启动聊天巡检与未读插队回复 (CHAT_SYNC)
   * P1 (50):  对已 MATCH 岗位发起首次建联打招呼 (CONTACT_OPPORTUNITY)
   * P2 (30):  对已提取详情的搜索岗位进行 Claude 匹配打分 (ASSESS)
   * P3 (20):  对新发现岗位提取明文薪资与 JD 详情 (DETAIL_FETCH)
   * P4 (10):  按关键词动态滚动深度搜岗造血 (SEARCH)
   */
  ensureTasks() {
    const nextTask = this.db.getNextTask();
    if (nextTask) return nextTask;

    const now = Date.now();

    // 0. 检查是否有用户在控制台批准的待执行动作 (或者准备就绪的动作)
    const approvedActions = this.db.getApprovedPendingActions();
    if (approvedActions && approvedActions.length > 0) {
      const act = approvedActions[0];
      this.db.enqueueTask({
        task_id: `TASK_EXEC_ACT_${act.action_id}`,
        task_type: 'EXECUTE_CHAT_ACTION',
        target_id: act.action_id,
        priority: 950
      });
      return this.db.getNextTask();
    }

    // 1. 每隔 25 秒高优先级插队巡检一次聊天会话
    if (now - this.lastChatSyncTime > 25000) {
      this.lastChatSyncTime = now;
      this.db.enqueueTask({
        task_id: `TASK_CHAT_${now}`,
        task_type: 'CHAT_SYNC',
        priority: 900
      });
      return this.db.getNextTask();
    }

    // 1.5 按配置周期（默认 60 分钟 = 1 小时）定时扫描“已读未回 / 送达”会话进行二次业务评估与追发
    const followupIntervalMs = (Number(config.candidateProfile.followupIntervalMinutes) || 60) * 60 * 1000;
    if (this.followupEngine && config.candidateProfile.followupEnabled !== false && (now - this.lastFollowupScanTime >= followupIntervalMs)) {
      this.lastFollowupScanTime = now;
      this.db.enqueueTask({
        task_id: `TASK_FOLLOWUP_${now}`,
        task_type: 'FOLLOWUP_SCAN',
        priority: 80
      });
      return this.db.getNextTask();
    }

    // 2. 检查是否有匹配通过 (MATCH) 且尚未发起沟通的求职机会
    const pendingOpp = this.db.db.prepare(`
      SELECT o.posting_id, p.detail_url, p.job_title, p.company_name
      FROM opportunities o
      JOIN postings p ON o.posting_id = p.posting_id
      WHERE o.stage = 'CONTACT_PENDING'
        AND p.detail_url LIKE '%/job_detail/%'
      LIMIT 1
    `).get();

    if (pendingOpp) {
      this.db.enqueueTask({
        task_id: `TASK_CONTACT_${pendingOpp.posting_id}`,
        task_type: 'CONTACT_OPPORTUNITY',
        target_id: pendingOpp.posting_id,
        priority: 50
      });
      return this.db.getNextTask();
    }

    // 3. 检查是否有已抓取详情但尚未评估的搜索岗位（排除 CHAT_ACTIVE 和 ASSESS_FAILED）
    const pendingAssess = this.db.db.prepare(`
      SELECT p.posting_id
      FROM postings p
      JOIN posting_snapshots s ON p.posting_id = s.posting_id
      LEFT JOIN assessments a ON p.posting_id = a.posting_id
      WHERE p.status = 'DETAIL_SCRAPED' AND a.assessment_id IS NULL
      LIMIT 1
    `).get();

    if (pendingAssess) {
      this.db.enqueueTask({
        task_id: `TASK_ASSESS_${pendingAssess.posting_id}`,
        task_type: 'ASSESS',
        target_id: pendingAssess.posting_id,
        priority: 30
      });
      return this.db.getNextTask();
    }

    // 4. 检查是否有已发现但未提取明文详情的岗位
    const pendingDetail = this.db.db.prepare(`
      SELECT posting_id, detail_url FROM postings WHERE status = 'DISCOVERED' LIMIT 1
    `).get();

    if (pendingDetail) {
      this.db.enqueueTask({
        task_id: `TASK_DETAIL_${pendingDetail.posting_id}`,
        task_type: 'DETAIL_FETCH',
        target_id: pendingDetail.posting_id,
        priority: 20
      });
      return this.db.getNextTask();
    }

    // 5. 循环搜岗造血
    const kws = config.candidateProfile.searchKeywords;
    if (kws && kws.length > 0) {
      const kw = kws[this.searchKwIndex % kws.length];
      this.searchKwIndex++;
      this.db.enqueueTask({
        task_id: `TASK_SEARCH_${now}`,
        task_type: 'SEARCH',
        target_id: kw,
        priority: 10
      });
      return this.db.getNextTask();
    }

    return null;
  }

  /**
   * 独立单步执行单次任务 (在暂停或未启动模式下依然可以单次点对点运行)
   */
  async executeSingleTask(task) {
    console.log(`[TaskScheduler] 正在以单步模式独立执行任务: ${task.task_id} (${task.task_type})`);
    return await this.executeTask(task);
  }

  /**
   * 单次调度原子工作单元
   */
  async runTick() {
    if (!this.isRunning || this.isPaused) return;

    const task = this.ensureTasks();
    if (!task) return;

    await this.executeTask(task);
  }

  /**
   * 统一的任务执行分发器 (兼具自动调度与手动单步调用)
   */
  async executeTask(task) {
    if (!task) return;

    // --- 分支 A：纯模型分析任务（ASSESS）无需占用 Ego 浏览器锁 ---
    if (task.task_type === 'ASSESS') {
      try {
        this.db.saveTaskCheckpoint(task.task_id, 'RUNNING', {});
        const postWithSnap = this.db.getPostingWithLatestSnapshot(task.target_id);
        if (postWithSnap) {
          this.db.logEvent("CLAUDE", `开始对岗位【${postWithSnap.company_name || '目标企业'} - ${postWithSnap.job_title}】进行智能匹配打分...`, "INFO");
          const assessRes = await this.jobMatcher.evaluatePosting(postWithSnap, config.candidateProfile, 1);
          const levelTag = assessRes.decision === 'MATCH' ? 'SUCCESS' : (assessRes.decision === 'REJECT' ? 'WARN' : 'INFO');
          this.db.logEvent("CLAUDE", `岗位评估完成: ${assessRes.decision} (${(assessRes.match_score * 100).toFixed(0)}分) - ${assessRes.reason}`, levelTag);
          this.db.saveTaskCheckpoint(task.task_id, 'DONE', assessRes);
        } else {
          this.db.saveTaskCheckpoint(task.task_id, 'DONE', {});
        }
      } catch (err) {
        // 关键防死锁：若该岗位评估异常，将其状态标记为 ASSESS_FAILED，防止下个 Tick 无限死循环重抓同一岗位
        this.db.db.prepare(`UPDATE postings SET status = 'ASSESS_FAILED', updated_at = CURRENT_TIMESTAMP WHERE posting_id = ?`).run(task.target_id);
        this.db.logEvent("CLAUDE", `岗位 [${task.target_id}] 评估异常已跳过: ${err.message}`, "ERROR");
        this.db.saveTaskCheckpoint(task.task_id, 'FAILED', { error: err.message });
      }
      return;
    }

    // --- 分支 B：聊天同步与智能回复 (采集与大模型推理解耦，不长期霸占浏览器锁) ---
    if (task.task_type === 'CHAT_SYNC') {
      let attentionConversations = [];

      // 阶段 1：借用浏览器锁，快速巡检并提取所有需关注会话的上下文
      const lease = this.db.acquireLease("EGO_BROWSER", this.workerId, 30000);
      if (!lease.acquired) {
        console.warn(`[TaskScheduler] 浏览器资源锁被占用，稍后重试`);
        return;
      }

      try {
        this.db.saveTaskCheckpoint(task.task_id, 'RUNNING', {});
        this.db.logEvent("CHAT", `正在巡检 BOSS 聊天会话列表与待回复消息...`, "INFO");
        const list = await this.chatSync.syncConversationList();

        // 全量筛选出所有需要关注的会话（取消 slice(0,2) 截断限制！）
        const needCheckItems = list.filter(item => item.needsAttention);
        this.db.logEvent(
          "CHAT",
          `会话巡检完成，扫描前 ${list.length} 项会话，待核查/待回复会话: ${needCheckItems.length} 个 (${needCheckItems.map(i => `${i.companyName || ''}${i.hrName}`).join(', ') || '无'})`,
          needCheckItems.length > 0 ? "WARN" : "INFO"
        );

        for (const item of needCheckItems) {
          try {
            this.db.logEvent("CHAT", `正在定位并打开【${item.companyName} - ${item.hrName}】会话提取上下文...`, "INFO");
            const inspectRes = await this.chatSync.openAndInspectConversation(item, item.convId);
            this.db.logEvent(
              "CHAT",
              `【${item.companyName} - ${item.hrName}】提取完成：共 ${inspectRes.totalMessagesInView} 条消息，最后发言=${inspectRes.isLastFromHr ? 'HR' : '我方'}，简历状态=${inspectRes.capabilities.sendResume}`,
              "SUCCESS"
            );
            if (inspectRes.isLastFromHr) {
              attentionConversations.push({ item, inspectRes });
            }
          } catch (openErr) {
            this.db.logEvent("CHAT", `打开会话【${item.companyName} - ${item.hrName}】异常: ${openErr.message}`, "WARN");
          }
        }
      } catch (err) {
        this.db.logEvent("SCHEDULER", `聊天采集阶段异常: ${err.message}`, "ERROR");
        this.db.saveTaskCheckpoint(task.task_id, 'FAILED', { error: err.message });
        return;
      } finally {
        // 采集完毕立即释放浏览器锁！绝不在 Claude 思考期间霸占浏览器
        this.db.releaseLease("EGO_BROWSER", this.workerId);
      }

      // 阶段 2：在无浏览器锁状态下逐个调用 Claude 决策，若需要执行发送则由 ActionGuard 独立借锁执行
      if (this.chatEngine && attentionConversations.length > 0) {
        for (const { item, inspectRes } of attentionConversations) {
          try {
            this.db.logEvent("CLAUDE", `正在分析【${item.companyName} - ${item.hrName}】最新消息并决策...`, "INFO");
            const chatDecision = await this.chatEngine.processIncomingMessages(item.convId);

            if (chatDecision.skipped) {
              this.db.logEvent(
                "CHAT_ENGINE",
                `【${item.companyName} - ${item.hrName}】跳过自动回复：${chatDecision.reason}`,
                chatDecision.rejectedByHardRule ? "WARN" : "INFO"
              );
              continue;
            }

            this.db.logEvent(
              "CLAUDE",
              `【${item.companyName} - ${item.hrName}】决策完成: 动作【${chatDecision.decision.action_request}】 | 草稿: "${chatDecision.decision.draft_reply}"`,
              "SUCCESS"
            );

            // 若无需人工审批（如 FULL_AUTO 模式），通过 ActionGuard 申请短暂浏览器锁执行真实发送与防重校验
            if (chatDecision.actionIntent && !chatDecision.actionIntent.requiresApproval && chatDecision.decision.action_request !== 'NONE') {
              const sendLease = this.db.acquireLease("EGO_BROWSER", this.workerId, 30000);
              if (sendLease.acquired) {
                try {
                  this.db.logEvent("GUARD", `ActionGuard 正在向【${item.companyName} - ${item.hrName}】执行 ${chatDecision.decision.action_request}...`, "INFO");
                  const guardRes = await this.chatEngine.guard.executeChatAction(chatDecision.actionIntent.actionId);
                  if (guardRes.cancelled) {
                    this.db.logEvent("GUARD", `【${item.companyName} - ${item.hrName}】发送取消：检测到我方已回复 (${guardRes.reason})`, "WARN");
                  } else if (guardRes.success) {
                    this.db.logEvent("GUARD", `【${item.companyName} - ${item.hrName}】动作与回复已确认送达并回写账本！`, "SUCCESS");
                  } else {
                    this.db.logEvent("GUARD", `【${item.companyName} - ${item.hrName}】执行状态待核验: ${guardRes.error || guardRes.status}`, "WARN");
                  }
                } finally {
                  this.db.releaseLease("EGO_BROWSER", this.workerId);
                }
              }
            }
          } catch (err) {
            this.db.logEvent("CLAUDE", `针对【${item.companyName} - ${item.hrName}】决策异常: ${err.message}`, "WARN");
          }
        }
      }

      this.db.saveTaskCheckpoint(task.task_id, 'DONE', { processedCount: attentionConversations.length });
      return;
    }

    // --- 分支 B2：已读未回/送达沉寂会话定时扫描、二次评估与破冰追发 ---
    if (task.task_type === 'FOLLOWUP_SCAN') {
      try {
        this.db.saveTaskCheckpoint(task.task_id, 'RUNNING', {});
        const isManual = task.task_id.startsWith('MANUAL_FOLLOWUP_');
        const res = this.followupEngine
          ? await this.followupEngine.runFollowupBatch(this.workerId, isManual)
          : { scanned: 0 };
        this.db.saveTaskCheckpoint(task.task_id, 'DONE', res);
      } catch (err) {
        this.db.logEvent("FOLLOWUP", `已读未回/送达扫描任务异常: ${err.message}`, "ERROR");
        this.db.saveTaskCheckpoint(task.task_id, 'FAILED', { error: err.message });
      }
      return;
    }

    // --- 分支 C：其余单步浏览器操作任务 (EXECUTE_CHAT_ACTION, SEARCH, DETAIL_FETCH, CONTACT_OPPORTUNITY) ---
    const lease = this.db.acquireLease("EGO_BROWSER", this.workerId, 30000);
    if (!lease.acquired) {
      console.warn(`[TaskScheduler] 浏览器资源锁被占用，稍后重试`);
      return;
    }

    try {
      this.db.saveTaskCheckpoint(task.task_id, 'RUNNING', {});

      if (task.task_type === 'EXECUTE_CHAT_ACTION') {
        const actionId = task.target_id;
        this.db.logEvent("GUARD", `正在执行已核准的聊天动作 [${actionId}]...`, "INFO");
        const res = await this.chatEngine.guard.executeChatAction(actionId);
        if (res.success) {
          this.db.logEvent("GUARD", `已核准动作 [${actionId}] 执行成功并送达！`, "SUCCESS");
        } else {
          this.db.logEvent("GUARD", `已核准动作 [${actionId}] 未完全确认: ${res.error || res.status}`, "WARN");
        }
        this.db.saveTaskCheckpoint(task.task_id, 'DONE', res);
      } else if (task.task_type === 'SEARCH') {
        const kw = task.target_id || '测试工程师';
        this.db.logEvent("SEARCH", `正在通过 Ego 浏览器搜索岗位关键词: "${kw}"...`, "INFO");
        const res = await this.searchScraper.runSearchBatch(kw, '101270100', 2);
        this.db.logEvent("SEARCH", `搜索 "${kw}" 完成: 扫描 ${res.totalScanned} 个卡片，新增 ${res.newCount} 个岗位，重复过滤 ${res.duplicateCount} 个`, "SUCCESS");
        this.db.saveTaskCheckpoint(task.task_id, 'DONE', res);
      } else if (task.task_type === 'DETAIL_FETCH') {
        const post = this.db.db.prepare(`SELECT * FROM postings WHERE posting_id = ?`).get(task.target_id);
        if (post) {
          this.db.logEvent("DETAIL", `正在提取岗位【${post.company_name || ''} - ${post.job_title}】明文薪资与完整职责...`, "INFO");
          const res = await this.detailScraper.scrapeJobDetail(post.posting_id, post.detail_url);
          if (res.status === 'ALREADY_CONTACTED') {
            this.db.logEvent("DETAIL", `岗位【${post.company_name || ''} - ${post.job_title}】已处于【继续沟通】状态，自动归入已建联并跳过重复打分`, "INFO");
          } else {
            this.db.logEvent("DETAIL", `详情提取完成: 薪资【${res.plainSalary || '面议'}】，公司: ${res.companyName || '已同步'}，HR活跃度: ${res.hrActiveTag || '未知'}`, "SUCCESS");
          }
          this.db.saveTaskCheckpoint(task.task_id, 'DONE', res);
        } else {
          this.db.saveTaskCheckpoint(task.task_id, 'DONE', {});
        }
      } else if (task.task_type === 'CONTACT_OPPORTUNITY') {
        const post = this.db.db.prepare(`SELECT * FROM postings WHERE posting_id = ?`).get(task.target_id);
        if (post) {
          this.db.logEvent("GUARD", `【全自动首次建联】正在对 MATCH 岗位【${post.company_name} - ${post.job_title}】发起打招呼...`, "INFO");
          const res = await this.contactExecutor.contactPosting(post.posting_id, post.detail_url);
          if (res.success) {
            this.db.logEvent("GUARD", `【建联成功】已成功向【${post.company_name}】发起沟通并确认招呼送达！`, "SUCCESS");
          } else {
            this.db.logEvent("GUARD", `【建联未完成】${res.error || '未能完成建联'}（已自动归档跳过）`, "WARN");
            this.db.createOrUpdateOpportunity({
              posting_id: post.posting_id,
              stage: 'CLOSED',
              notes: `首次建联未找到沟通按钮或已沟通过: ${res.error || 'UNKNOWN'}`
            });
          }
          this.db.saveTaskCheckpoint(task.task_id, 'DONE', res);
        } else {
          this.db.saveTaskCheckpoint(task.task_id, 'DONE', {});
        }
      }
    } catch (err) {
      console.error(`[TaskScheduler] 任务 ${task.task_id} 执行出错:`, err.message);
      this.db.logEvent("SCHEDULER", `任务 ${task.task_id} 执行异常: ${err.message}`, "ERROR");
      this.db.saveTaskCheckpoint(task.task_id, 'FAILED', { error: err.message });
    } finally {
      this.db.releaseLease("EGO_BROWSER", this.workerId);
    }
  }
}
