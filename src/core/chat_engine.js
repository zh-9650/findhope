import { config } from '../config/index.js';

export class ChatEngine {
  constructor(claudeRunner, actionGuard, db) {
    this.runner = claudeRunner;
    this.guard = actionGuard;
    this.db = db;
  }

  /**
   * 针对当前会话，提取结构化历史记忆 + 最近气泡 + 关联职位与机会状态
   */
  buildConversationContext(conversationId) {
    const conv = this.db.db.prepare(`SELECT * FROM conversations WHERE conversation_id = ?`).get(conversationId);
    if (!conv) return null;

    const recentMsgs = this.db.getRecentMessages(conversationId, 15);
    let memoryLedger = {};
    try {
      memoryLedger = JSON.parse(conv.memory_ledger || '{}');
    } catch (e) {
      memoryLedger = {};
    }

    let posting = null;
    let opportunity = null;
    if (conv.posting_id) {
      posting = this.db.getPostingWithLatestSnapshot(conv.posting_id);
      opportunity = this.db.db.prepare(`SELECT * FROM opportunities WHERE posting_id = ? LIMIT 1`).get(conv.posting_id);
    }

    return {
      conversation: conv,
      posting,
      opportunity,
      memoryLedger,
      recentMessages: recentMsgs
    };
  }

