import { config } from '../config/index.js';

export class ActionGuard {
  constructor(db, egoBridge) {
    this.db = db;
    this.bridge = egoBridge;
  }

  /**
   * 检查是否允许直接自动执行外部动作
   * 若全局配置为 DRAFT_ONLY，或该动作属于敏感操作，必须拦截为 PREPARED 待审批
   */
  shouldRequireApproval(actionKind) {
    if (config.executionMode === 'FULL_AUTO') return false;
    if (config.executionMode === 'DRAFT_ONLY') return true;

    const sensitiveKinds = ['EXCHANGE_WECHAT', 'EXCHANGE_PHONE', 'CONFIRM_INTERVIEW'];
    return sensitiveKinds.includes(actionKind);
  }

  /**
   * 申请并登记一个外部写操作
   */
  registerIntent(action) {
    const requiresApproval = this.shouldRequireApproval(action.action_kind);
    const actionId = action.action_id || `ACT_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;

    this.db.prepareAction({
      action_id: actionId,
      conversation_id: action.conversation_id,
      posting_id: action.posting_id,
      action_kind: action.action_kind,
      payload: typeof action.payload === 'object' ? JSON.stringify(action.payload) : action.payload,
      requires_approval: requiresApproval,
      approved_by_user: !requiresApproval
    });

    return {
      actionId,
      requiresApproval,
      status: 'PREPARED'
    };
  }

  /**
   * 统一受控执行聊天动作（支持 SEND_REPLY/REPLY_TEXT, SEND_RESUME, EXCHANGE_WECHAT）
   * 严格遵循四态状态机：PREPARED -> ATTEMPTED -> VERIFIED_SUCCESS / UNKNOWN
   * 包含：窗口核对、发送前二次核对 (Pre-Send Double Check)、弹窗确认与状态回写
   */
  async executeChatAction(actionId) {
    const action = this.db.db.prepare(`SELECT * FROM action_attempts WHERE action_id = ?`).get(actionId);
    if (!action) throw new Error(`Action ${actionId} not found`);

    if (action.requires_approval && !action.approved_by_user) {
      throw new Error(`Action ${actionId} requires manual user approval before execution.`);
    }

    const conv = action.conversation_id
      ? this.db.db.prepare(`SELECT * FROM conversations WHERE conversation_id = ?`).get(action.conversation_id)
      : null;

    const targetHr = conv ? conv.hr_name : '';
    const targetCompany = conv ? conv.company_name : '';
    const actionKind = action.action_kind;
    const messageText = action.payload || '';

    // 1. 进入 ATTEMPTED 状态
    this.db.markActionAttempted(actionId);

    try {
      const actionBody = `
        const targetUrl = 'https://www.zhipin.com/web/geek/chat';
        const currentUrl = await page.url();
        if (!currentUrl.includes('/web/geek/chat')) {
          await page.goto(targetUrl);
          await page.waitForTimeout(2500);
        }

        // 1. 确保当前打开的是目标 HR 的对话窗口
        if (context.targetHr) {
          const isCurrentMatch = await page.evaluate((target) => {
            const baseInfo = document.querySelector('.user-info .base-info');
            const text = baseInfo ? baseInfo.innerText : '';
            return text.includes(target.targetHr) && (!target.targetCompany || text.includes(target.targetCompany));
          }, context);

          if (!isCurrentMatch) {
            const switched = await page.evaluate((target) => {
              const items = Array.from(document.querySelectorAll("li[role='listitem']"));
              const matchedItem = items.find(it => {
                const t = it.innerText || '';
                return t.includes(target.targetHr) && (!target.targetCompany || t.includes(target.targetCompany));
              });
              if (!matchedItem) return false;
              const clickTarget = matchedItem.querySelector('.friend-content') || matchedItem.querySelector('.friend-content-warp') || matchedItem;
              clickTarget.scrollIntoView({ block: 'nearest' });
              clickTarget.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
              clickTarget.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
              clickTarget.click();
              return true;
            }, context);

            if (!switched) {
              throw new Error('未能定位到目标联系人窗口: ' + context.targetCompany + ' - ' + context.targetHr);
            }
            await page.waitForTimeout(2000);
          }
        }

        // 2. 发送前最后核实 (Pre-Send Double Check)：检查最后一条实质消息是否已是我方发出（例如手机端刚回过）
        const preCheck = await page.evaluate(() => {
          const items = Array.from(document.querySelectorAll('li.message-item, .message-item')).filter(it => {
            const t = it.innerText || '';
            if (t.includes('你与该职位竞争者PK情况') || t.includes('查看详细分析')) return false;
            if (it.classList.contains('item-system')) return false;
            return true;
          });
          if (items.length === 0) return { hasRecentSelf: false };
          const last = items[items.length - 1];
          const isMyself = last.classList.contains('item-myself') || last.classList.contains('item-right');
          return { hasRecentSelf: isMyself, lastText: last.innerText.trim() };
        });

        if (preCheck.hasRecentSelf) {
          return { cancelled: true, reason: 'SELF_ALREADY_REPLIED' };
        }

        // 3. 发送伴随文本回复（若存在回复文本）
        let textSent = false;
        if (context.messageText && context.messageText.trim().length > 0) {
          await page.evaluate((textToSend) => {
            const editor = document.querySelector('div.chat-im.chat-editor');
            if (!editor) throw new Error('Chat editor not found');
            editor.focus();
            document.execCommand('selectAll', false, null);
            document.execCommand('insertText', false, textToSend);
          }, context.messageText);

          await page.waitForTimeout(600);

          await page.evaluate(() => {
            const sendBtn = document.querySelector('button.btn-send');
            if (!sendBtn || sendBtn.disabled || sendBtn.classList.contains('disabled')) {
              throw new Error('Send button disabled');
            }
            sendBtn.click();
          });

          textSent = true;
          await page.waitForTimeout(1800);
        }

        // 4. 若动作请求为 SEND_RESUME，在浏览器上下文内安全点击【发简历】与确认弹窗
        let resumeClicked = false;
        if (context.actionKind === 'SEND_RESUME') {
          const clickedBtn = await page.evaluate(() => {
            const btns = Array.from(document.querySelectorAll('.toolbar-btn'));
            const resumeBtn = btns.find(b => b.innerText && b.innerText.includes('发简历'));
            if (!resumeBtn || resumeBtn.classList.contains('unable') || !!resumeBtn.closest('.unable')) {
              return false;
            }
            resumeBtn.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
            resumeBtn.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
            resumeBtn.click();
            return true;
          });

          if (clickedBtn) {
            await page.waitForTimeout(1500);
            const confirmed = await page.evaluate(() => {
              // 严格限定在 BOSS 直聘的 panel-resume / sentence-popover 浮层内，绝不全局查找，防止误触换电话/换微信
              const panel = document.querySelector('.panel-resume, .sentence-popover');
              if (panel) {
                const sureBtn = panel.querySelector('.btn-sure-v2') || Array.from(panel.querySelectorAll('span, button')).find(b => b.innerText && b.innerText.trim() === '确定');
                if (sureBtn) {
                  sureBtn.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
                  sureBtn.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
                  sureBtn.click();
                  return true;
                }
              }
              return false;
            });
            resumeClicked = confirmed;
            await page.waitForTimeout(2000);
          }
        }

        // 5. 若动作请求为 EXCHANGE_WECHAT，在浏览器上下文内安全点击【换微信】与确认弹窗
        let wechatClicked = false;
        if (context.actionKind === 'EXCHANGE_WECHAT') {
          const clickedBtn = await page.evaluate(() => {
            const btns = Array.from(document.querySelectorAll('.toolbar-btn'));
            const wechatBtn = btns.find(b => b.innerText && b.innerText.includes('微信'));
            if (!wechatBtn || wechatBtn.classList.contains('unable') || !!wechatBtn.closest('.unable')) {
              return false;
            }
            wechatBtn.click();
            return true;
          });

          if (clickedBtn) {
            await page.waitForTimeout(1500);
            const confirmed = await page.evaluate(() => {
              const panel = document.querySelector('.panel-weixin, .dialog-container, .boss-dialog');
              if (panel) {
                const confirmBtn = Array.from(panel.querySelectorAll('button, .btn, span')).find(b => {
                  const t = b.innerText ? b.innerText.trim() : '';
                  return (t === '确定' || t === '确认') && b.offsetParent !== null;
                });
                if (confirmBtn) {
                  confirmBtn.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
                  confirmBtn.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
                  confirmBtn.click();
                  return true;
                }
              }
              return false;
            });
            wechatClicked = confirmed;
            await page.waitForTimeout(2000);
          }
        }

        // 6. 回读 DOM 核实消息与简历卡片已挂载
        const verifyResult = await page.evaluate((ctx) => {
          const items = Array.from(document.querySelectorAll('li.message-item, .message-item'));
          const textVerified = !ctx.messageText || items.some(it => it.innerText && it.innerText.includes(ctx.messageText.slice(0, 15)));
          const resumeVerified = ctx.actionKind !== 'SEND_RESUME' || items.some(it => it.innerText && it.innerText.includes('附件简历'));
          return { textVerified, resumeVerified };
        }, context);

        return {
          cancelled: false,
          textSent,
          resumeClicked,
          wechatClicked,
          verified: verifyResult.textVerified && (context.actionKind !== 'SEND_RESUME' || verifyResult.resumeVerified)
        };
      `;

      const execRes = await this.bridge.runInBrowser(actionBody, {
        targetHr,
        targetCompany,
        actionKind,
        messageText
      });

      if (execRes.cancelled) {
        this.db.verifyActionSuccess(actionId, `CANCELLED_DUE_TO_${execRes.reason}`);
        return { success: true, cancelled: true, reason: execRes.reason };
      }

      if (execRes.verified) {
        this.db.verifyActionSuccess(actionId, `CONFIRMED_IN_DOM (resume=${execRes.resumeClicked}, wechat=${execRes.wechatClicked})`);

        if (action.conversation_id && messageText) {
          this.db.recordMessage({
            conversation_id: action.conversation_id,
            sender_type: 'CANDIDATE',
            sender_name: config.candidateProfile.name,
            content: messageText,
            delivery_status: 'DELIVERED'
          });
        }

        if (action.conversation_id && actionKind === 'SEND_RESUME') {
          this.db.upsertConversation({
            conversation_id: action.conversation_id,
            send_resume_status: 'COMPLETED',
            last_message_text: `[送达] ${messageText}`
          });
        } else if (action.conversation_id && actionKind === 'EXCHANGE_WECHAT') {
          this.db.upsertConversation({
            conversation_id: action.conversation_id,
            exchange_wechat_status: 'COMPLETED',
            last_message_text: `[送达] ${messageText}`
          });
        } else if (action.conversation_id && messageText) {
          this.db.upsertConversation({
            conversation_id: action.conversation_id,
            last_message_text: `[送达] ${messageText}`
          });
        }

        return { success: true, verified: true, execRes };
      } else {
        this.db.markActionUnknown(actionId, "SENT_BUT_NOT_YET_CONFIRMED_IN_DOM");
        return { success: false, status: 'UNKNOWN' };
      }
    } catch (err) {
      this.db.markActionUnknown(actionId, `ERROR: ${err.message}`);
      return { success: false, status: 'UNKNOWN', error: err.message };
    }
  }

  /**
   * 兼容单测接口：受控执行外部发送动作
   */
  async executeSendWithPreCheck(actionId, targetConversationId, messageText) {
    return await this.executeChatAction(actionId);
  }
}
