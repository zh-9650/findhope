import { config } from '../config/index.js';

export class FollowupEngine {
  constructor(claudeRunner, actionGuard, chatSync, db) {
    this.runner = claudeRunner;
    this.guard = actionGuard;
    this.chatSync = chatSync;
    this.db = db;
  }

  /**
   * 将 SQLite UTC 时间字符串安全转换为毫秒时间戳
   */
  static parseSqliteUtc(tsStr) {
    if (!tsStr) return 0;
    const normalized = tsStr.includes('T') ? tsStr : tsStr.replace(' ', 'T') + 'Z';
    const ms = new Date(normalized).getTime();
    return Number.isNaN(ms) ? 0 : ms;
  }

  /**
   * 执行一轮“已读未回 / 送达未读”沉寂会话扫描、高标准业务重评、破冰追发与 3 次不回熔断
   * @param {string} workerId 调度器 Worker ID（用于借还浏览器锁）
   * @param {boolean} forceIgnoreCooldown 手动触发时是否允许跳过 1 小时冷却限制（仅针对尚未追发满的会话）
   */
  async runFollowupBatch(workerId = 'FOLLOWUP_WORKER', forceIgnoreCooldown = false) {
    const profile = config.candidateProfile;
    if (profile.followupEnabled === false && !forceIgnoreCooldown) {
      return { scanned: 0, followedUp: 0, markedNoResponse: 0, skippedNotWorth: 0 };
    }

    const intervalMinutes = Number(profile.followupIntervalMinutes) || 60;
    const maxCount = Number(profile.maxFollowupCount) || 3;
    const minScore = Number(profile.followupMinScore) || 80;
    const cooldownMs = intervalMinutes * 60 * 1000;
    const nowMs = Date.now();

    // 阶段 1：借用浏览器锁扫描左侧会话列表中的 [已读] / [送达] 沉寂项
    let silentItems = [];
    const scanLease = this.db.acquireLease("EGO_BROWSER", workerId, 45000);
    if (!scanLease.acquired) {
      this.db.logEvent("FOLLOWUP", "浏览器锁正在被占用，顺延本轮已读未回扫描", "WARN");
      return { scanned: 0, followedUp: 0, markedNoResponse: 0, skippedNotWorth: 0 };
    }

    try {
      this.db.logEvent("FOLLOWUP", `正在扫描处于【已读未回 / 送达】状态的沉寂会话 (周期=${intervalMinutes}分钟, 熔断阈值=${maxCount}次, 评估线=${minScore}分)...`, "INFO");
      silentItems = await this.chatSync.scanSilentConversations(25);
    } finally {
      this.db.releaseLease("EGO_BROWSER", workerId);
    }

    let followedUpCount = 0;
    let markedNoResponseCount = 0;
    let skippedNotWorthCount = 0;
    let processedActiveCount = 0;

    for (const item of silentItems) {
      const conv = this.db.db.prepare(`SELECT * FROM conversations WHERE conversation_id = ?`).get(item.convId);
      if (!conv) continue;

      const currentStatus = conv.followup_status || 'PENDING';
      const currentCount = conv.followup_count || 0;

      // 已终态（无结果放弃 / 评估不值得追发）的直接跳过
      if (currentStatus === 'NO_RESPONSE' || currentStatus === 'NOT_WORTH_FOLLOWUP') {
        continue;
      }

      // 检查距离上次扫描/追发是否已满足冷却间隔（默认 60 分钟）
      const lastScanMs = FollowupEngine.parseSqliteUtc(conv.last_followup_scan_at || conv.last_followup_sent_at);
      if (!forceIgnoreCooldown && lastScanMs > 0 && (nowMs - lastScanMs) < cooldownMs) {
        continue;
      }

      const nextCount = currentCount + 1;

      // 【核心规则：连续 3 次扫描均为已读未回/送达 -> 触发熔断，不再坚持，标记“无结果”】
      if (nextCount >= maxCount) {
        this.db.updateConversationFollowup(item.convId, {
          followup_count: nextCount,
          followup_status: 'NO_RESPONSE',
          touch_scan_at: true
        });

        if (conv.posting_id) {
          this.db.createOrUpdateOpportunity({
            posting_id: conv.posting_id,
            conversation_id: item.convId,
            stage: 'NO_RESPONSE',
            notes: `连续 ${nextCount} 次定时扫描仍处于【${item.deliveryTag}】状态，不再坚持追发，标记为无结果`
          });
        }

        markedNoResponseCount++;
        this.db.logEvent(
          "FOLLOWUP",
          `【满${maxCount}次不回·放弃跟进】${item.companyName} - ${item.hrName} 连续 ${nextCount} 次扫描均为【${item.deliveryTag}】，不再坚持，已标记为【无结果 (NO_RESPONSE)】`,
          "WARN"
        );
        continue;
      }

      // 单轮最多对 4 个沉寂会话执行点开评估与追发，避免单次耗时过长
      if (processedActiveCount >= 4) {
        continue;
      }
      processedActiveCount++;

      // 阶段 2：借用浏览器锁点开该沉寂会话，读取最新顶栏岗位、薪资、简历按钮与气泡历史
      let inspectRes = null;
      const openLease = this.db.acquireLease("EGO_BROWSER", workerId, 30000);
      if (!openLease.acquired) continue;

      try {
        inspectRes = await this.chatSync.openAndInspectConversation(item);
      } catch (err) {
        this.db.logEvent("FOLLOWUP", `点开沉寂会话【${item.companyName} - ${item.hrName}】异常: ${err.message}`, "WARN");
        continue;
      } finally {
        this.db.releaseLease("EGO_BROWSER", workerId);
      }

      // 二次确认：若点开后发现 HR 其实已经回复了，或者存在拒信，则跳过追发
      if (!inspectRes || inspectRes.lastSender === 'HR' || this.db.getRejectionFeedback(item.convId)) {
        continue;
      }

      const updatedConv = this.db.db.prepare(`SELECT * FROM conversations WHERE conversation_id = ?`).get(item.convId);
      let posting = null;
      if (updatedConv && updatedConv.posting_id) {
        posting = this.db.getPostingWithLatestSnapshot(updatedConv.posting_id);
      }
      if (!posting && item.companyName) {
        // 尝试按公司名关联已抓取过详情的岗位
        const matchedPost = this.db.db.prepare(`
          SELECT posting_id FROM postings WHERE company_name = ? AND posting_id NOT LIKE 'CHAT_%' LIMIT 1
        `).get(item.companyName);
        if (matchedPost) {
          posting = this.db.getPostingWithLatestSnapshot(matchedPost.posting_id);
        }
      }

      const jobTitle = (posting && posting.job_title) || (inspectRes.jobInfo && inspectRes.jobInfo.jobTitle) || '软件测试/自动化测试工程师';
      const jobSalary = (posting && (posting.plain_salary || posting.list_salary_raw)) || (inspectRes.jobInfo && inspectRes.jobInfo.salary) || '8-12K';
      const jdText = (posting && posting.jd_text) || `职位名称：${jobTitle}，公司：${item.companyName}，标注薪资：${jobSalary}`;

      // 黑名单前置拦截（外包/驻场绝不二次追发）
      const checkStr = `${item.companyName} ${jobTitle} ${jdText}`;
      const hitBlack = (profile.blacklistKeywords || []).find(kw => checkStr.includes(kw));
      if (hitBlack) {
        this.db.updateConversationFollowup(item.convId, {
          followup_count: nextCount,
          followup_status: 'NOT_WORTH_FOLLOWUP',
          followup_eval_score: 0.1,
          followup_eval_reason: `命中排除词 "${hitBlack}"，放弃二次追发`,
          touch_scan_at: true
        });
        skippedNotWorthCount++;
        continue;
      }

      const recentMsgs = this.db.getRecentMessages(item.convId, 10);
      const historyStr = recentMsgs.map(m => `${m.sender_type === 'CANDIDATE' ? '【我方】' : '【HR】'}: ${m.content}`).join('\n');
      const hadOldAiGreeting = recentMsgs.some(m => m.sender_type === 'CANDIDATE' && m.content.includes('目前主要想找 AI 应用测试方向'));

      // 阶段 3：调用 Claude 执行“高标准业务契合度二次评估（重业务、不卡年限）+ 定制破冰追发话术”
      try {
        this.db.logEvent("FOLLOWUP", `正在对沉寂会话【${item.companyName} - ${item.hrName}】(${item.deliveryTag}, 第${nextCount}/${maxCount}次扫描) 进行业务契合度重评...`, "INFO");

        const prompt = `请作为求职者（${profile.name}）的“已读未回/送达二次唤醒评估官”，对以下处于【${item.deliveryTag}】状态的岗位进行高标准二次评估，并決定是否值得继续发消息争取：

【候选人真实业务与技术底牌】：
- 基本背景：${profile.name}，${profile.education}，${profile.yearsOfExperience}年测试经验，目前在职（1周左右快速到岗），期望薪资${profile.salaryExpectationMin}-${profile.salaryExpectationMax}K
- 核心业务与技术能力：
  1. 自动化与接口测试：精通 Python + Playwright / Selenium + Pytest（Web/UI自动化、接口自动化框架与CI/CD回归）
  2. 性能与工程底座：熟练掌握 JMeter 并发压测与瓶颈分析，熟练使用 Linux / Shell、MySQL 数据库调优、Docker 容器化与微服务测试
  3. AI 应用评测：做过企业级 AI 大模型、Agent 智能体、RAG 检索增强应用的落地评测

【目标岗位与公司信息】：
- 公司与HR：${item.companyName} - ${item.hrName}
- 岗位名称：${jobTitle} (${jobSalary})
- 岗位详情/JD：${jdText}
- 当前会话状态：${item.deliveryTag}（第 ${nextCount} 次被沉寂扫描命中，最多不超过 ${maxCount} 次）
- 发送附件简历按钮状态：${inspectRes.tools ? inspectRes.tools.sendResume : 'AVAILABLE'}
- 历史已发消息记录：
${historyStr || item.lastMsg}

【二次严选评估准则（门槛 ${minScore} 分，重点看业务契合，绝不卡死年限）】：
1. 【年限豁免铁律】：无论岗位写 3 年还是 3-5 年经验，年限一律不作为扣分或淘汰条件！
2. 【重点看业务与核心技术契合度】：
   - 高优必追（85~98分）：岗位业务属于 AI/大模型/Agent测试，或属于 Python/Web/UI自动化、接口自动化、性能压测、SaaS/中后台/微服务/Linux+MySQL 软件测试，且非外包；
   - 不值得追发（< ${minScore}分）：岗位核心业务是纯硬件/嵌入式底层驱动、强绑定特定银行清算/主机安全底层C++开发、或属于外包驻场。
3. 【定制破冰追发话术要求（若判定值得追发）】：
   - 严禁发“您好在吗”等无意义催促，严禁写长篇AI套话，严格控制在 18~42 字以内，像真人手机打字一样干脆自然！
   - 必须结合【该岗位的具体业务点 + 我方对应实战能力】，主动破冰（例如询问“我可以把简历发您看看吗？”或点出匹配点）；
   - ${hadOldAiGreeting ? '【特别纠偏提醒】：我方上一条默认招呼语写死了“主要想找AI应用测试方向”，若该岗位是常规自动化/软件测试岗，追发话术必须自然纠偏说明“补充下，我平时主力也是做Python接口/UI自动化和JMeter压测的，我可以把简历发您看看吗？”' : ''}
   - 若这是第 2 次追发，绝不能与上一条我方消息内容重复！

请仅输出以下严格合法的 JSON（字符串内部严禁使用未转义的英文双引号）：
{
  "worth_followup": true | false,
  "score": 0 到 100 的整数,
  "eval_reason": "简明扼要说明业务匹配点或不值得追发的原因",
  "followup_message": "若 worth_followup 为 true，输出 18~42 字的真人定制破冰话术（如结合岗位业务+我可以把简历发您看看吗？）；否则输出空字符串"
}`;

        const evalRes = await this.runner.invokeReasoning(prompt, "FOLLOWUP_EVAL");
        const score = Number(evalRes.score) || 0;
        const worthFollowup = Boolean(evalRes.worth_followup) && score >= minScore && Boolean(evalRes.followup_message);

        if (!worthFollowup) {
          this.db.updateConversationFollowup(item.convId, {
            followup_count: nextCount,
            followup_status: 'NOT_WORTH_FOLLOWUP',
            followup_eval_score: score / 100,
            followup_eval_reason: evalRes.eval_reason || `二次业务评估得分 ${score} < ${minScore}，不再追发`,
            touch_scan_at: true
          });

          if (updatedConv && updatedConv.posting_id) {
            this.db.createOrUpdateOpportunity({
              posting_id: updatedConv.posting_id,
              conversation_id: item.convId,
              stage: 'DORMANT',
              notes: `二次业务严选未达追发标准 (${score}分): ${evalRes.eval_reason}`
            });
          }

          skippedNotWorthCount++;
          this.db.logEvent(
            "FOLLOWUP",
            `【评估不追发】${item.companyName} - ${item.hrName} (${jobTitle}) 二次业务评分 ${score}分 (<${minScore}分): ${evalRes.eval_reason}`,
            "INFO"
          );
          continue;
        }

        // 阶段 4：通过高标准二次评估 -> 经 ActionGuard 发送定制破冰追发消息
        const replyText = evalRes.followup_message.trim();
        const actionIntent = this.guard.registerIntent({
          conversation_id: item.convId,
          posting_id: updatedConv ? updatedConv.posting_id : null,
          action_kind: 'SEND_REPLY',
          payload: replyText
        });

        this.db.updateConversationFollowup(item.convId, {
          followup_count: nextCount,
          followup_status: 'WAITING_HR',
          followup_eval_score: score / 100,
          followup_eval_reason: evalRes.eval_reason,
          last_followup_text: replyText,
          touch_scan_at: true,
          touch_sent_at: true
        });

        if (!actionIntent.requiresApproval) {
          const sendLease = this.db.acquireLease("EGO_BROWSER", workerId, 30000);
          if (sendLease.acquired) {
            try {
              this.db.logEvent(
                "FOLLOWUP",
                `【二次评估通过 (${score}分)·第${nextCount}次追发】向【${item.companyName} - ${item.hrName}】发送破冰消息: "${replyText}"`,
                "SUCCESS"
              );
              const sendRes = await this.guard.executeChatAction(actionIntent.actionId);
              if (sendRes.success) {
                followedUpCount++;
              }
            } finally {
              this.db.releaseLease("EGO_BROWSER", workerId);
            }
          }
        } else {
          this.db.logEvent(
            "FOLLOWUP",
            `【二次评估通过 (${score}分)】已为【${item.companyName} - ${item.hrName}】生成追发草稿待人工审批: "${replyText}"`,
            "INFO"
          );
          followedUpCount++;
        }
      } catch (err) {
        this.db.logEvent("FOLLOWUP", `对【${item.companyName} - ${item.hrName}】二次评估或追发异常: ${err.message}`, "WARN");
      }
    }

    this.db.logEvent(
      "FOLLOWUP",
      `本轮已读未回/送达扫描完成：共扫描 ${silentItems.length} 个沉寂会话，成功追发 ${followedUpCount} 个，满${maxCount}次标记无结果 ${markedNoResponseCount} 个，业务不符跳过 ${skippedNotWorthCount} 个`,
      "SUCCESS"
    );

    return {
      scanned: silentItems.length,
      followedUp: followedUpCount,
      markedNoResponse: markedNoResponseCount,
      skippedNotWorth: skippedNotWorthCount
    };
  }
}