  /**
   * 归集未读 HR 消息并调用 Claude CLI 起草回复与动作决策
   */
  async processIncomingMessages(conversationId) {
    const ctx = this.buildConversationContext(conversationId);
    if (!ctx) throw new Error(`Conversation ${conversationId} not found`);

    // 1. 豁免检查：若该会话已处于人工接管 (HUMAN_HANDOFF) 或已关闭 (CLOSED)，绝不自动打扰
    const existingFeedback = this.db.getRejectionFeedback(conversationId);
    if (existingFeedback && existingFeedback.status === 'COLLECTED') {
      return {
        conversationId,
        skipped: true,
        reason: '已完成被拒原因收集与礼貌致谢，不再继续回复'
      };
    }

    if (ctx.opportunity && (ctx.opportunity.stage === 'HUMAN_HANDOFF' || (ctx.opportunity.stage === 'CLOSED' && (!existingFeedback || existingFeedback.status !== 'ASKING_REASON')))) {
      return {
        conversationId,
        skipped: true,
        reason: `会话处于 ${ctx.opportunity.stage} 状态，跳过自动回复`
      };
    }

    // 2. 实质发言人检查：检查最后一条非 SYSTEM 的实质消息是否来自 HR
    const substantiveMsgs = ctx.recentMessages.filter(m => m.sender_type === 'HR' || m.sender_type === 'CANDIDATE');
    if (substantiveMsgs.length === 0) {
      return {
        conversationId,
        skipped: true,
        reason: '无实质性对话消息，跳过回复'
      };
    }

    const lastSubstantive = substantiveMsgs[substantiveMsgs.length - 1];
    if (lastSubstantive.sender_type === 'CANDIDATE') {
      return {
        conversationId,
        skipped: true,
        reason: '最后一条实质消息已是我方回复（最新变动仅为系统回执），无需重复回复'
      };
    }

    // 若该会话此前处于“已读未回/送达追发等待 (WAITING_HR)”状态，HR 现已回复，标记为二次唤醒成功 (HR_REPLIED)
    if (ctx.conversation.followup_status === 'WAITING_HR' || (ctx.conversation.followup_count && ctx.conversation.followup_count > 0)) {
      this.db.updateConversationFollowup(conversationId, {
        followup_status: 'HR_REPLIED'
      });
    }

    // 2.5 【被拒原因收集阶段二】：若此前我方已追问过被拒原因 (status === 'ASKING_REASON')，且 HR 最新回复了原因
    if (existingFeedback && existingFeedback.status === 'ASKING_REASON') {
      const hrReplyText = lastSubstantive.content.trim();
      let category = 'HR已回复具体原因';
      if (/(AI|大模型|智能体|方向|岗位)/i.test(hrReplyText)) category = '求职方向/招呼语不符(偏AI测试)';
      else if (/(年|经验|资深|高工)/.test(hrReplyText)) category = '工作年限要求差距';
      else if (/(学历|统招|专升本|一本|211|985|学信网)/.test(hrReplyText)) category = '学历门槛限制';
      else if (/(金融|证券|银行|硬件|嵌入式|安全|游戏|车载|行业|业务)/.test(hrReplyText)) category = '行业/业务背景不符';
      else if (/(招满|暂停|HC|周期|急)/.test(hrReplyText)) category = 'HC变动或项目周期原因';

      this.db.upsertRejectionFeedback({
        conversation_id: conversationId,
        hr_reason_reply: hrReplyText,
        inferred_category: category,
        status: 'COLLECTED'
      });

      if (ctx.conversation.posting_id) {
        this.db.createOrUpdateOpportunity({
          posting_id: ctx.conversation.posting_id,
          conversation_id: conversationId,
          stage: 'CLOSED',
          notes: `已收集HR被拒原因反馈: [${category}] ${hrReplyText}`
        });
      }

      const thankReply = '明白了，感谢您的真实反馈，祝招聘顺利~';
      const decision = {
        hr_intent: 'REJECTION_REASON',
        action_request: 'SEND_REPLY',
        draft_reply: thankReply,
        decision_rationale: `HR 已回复被拒原因（${hrReplyText}），已自动归档至被拒原因库并礼貌致谢收尾`
      };

      const actionIntent = this.guard.registerIntent({
        conversation_id: conversationId,
        posting_id: ctx.conversation.posting_id,
        action_kind: 'SEND_REPLY',
        payload: thankReply
      });

      this.db.logEvent("CHAT_ENGINE", `【被拒原因已收集】${ctx.conversation.company_name} - ${ctx.conversation.hr_name} 反馈原因: "${hrReplyText}" (分类: ${category})`, "SUCCESS");

      return {
        conversationId,
        skipped: false,
        decision,
        actionIntent
      };
    }

    // 2.6 【被拒原因收集阶段一】：检测 HR 最新消息是否为初次拒绝/不合适表态（排除工作地点确认卡片的“暂不考虑可以接受”按钮文字）
    const rejectRegex = /(不太合适|不合适|不推进|不同经验背景|更适合当前项目周期|匹配度还有一定差距|不太匹配|不匹配)/;
    const isLocationCard = lastSubstantive.content.includes('您是否接受此工作地点') || lastSubstantive.content.includes('暂不考虑可以接受');
    if (!existingFeedback && !isLocationCard && rejectRegex.test(lastSubstantive.content)) {
      const askReasonReply = '好的理解，冒昧问下主要是年限、学历还是技术方向不太匹配呢？想做个参考，谢谢~';
      let initialCategory = '待HR回复原因';
      if (lastSubstantive.content.includes('项目周期')) initialCategory = '项目周期/到岗匹配度(待HR细化)';
      else if (lastSubstantive.content.includes('经验背景') || lastSubstantive.content.includes('工作经历')) initialCategory = '经验/行业背景差距(待HR细化)';

      this.db.upsertRejectionFeedback({
        conversation_id: conversationId,
        posting_id: ctx.conversation.posting_id,
        company_name: ctx.conversation.company_name || '未知公司',
        hr_name: ctx.conversation.hr_name || 'HR',
        job_title: ctx.posting ? ctx.posting.job_title : '测试工程师',
        hr_reject_message: lastSubstantive.content,
        followup_question: askReasonReply,
        inferred_category: initialCategory,
        status: 'ASKING_REASON'
      });

      if (ctx.conversation.posting_id) {
        this.db.createOrUpdateOpportunity({
          posting_id: ctx.conversation.posting_id,
          conversation_id: conversationId,
          stage: 'REJECT_FOLLOWUP',
          notes: `HR表示不合适("${lastSubstantive.content}")，已礼貌追问具体原因`
        });
      }

      const decision = {
        hr_intent: 'REJECTION',
        action_request: 'SEND_REPLY',
        draft_reply: askReasonReply,
        decision_rationale: `检测到 HR 拒绝表态（${lastSubstantive.content}），触发被拒原因收集流程，礼貌追问具体原因`
      };

      const actionIntent = this.guard.registerIntent({
        conversation_id: conversationId,
        posting_id: ctx.conversation.posting_id,
        action_kind: 'SEND_REPLY',
        payload: askReasonReply
      });

      this.db.logEvent("CHAT_ENGINE", `【捕获HR拒绝并追问原因】${ctx.conversation.company_name} - ${ctx.conversation.hr_name}: "${lastSubstantive.content}" -> 已发送原因追问`, "WARN");

      return {
        conversationId,
        skipped: false,
        decision,
        actionIntent
      };
    }

    // 3. 聊天岗位反向硬规则过滤（黑名单拦截：如 HR 在消息或职位中明确提到“外包/派遣/驻场”）
    const hrRecentText = substantiveMsgs.filter(m => m.sender_type === 'HR').slice(-3).map(m => m.content).join(' ');
    const jobTitleText = ctx.posting ? (ctx.posting.job_title || '') : '';
    const companyText = ctx.conversation.company_name || '';
    const combinedCheckText = `${jobTitleText} ${companyText} ${hrRecentText}`
      .replace(/(非|不|不是|拒绝|无)(外包|派遣|驻场|外派)/g, '');

    if (config.candidateProfile.blacklistKeywords && config.candidateProfile.blacklistKeywords.length > 0) {
      const hitKw = config.candidateProfile.blacklistKeywords.find(kw => combinedCheckText.includes(kw));
      if (hitKw) {
        // 标记该岗位为 REJECT，机会关闭，并写入账本防止下次重复点开
        if (ctx.conversation.posting_id) {
          this.db.recordAssessment({
            posting_id: ctx.conversation.posting_id,
            config_version: 1,
            decision: 'REJECT',
            match_score: 0.1,
            matched_skills: [],
            missing_skills: [],
            reason: `聊天反向风控拦截：命中黑名单关键词 "${hitKw}"`,
            filter_stage: 'HARD_RULE'
          });
          this.db.createOrUpdateOpportunity({
            posting_id: ctx.conversation.posting_id,
            conversation_id: conversationId,
            stage: 'CLOSED',
            notes: `命中黑名单词 "${hitKw}" 自动关闭，不予投递简历`
          });
        }

        const rejectedLedger = {
          ...ctx.memoryLedger,
          status: 'REJECTED_BY_RULE',
          rejectReason: `命中黑名单关键词: ${hitKw}`,
          lastInteractionAt: new Date().toISOString()
        };
        this.db.upsertConversation({
          conversation_id: conversationId,
          memory_ledger: rejectedLedger
        });

        return {
          conversationId,
          skipped: true,
          rejectedByHardRule: true,
          reason: `命中黑名单规则 ("${hitKw}")，已自动拦截并归档，不发送简历`
        };
      }
    }

    // 4. 组装精准区分【我方】、【HR】、【系统回执】的对话历史
    const historyFormatted = ctx.recentMessages
      .map(m => {
        if (m.sender_type === 'CANDIDATE') return `【我方】: ${m.content}`;
        if (m.sender_type === 'SYSTEM') return `【系统回执】: ${m.content}`;
        return `【HR】: ${m.content}`;
      })
      .join('\n');

    const jobActualSalary = ctx.posting ? (ctx.posting.plain_salary || ctx.posting.list_salary_raw || '未标明') : '未标明';
    const resumeStatusDesc = ctx.conversation.send_resume_status === 'COMPLETED'
      ? 'COMPLETED (已发送过附件简历，严禁再次请求 SEND_RESUME，仅需输出 SEND_REPLY)'
      : ctx.conversation.send_resume_status;

    const hasCandidateSpoken = ctx.recentMessages.some(m => m.sender_type === 'CANDIDATE');

    const prompt = `请作为求职者（${config.candidateProfile.name}）本人，阅读与 HR 的聊天记录，用真人手机打字的极简口吻起草回复：
【候选人真实底牌（问到哪项答哪项，没问的绝不主动罗列）】：
- 基本情况：${config.candidateProfile.name}，${config.candidateProfile.education || '全日制专升本'}，${config.candidateProfile.yearsOfExperience}年测试经验
- 在职与到岗：目前在职看机会，交接很快，1周左右能到岗
- 薪资情况：目前4.5k，期望最低${config.candidateProfile.salaryExpectationMin}k（${config.candidateProfile.salaryExpectationMin}-${config.candidateProfile.salaryExpectationMax}k区间）
- 换工作原因：现在这边薪资偏低（4.5k）且涨薪受限，想换个待遇和发展空间更匹配的团队
- 面试形式：线上线下都可以，时间听HR安排
- 技术栈底牌：Python + Playwright/Selenium + Pytest（Web/UI/接口自动化）、JMeter性能压测、Linux/MySQL/Docker微服务测试、AI大模型/Agent/RAG评测

【真人聊天风格铁律（严禁 AI 腔，必须严格遵守）】：
1. 极简短句（严格控制在 10~45 字以内）：
   - 像真人在手机上随手回消息一样干脆、自然，信息点明确，一句话说完，绝不写小作文！
2. 严禁每句加“您好”与 AI 客套废话：
   - 当前对话我方是否已发过言：${hasCandidateSpoken ? '【已发过言，本条回复严禁以“您好”开头！】' : '【首次发言，可简短带一句“您好”或直接进主题】'}
   - 绝对禁用词：“感谢您的关注”、“非常感兴趣”、“高度契合”、“若有机会进一步沟通”、“期待您的回复”、“期待与您进一步沟通”、“请查收”、“贵司”。
3. 问什么答什么，没问的别硬背简历：
   - 场景 A（HR 索要简历 / 问发份简历看看）：直接回“发您了，您看下”或“好的，简历发您了”（配合 SEND_RESUME）。
   - 场景 B（HR 群发岗位介绍问考不考虑）：直接回“考虑的，我平时主要做Python自动化和接口/性能测试，简历发您看下”（35字内，配合 SEND_RESUME）。
   - 场景 C（HR 连问多个具体问题，如在职状态、到岗时间、薪资、学历等）：按顺序直接给干货结论，用逗号隔开，例如：“目前在职，一周左右能到岗，全日制专升本，期望薪资8-10k（最低8k）”。
4. 发简历与换微信动作触发规则：
   - 若 HR 询问是否有兴趣/索要简历，且发送附件简历按钮状态为 AVAILABLE -> action_request 输出 "SEND_RESUME"；若状态已为 COMPLETED -> 输出 "SEND_REPLY"；
   - 若 HR 索要微信或提出加微信详聊，且交换微信按钮状态为 AVAILABLE -> action_request 必须输出 "EXCHANGE_WECHAT"，回复仅需简短一句“好的，微信发您了”。

【当前沟通岗位与公司】：
- 公司/职位：${ctx.conversation.company_name || ''} - ${ctx.posting ? ctx.posting.job_title : '测试工程师'}
- 该岗位标注薪资：${jobActualSalary}

【工具当前可用状态】：
- 发送附件简历按钮：${resumeStatusDesc}
- 交换微信按钮：${ctx.conversation.exchange_wechat_status}
- 交换电话按钮：${ctx.conversation.exchange_phone_status}

【结构化记忆账本（我方已承诺事项）】：
${JSON.stringify(ctx.memoryLedger, null, 2)}

【近期上下文记录】：
${historyFormatted}

请理解 HR 意图并仅输出以下合法 JSON（不得输出任何其他文字）：
{
  "hr_intent": "INQUIRY" | "REQUEST_RESUME" | "REQUEST_WECHAT" | "INTERVIEW_INVITE" | "CHITCHAT",
  "action_request": "NONE" | "SEND_REPLY" | "SEND_RESUME" | "EXCHANGE_WECHAT" | "CONFIRM_INTERVIEW",
  "draft_reply": "10~45字以内的真人极简中文回复（严禁AI套话、已发言严禁加您好、直给明确信息）",
  "decision_rationale": "决策原因解释",
  "updated_commitments": {
    "key": "此次回复中做出的最新承诺或事实确认"
  }
}`;

    let decision = null;
    try {
      decision = await this.runner.invokeReasoning(prompt, "CHAT_DECISION", 35000);
    } catch (err) {
      this.db.logEvent("CHAT_ENGINE", `模型网关响应超时或繁忙，启用本地高可靠规则智脑生成极简回复: ${err.message.split('\n')[0]}`, "WARN");
      decision = this.buildFallbackDecision(ctx, lastSubstantive.content);
    }

    // 防重保险：若已发过简历，强制将 SEND_RESUME 降级为 SEND_REPLY
    if (ctx.conversation.send_resume_status === 'COMPLETED' && decision.action_request === 'SEND_RESUME') {
      decision.action_request = 'SEND_REPLY';
    }

    // 登记动作意图到 ActionGuard（若 action_request 为 NONE 则不登记可执行发送意图）
    let actionIntent = null;
    if (decision.action_request && decision.action_request !== 'NONE') {
      actionIntent = this.guard.registerIntent({
        conversation_id: conversationId,
        posting_id: ctx.conversation.posting_id,
        action_kind: decision.action_request,
        payload: decision.draft_reply
      });
    }

    // 增量更新会话结构化记忆账本
    if (decision.updated_commitments) {
      const updatedLedger = {
        ...ctx.memoryLedger,
        commitments: {
          ...(ctx.memoryLedger.commitments || {}),
          ...decision.updated_commitments
        },
        lastInteractionAt: new Date().toISOString()
      };

      this.db.upsertConversation({
        conversation_id: conversationId,
        memory_ledger: updatedLedger
      });
    }

    // 若动作涉及交换微信，根据策略立即将会话转入人工接管状态 (HUMAN_HANDOFF)
    if (decision.action_request === 'EXCHANGE_WECHAT' && ctx.conversation.posting_id) {
      const oppId = `OPP_${ctx.conversation.posting_id}`;
      this.db.createOrUpdateOpportunity({
        opportunity_id: oppId,
        posting_id: ctx.conversation.posting_id,
        conversation_id: conversationId,
        stage: 'HUMAN_HANDOFF',
        notes: '已发起交换微信，按预设策略转入待候选人人工处理接管'
      });
      this.db.logEvent("CHAT_ENGINE", `会话 [${conversationId}] 已触发交换微信，状态变更为 HUMAN_HANDOFF，交由用户亲自处理`, "SUCCESS");
    }

    return {
      conversationId,
       skipped: false,
      decision,
      actionIntent
    };
  }

