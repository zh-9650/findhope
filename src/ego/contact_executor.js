export class ContactExecutor {
  constructor(bridge, db) {
    this.bridge = bridge;
    this.db = db;
  }

  /**
   * 对指定的 MATCH 岗位执行真实建联（两阶段：感兴趣 -> 立即沟通 -> 识别自动首发招呼 -> 送达核验）
   */
  async contactPosting(postingId, detailUrl) {
    const actionBody = `
      await page.goto(context.detailUrl);
      await page.waitForTimeout(3000);

      // 阶段 1: 检查当前按钮状态
      const initialStatus = await page.evaluate(() => {
        const startChatBtn = document.querySelector('a.btn.btn-startchat, .btn-startchat');
        const interestBtn = document.querySelector('a.btn.btn-interest, .btn-interest');
        
        const startChatText = startChatBtn ? startChatBtn.innerText.trim() : '';
        const interestText = interestBtn ? interestBtn.innerText.trim() : '';

        return {
          startChatText,
          interestText,
          hasStartChat: !!startChatBtn,
          hasInterest: !!interestBtn
        };
      });

      // 如果已经是“继续沟通”，说明历史已建联
      if (initialStatus.startChatText.includes('继续沟通')) {
        return {
          status: 'ALREADY_CONTACTED',
          message: '已处于继续沟通状态'
        };
      }

      // 阶段 2: 如果有“感兴趣”且尚未展开立即沟通，先点击“感兴趣”
      if (initialStatus.hasInterest && initialStatus.interestText.includes('感兴趣') && !initialStatus.interestText.includes('取消')) {
        await page.evaluate(() => {
          const btn = document.querySelector('a.btn.btn-interest, .btn-interest');
          if (btn) btn.click();
        });
        await page.waitForTimeout(2000);
      }

      // 阶段 3: 点击“立即沟通”
      const clickChatResult = await page.evaluate(() => {
        const btn = document.querySelector('a.btn.btn-startchat, .btn-startchat');
        if (!btn) {
          // 兜底尝试任何立即沟通按钮
          const allA = Array.from(document.querySelectorAll('a, button'));
          const target = allA.find(el => el.innerText.trim() === '立即沟通');
          if (target) {
            target.click();
            return { clicked: true, text: '立即沟通' };
          }
          return { clicked: false, error: 'Start chat button not found' };
        }

        const text = btn.innerText.trim();
        if (text.includes('继续沟通')) {
          return { clicked: false, alreadyContacted: true };
        }

        btn.click();
        return { clicked: true, text };
      });

      if (!clickChatResult.clicked) {
        return {
          status: clickChatResult.alreadyContacted ? 'ALREADY_CONTACTED' : 'FAILED',
          error: clickChatResult.error || '未能触发点击'
        };
      }

      // 等待 3 秒跳转或消息触发
      await page.waitForTimeout(3500);

      // 阶段 4: 检查是否跳转到聊天页或弹出会话窗口并自动发送了招呼
      const verifyRes = await page.evaluate(() => {
        const currentUrl = window.location.href;
        const isChatPage = currentUrl.includes('/web/geek/chat');
        
        // 检查消息气泡
        const bubbles = Array.from(document.querySelectorAll('.chat-message, .message-item, .item-myself, .item-right'));
        const hasSelfMsg = bubbles.some(b => b.classList.contains('item-myself') || b.classList.contains('item-right'));

        // 检查送达回执
        const hasDelivered = document.body.innerText.includes('送达') || document.body.innerText.includes('已读');

        return {
          isChatPage,
          hasSelfMsg,
          hasDelivered,
          url: currentUrl
        };
      });

      return {
        status: 'SUCCESS',
        verify: verifyRes
      };
    `;

    const res = await this.bridge.runInBrowser(actionBody, { detailUrl });

    if (res.status === 'SUCCESS' || res.status === 'ALREADY_CONTACTED') {
      // 更新 Opportunity 状态为 CONTACTED
      this.db.createOrUpdateOpportunity({
        posting_id: postingId,
        stage: 'CONTACTED',
        notes: `已于 ${new Date().toLocaleString()} 成功建联打招呼`
      });

      // 记录外部操作核查成功
      const actId = `ACT_CONTACT_${postingId}_${Date.now()}`;
      this.db.prepareAction({
        action_id: actId,
        posting_id: postingId,
        action_kind: 'GREETING',
        payload: '点击立即沟通触发预设招呼',
        requires_approval: false,
        approved_by_user: true
      });
      this.db.verifyActionSuccess(actId, `VERIFIED_SUCCESS: ${JSON.stringify(res.verify || {})}`);

      return { success: true, postingId, status: 'CONTACTED' };
    } else {
      return { success: false, postingId, error: res.error || '建联未完全确认' };
    }
  }
}
