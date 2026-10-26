export class ChatSync {
  constructor(bridge, db) {
    this.bridge = bridge;
    this.db = db;
  }

  /**
   * 构造无冲突的唯一会话 ID：CONV_公司名_HR姓名
   */
  static buildConversationId(companyName, hrName) {
    const comp = (companyName || '未知企业').trim();
    const hr = (hrName || '未知HR').trim();
    return `CONV_${encodeURIComponent(comp)}_${encodeURIComponent(hr)}`;
  }

  /**
   * 同步会话列表与未读/待回复状态（只读前 15 个会话）
   */
  async syncConversationList() {
    const actionBody = `
      const targetUrl = 'https://www.zhipin.com/web/geek/chat';
      const currentUrl = await page.url();
      if (!currentUrl.includes('/web/geek/chat')) {
        await page.goto(targetUrl);
        await page.waitForTimeout(3000);
      }

      const conversations = await page.evaluate(() => {
        const items = Array.from(document.querySelectorAll("li[role='listitem']"));
        return items.slice(0, 15).map((item, idx) => {
          const nameBox = item.querySelector('.name-box');
          const spans = nameBox ? Array.from(nameBox.querySelectorAll('span')).map(s => s.innerText.trim()).filter(Boolean) : [];
          const nameTextEl = item.querySelector('.name-text');

          const hrName = nameTextEl ? nameTextEl.innerText.trim() : (spans[0] || '');
          const companyName = spans.length > 1 ? spans[1] : '';
          const hrTitle = spans.length > 2 ? spans[2] : '';

          const lastMsgEl = item.querySelector('.last-msg, .msg-text');
          const timeEl = item.querySelector('.time');
          const badgeEl = item.querySelector('.notice-badge, .badge');

          const lastMsg = lastMsgEl ? lastMsgEl.innerText.trim() : '';
          const time = timeEl ? timeEl.innerText.trim() : '';
          const unreadCount = badgeEl ? parseInt(badgeEl.innerText.trim() || '0', 10) : 0;

          return {
            index: idx,
            hrName,
            companyName,
            hrTitle,
            lastMsg,
            time,
            unreadCount
          };
        });
      });

      return conversations;
    `;

    const list = await this.bridge.runInBrowser(actionBody);
    const enrichedList = [];

    for (const item of list) {
      if (!item.hrName) continue;

      const convId = ChatSync.buildConversationId(item.companyName, item.hrName);
      const existingConv = this.db.db.prepare(`SELECT * FROM conversations WHERE conversation_id = ?`).get(convId);

      this.db.upsertConversation({
        conversation_id: convId,
        hr_name: item.hrName,
        company_name: item.companyName || null,
        last_message_text: item.lastMsg,
        unread_count: item.unreadCount
      });

      // 判断该会话是否处于 HUMAN_HANDOFF 或已关闭状态
      let isHandedOff = false;
      if (existingConv && existingConv.posting_id) {
        const opp = this.db.db.prepare(`SELECT stage FROM opportunities WHERE posting_id = ?`).get(existingConv.posting_id);
        if (opp && (opp.stage === 'HUMAN_HANDOFF' || opp.stage === 'CLOSED' || opp.stage === 'DORMANT')) {
          isHandedOff = true;
        }
      }
      if (existingConv && existingConv.memory_ledger && existingConv.memory_ledger.includes('REJECTED_BY_RULE')) {
        isHandedOff = true;
      }

      // 判断是否需要点开核查并回复：
      // 1. 有未读红点 (unreadCount > 0)
      // 2. 或者虽无红点（例如此前点开过但未回复），但时间是今天(HH:MM)/昨天，且摘要不是我方发出的([送达]/[已读])，也不是纯系统通知
      const isRecentTime = item.time.includes(':') || item.time.includes('昨天');
      const isMyLastMsg = item.lastMsg.startsWith('[送达]') || item.lastMsg.startsWith('[已读]');
      const isSystemNotice = item.lastMsg.includes('对方已同意') ||
                             item.lastMsg.startsWith('附件简历') ||
                             item.lastMsg.includes('资料已收到');

      // 检查数据库里该会话最后一条实质消息是否已经是我方回复
      const lastDbMsg = this.db.db.prepare(`
        SELECT sender_type, content FROM messages
        WHERE conversation_id = ? AND sender_type IN ('HR', 'CANDIDATE')
        ORDER BY message_id DESC LIMIT 1
      `).get(convId);
      const alreadyRepliedInDb = lastDbMsg && lastDbMsg.sender_type === 'CANDIDATE';

      const needsAttention = !isHandedOff && (
        item.unreadCount > 0 ||
        (isRecentTime && !isMyLastMsg && !isSystemNotice && !alreadyRepliedInDb)
      );

      enrichedList.push({
        ...item,
        convId,
        isHandedOff,
        needsAttention
      });
    }

    return enrichedList;
  }

  /**
   * 扫描处于“[已读]未回”或“[送达]未读”状态的沉寂会话列表（供定时二次评估与追发引擎使用）
   */
  async scanSilentConversations(maxItems = 25) {
    const actionBody = `
      const targetUrl = 'https://www.zhipin.com/web/geek/chat';
      const currentUrl = await page.url();
      if (!currentUrl.includes('/web/geek/chat')) {
        await page.goto(targetUrl);
        await page.waitForTimeout(3000);
      }

      const conversations = await page.evaluate((limit) => {
        const items = Array.from(document.querySelectorAll("li[role='listitem']"));
        return items.slice(0, limit).map((item, idx) => {
          const nameBox = item.querySelector('.name-box');
          const spans = nameBox ? Array.from(nameBox.querySelectorAll('span')).map(s => s.innerText.trim()).filter(Boolean) : [];
          const nameTextEl = item.querySelector('.name-text');

          const hrName = nameTextEl ? nameTextEl.innerText.trim() : (spans[0] || '');
          const companyName = spans.length > 1 ? spans[1] : '';
          const hrTitle = spans.length > 2 ? spans[2] : '';

          const lastMsgEl = item.querySelector('.last-msg, .msg-text');
          const timeEl = item.querySelector('.time');
          const badgeEl = item.querySelector('.notice-badge, .badge');

          const lastMsg = lastMsgEl ? lastMsgEl.innerText.trim() : '';
          const time = timeEl ? timeEl.innerText.trim() : '';
          const unreadCount = badgeEl ? parseInt(badgeEl.innerText.trim() || '0', 10) : 0;

          return {
            index: idx,
            hrName,
            companyName,
            hrTitle,
            lastMsg,
            time,
            unreadCount
          };
        });
      }, context.maxItems);

      return conversations;
    `;

    const list = await this.bridge.runInBrowser(actionBody, { maxItems });
    const silentItems = [];

    const closingPhrases = ['不打扰了', '不多打扰', '祝招聘顺利', '再看看其他机会', '冒昧问下主要是年限', '感谢您的真实反馈'];

    for (const item of list) {
      if (!item.hrName) continue;
      if (item.unreadCount > 0) continue;

      const isReadNoReply = item.lastMsg.startsWith('[已读]');
      const isDeliveredNoReply = item.lastMsg.startsWith('[送达]');
      if (!isReadNoReply && !isDeliveredNoReply) continue;

      // 若最后一句是我方被拒后的礼貌收尾或被拒追问，则不属于待破冰跟进对象
      if (closingPhrases.some(p => item.lastMsg.includes(p))) continue;

      const convId = ChatSync.buildConversationId(item.companyName, item.hrName);
      this.db.upsertConversation({
        conversation_id: convId,
        hr_name: item.hrName,
        company_name: item.companyName || null,
        last_message_text: item.lastMsg,
        unread_count: 0
      });

      const dbConv = this.db.db.prepare(`SELECT * FROM conversations WHERE conversation_id = ?`).get(convId);
      const rejectRecord = this.db.getRejectionFeedback(convId);
      if (rejectRecord) {
        this.db.updateConversationFollowup(convId, { followup_status: 'REJECTED_EXCLUDED' });
        continue;
      }

      if (dbConv && dbConv.memory_ledger && dbConv.memory_ledger.includes('REJECTED_BY_RULE')) continue;

      let oppStage = null;
      if (dbConv && dbConv.posting_id) {
        const opp = this.db.db.prepare(`SELECT stage FROM opportunities WHERE posting_id = ?`).get(dbConv.posting_id);
        oppStage = opp ? opp.stage : null;
      }
      if (oppStage && ['HUMAN_HANDOFF', 'CLOSED', 'REJECT_FOLLOWUP', 'NO_RESPONSE'].includes(oppStage)) {
        continue;
      }

      silentItems.push({
        ...item,
        convId,
        deliveryTag: isReadNoReply ? '已读未回' : '送达未读',
        dbConv
      });
    }

    return silentItems;
  }

  /**
   * 读取当前已打开会话的消息记录、顶栏职位信息及工具解锁状态
   */
  async inspectCurrentChat(conversationId, fallbackInfo = {}) {
    const actionBody = `
      // 1. 提取单条消息节点 (.message-item)，严禁提取外层容器 .chat-message，并过滤推广卡片
      const messages = await page.evaluate(() => {
        const messageItems = Array.from(document.querySelectorAll('li.message-item, .message-item'));
        return messageItems.map(item => {
          const fullText = item.innerText ? item.innerText.trim() : '';
          // 过滤 BOSS 竞争力分析推广卡片
          if (fullText.includes('你与该职位竞争者PK情况') || fullText.includes('查看详细分析')) {
            return null;
          }

          const isMyself = item.classList.contains('item-myself') || item.classList.contains('item-right');
          const isSystem = item.classList.contains('item-system') || !!item.querySelector('.system-msg');
          const readStatusEl = item.querySelector('.read-status');
          const textEl = item.querySelector('.text, .msg-text');

          let content = textEl ? textEl.innerText.trim() : fullText;
          // 剥离我方消息气泡前缀的时间和已读/送达字样
          if (isMyself && textEl) {
            content = textEl.innerText.trim();
          }

          let senderType = 'HR';
          if (isMyself) senderType = 'CANDIDATE';
          else if (isSystem) senderType = 'SYSTEM';

          return {
            senderType,
            isMyself,
            isSystem,
            content,
            msgType: isSystem ? 'SYSTEM_EVENT' : 'TEXT',
            deliveryStatus: readStatusEl ? readStatusEl.innerText.trim() : 'SENT'
          };
        }).filter(m => m && m.content.length > 0);
      });

      // 2. 提取工具栏状态 (发简历、换微信、换电话)
      const capabilities = await page.evaluate(() => {
        const btns = Array.from(document.querySelectorAll('.toolbar-btn'));
        const resumeBtn = btns.find(b => b.innerText && b.innerText.includes('发简历'));
        const wechatBtn = btns.find(b => b.innerText && b.innerText.includes('微信'));
        const phoneBtn = btns.find(b => b.innerText && b.innerText.includes('电话'));

        const isLocked = (el) => {
          if (!el) return 'UNKNOWN';
          const isUnable = el.classList.contains('unable') || !!el.closest('.unable');
          return isUnable ? 'LOCKED' : 'AVAILABLE';
        };

        return {
          sendResume: isLocked(resumeBtn),
          exchangeWechat: isLocked(wechatBtn),
          exchangePhone: isLocked(phoneBtn)
        };
      });

      // 3. 检查输入框当前状态
      const editorStatus = await page.evaluate(() => {
        const editor = document.querySelector('div.chat-im.chat-editor');
        return {
          hasEditor: !!editor,
          currentText: editor ? editor.innerText.trim() : ''
        };
      });

      // 4. 提取顶栏职位信息 (.position-content) 与 HR 详情 (.user-info .base-info)
      const jobInfo = await page.evaluate(() => {
        const posEl = document.querySelector('.position-content .position-name, .position-name');
        const salaryEl = document.querySelector('.position-content .salary, .salary');
        const cityEl = document.querySelector('.position-content .city, .city');

        const baseInfo = document.querySelector('.user-info .base-info');
        const hrNameEl = baseInfo ? baseInfo.querySelector('.name-text') : document.querySelector('.top-info .name');
        const titleEl = baseInfo ? baseInfo.querySelector('.base-title') : document.querySelector('.top-info .title');
        
        let companyName = '';
        if (baseInfo) {
          const directSpans = Array.from(baseInfo.querySelectorAll(':scope > span'));
          const compSpan = directSpans.find(s => !s.classList.contains('base-title'));
          if (compSpan) companyName = compSpan.innerText.trim();
        }

        return {
          jobTitle: posEl ? posEl.innerText.trim() : '',
          salary: salaryEl ? salaryEl.innerText.trim() : '',
          city: cityEl ? cityEl.innerText.trim() : '',
          hrName: hrNameEl ? hrNameEl.innerText.trim() : '',
          companyName,
          hrTitle: titleEl ? titleEl.innerText.trim() : ''
        };
      });

      return {
        messages,
        capabilities,
        editorStatus,
        jobInfo
      };
    `;

    const chatData = await this.bridge.runInBrowser(actionBody);

    const hrName = chatData.jobInfo?.hrName || fallbackInfo.hrName || '未知HR';
    const companyName = chatData.jobInfo?.companyName || fallbackInfo.companyName || '未知企业';
    const hrTitle = chatData.jobInfo?.hrTitle || fallbackInfo.hrTitle || '';

    // 检查聊天记录中是否已发送过附件简历（系统消息防重）
    const resumeAlreadySentInDom = chatData.messages.some(m =>
      m.senderType === 'SYSTEM' && (
        m.content.includes('附件简历请求已发送') ||
        m.content.includes('附件简历-') ||
        m.content.includes('您的附件简历已发送给对方')
      )
    );
    if (resumeAlreadySentInDom) {
      chatData.capabilities.sendResume = 'COMPLETED';
    }

    // 自动反查并登记关联岗位（跨渠道联合去重，状态设为 CHAT_ACTIVE 防止被抓去用空JD重新打分）
    let postingId = null;
    if (chatData.jobInfo && chatData.jobInfo.jobTitle) {
      const title = chatData.jobInfo.jobTitle;
      const salary = chatData.jobInfo.salary;
      const city = chatData.jobInfo.city || '成都';

      const candidatePostId = `CHAT_${encodeURIComponent(companyName)}_${encodeURIComponent(title)}`;
      const postRes = this.db.recordPosting({
        posting_id: candidatePostId,
        job_title: title,
        company_name: companyName,
        list_salary_raw: salary,
        city_name: city,
        detail_url: 'https://www.zhipin.com/web/geek/chat',
        recruiter_name: hrName,
        recruiter_title: hrTitle,
        source_query: 'CHAT_INCOMING',
        status: 'CHAT_ACTIVE'
      });
      postingId = postRes.postingId;

      // 修正：调用正确的 recordSnapshot 方法，并锁定状态为 CHAT_ACTIVE
      this.db.recordSnapshot({
        posting_id: postingId,
        plain_salary: salary,
        jd_text: `【来自聊天会话绑定岗位】职位：${title} | 公司：${companyName} | 薪资：${salary} | 城市：${city}`,
        hr_active_tag: '在线',
        is_active_within_3days: 1,
        posting_status: 'CHAT_ACTIVE'
      });

      // 仅当机会未处于 HUMAN_HANDOFF 或 INTERVIEW_CONFIRMED 时更新为 CONVERSING
      const existingOpp = this.db.db.prepare(`SELECT stage FROM opportunities WHERE posting_id = ?`).get(postingId);
      if (!existingOpp || (existingOpp.stage !== 'HUMAN_HANDOFF' && existingOpp.stage !== 'INTERVIEW_CONFIRMED')) {
        this.db.createOrUpdateOpportunity({
          opportunity_id: `OPP_${postingId}`,
          posting_id: postingId,
          conversation_id: conversationId,
          stage: 'CONVERSING',
          notes: `来自 HR[${hrName}] 聊天沟通岗位: ${title} (${salary})`
        });
      }
    }

    // 增量同步消息进数据库
    let newMsgCount = 0;
    for (const msg of chatData.messages) {
      const res = this.db.recordMessage({
        conversation_id: conversationId,
        sender_type: msg.senderType,
        sender_name: msg.senderType === 'CANDIDATE' ? '张洪' : (msg.senderType === 'HR' ? hrName : 'SYSTEM'),
        content: msg.content,
        message_type: msg.msgType,
        delivery_status: msg.deliveryStatus
      });
      if (res.inserted) newMsgCount++;
    }

    // 判断最后一条实质性对话消息（非 SYSTEM）是谁发的
    const substantiveMsgs = chatData.messages.filter(m => m.senderType === 'HR' || m.senderType === 'CANDIDATE');
    const lastSubstantive = substantiveMsgs.length > 0 ? substantiveMsgs[substantiveMsgs.length - 1] : null;
    const isLastFromHr = lastSubstantive ? lastSubstantive.senderType === 'HR' : false;

    // 若数据库中此前已标记 send_resume_status 为 COMPLETED，保留 COMPLETED
    const prevConv = this.db.db.prepare(`SELECT send_resume_status FROM conversations WHERE conversation_id = ?`).get(conversationId);
    const finalResumeStatus = (prevConv && prevConv.send_resume_status === 'COMPLETED')
      ? 'COMPLETED'
      : chatData.capabilities.sendResume;

    this.db.upsertConversation({
      conversation_id: conversationId,
      posting_id: postingId,
      hr_name: hrName,
      company_name: companyName,
      send_resume_status: finalResumeStatus,
      exchange_wechat_status: chatData.capabilities.exchangeWechat,
      exchange_phone_status: chatData.capabilities.exchangePhone,
      unread_count: 0
    });

    return {
      conversationId,
      postingId,
      hrName,
      companyName,
      jobInfo: chatData.jobInfo,
      newMsgCount,
      totalMessagesInView: chatData.messages.length,
      isLastFromHr,
      lastSubstantiveMessage: lastSubstantive ? lastSubstantive.content : '',
      capabilities: {
        ...chatData.capabilities,
        sendResume: finalResumeStatus
      },
      editorStatus: chatData.editorStatus
    };
  }

  /**
   * 按 (companyName + hrName) 动态定位并点击左侧联系人卡片，校验右侧顶栏无误后提取详情
   * 彻底杜绝因列表动态重排导致的下标移位点错人问题！
   */
  async openAndInspectConversation(targetItem, conversationId = null) {
    const resolvedConvId = conversationId || targetItem.convId || ChatSync.buildConversationId(targetItem.companyName, targetItem.hrName);
    const actionBody = `
      const clicked = await page.evaluate((target) => {
        const items = Array.from(document.querySelectorAll("li[role='listitem']"));
        const matchedItem = items.find(item => {
          const text = item.innerText || '';
          const matchHr = target.hrName && text.includes(target.hrName);
          const matchComp = !target.companyName || text.includes(target.companyName);
          return matchHr && matchComp;
        });

        if (!matchedItem) return { found: false };

        const clickTarget = matchedItem.querySelector('.friend-content') || matchedItem.querySelector('.friend-content-warp') || matchedItem;
        clickTarget.scrollIntoView({ block: 'nearest' });
        clickTarget.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
        clickTarget.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
        clickTarget.click();
        return { found: true };
      }, context.targetItem);

      await page.waitForTimeout(2000);
      return clicked;
    `;

    const clickRes = await this.bridge.runInBrowser(actionBody, {
      targetItem: {
        hrName: targetItem.hrName,
        companyName: targetItem.companyName
      }
    });

    if (!clickRes || !clickRes.found) {
      throw new Error(`在左侧列表中未找到匹配的联系人卡片: ${targetItem.companyName} - ${targetItem.hrName}`);
    }

    return await this.inspectCurrentChat(resolvedConvId, targetItem);
  }
}