  /**
   * 当局域网模型网关拥塞超时时的本地确定性极简回复兜底器
   */
  buildFallbackDecision(ctx, hrText) {
    const text = (hrText || '').trim();
    const canSendResume = ctx.conversation.send_resume_status !== 'COMPLETED';
    const canExchangeWechat = ctx.conversation.exchange_wechat_status === 'AVAILABLE';

    if (/(微信|加个v|加v|vx)/i.test(text) && canExchangeWechat) {
      return {
        hr_intent: 'REQUEST_WECHAT',
        action_request: 'EXCHANGE_WECHAT',
        draft_reply: '好的，微信发您了',
        decision_rationale: 'HR 请求交换微信，触发 EXCHANGE_WECHAT 并转人工接管',
        updated_commitments: { wechat_exchanged: true }
      };
    }

    if (/(简历|看新机会|考虑|聊一聊|聊聊|深聊)/.test(text) && canSendResume) {
      return {
        hr_intent: 'REQUEST_RESUME',
        action_request: 'SEND_RESUME',
        draft_reply: '考虑的，简历发您了，您看下',
        decision_rationale: 'HR 邀约沟通或索要简历，极简回复并投递附件简历',
        updated_commitments: { resume_sent: true }
      };
    }

    const parts = [];
    if (/(在职|离职|状态|到岗|入职)/.test(text)) parts.push('目前在职，交接快一周左右能到岗');
    if (/(学历|统招|本科|专升本)/.test(text)) parts.push('全日制专升本');
    if (/(薪资|待遇|期望|目前多少)/.test(text)) parts.push('目前4.5k，期望8-10k（最低8k）');
    if (/(原因|为什么看|换工作)/.test(text)) parts.push('现在这边薪资偏低且涨薪受限，想换个发展空间更匹配的团队');

    if (parts.length > 0) {
      return {
        hr_intent: 'INQUIRY',
        action_request: canSendResume && text.includes('简历') ? 'SEND_RESUME' : 'SEND_REPLY',
        draft_reply: parts.join('，'),
        decision_rationale: '按候选人真实画像直给干货回答',
        updated_commitments: {}
      };
    }

    return {
      hr_intent: 'INQUIRY',
      action_request: canSendResume ? 'SEND_RESUME' : 'SEND_REPLY',
      draft_reply: canSendResume
        ? '考虑的，我平时主要做Python自动化和接口/性能测试，简历发您看下'
        : '目前在职，一周左右能到岗，有需要随时沟通~',
      decision_rationale: '通用极简真人回复兜底',
      updated_commitments: {}
    };
  }
}
