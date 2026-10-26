export class DetailScraper {
  constructor(bridge, db) {
    this.bridge = bridge;
    this.db = db;
  }

  /**
   * 抓取单个职位的明文详情与 HR 活跃状态
   */
  async scrapeJobDetail(postingId, detailUrl) {
    const actionBody = `
      await page.goto(context.detailUrl);
      await page.waitForTimeout(3000);

      const detailData = await page.evaluate(() => {
        // 1. 检查是否失效或已关闭
        const closedEl = document.querySelector('.job-status-closed, .job-banner .status-tip');
        if (closedEl && closedEl.innerText.includes('关闭')) {
          return { isClosed: true };
        }

        // 2. 详情页明文薪资 (100% 真实无字体混淆)
        const salaryEl = document.querySelector('.job-banner .salary');
        const plainSalary = salaryEl ? salaryEl.innerText.trim() : null;

        // 3. 详情页真实公司名
        const companyEl = document.querySelector('.job-banner .company-info a, .company-info a, .detail-box .company-name');
        const companyName = companyEl ? companyEl.innerText.trim() : null;

        // 4. 完整 JD 职责文本
        const jdEl = document.querySelector('.job-sec-text');
        const jdText = jdEl ? jdEl.innerText.trim() : '';

        // 5. HR 活跃度标签原文与姓名职务
        const activeTagEl = document.querySelector('.boss-active, .boss-online-tag, .detail-boss .active-time');
        const hrActiveTag = activeTagEl ? activeTagEl.innerText.trim() : null;

        const bossNameEl = document.querySelector('.detail-boss .boss-name, .job-boss .boss-name');
        const bossName = bossNameEl ? bossNameEl.innerText.trim() : null;

        // 6. 首次联系按钮状态
        const interestBtn = document.querySelector('.btn-interest');
        const startChatBtn = document.querySelector('.btn-startchat');
        const buttonText = startChatBtn ? startChatBtn.innerText.trim() : (interestBtn ? interestBtn.innerText.trim() : '');

        return {
          isClosed: false,
          plainSalary,
          companyName,
          bossName,
          jdText,
          hrActiveTag,
          buttonText
        };
      });

      return detailData;
    `;

    const detail = await this.bridge.runInBrowser(actionBody, { detailUrl });

    if (detail.isClosed || !detail.jdText) {
      this.db.db.prepare(`UPDATE postings SET status = 'EXPIRED_CLOSED', updated_at = CURRENT_TIMESTAMP WHERE posting_id = ?`)
        .run(postingId);
      return { postingId, status: 'EXPIRED_CLOSED' };
    }

    // 活跃度判定
    let within3Days = -1; // 默认无法确定
    if (detail.hrActiveTag) {
      const tag = detail.hrActiveTag;
      if (tag.includes('刚刚') || tag.includes('在线') || tag.includes('今日') || tag.includes('昨天') || tag.includes('3天内')) {
        within3Days = 1;
      } else if (tag.includes('2月内') || tag.includes('本月') || tag.includes('活跃')) {
        within3Days = -1;
      } else if (tag.includes('半年前') || tag.includes('3月前')) {
        within3Days = 0;
      }
    }

    // 更新 postings 主表中的公司名和 HR 名 (如果此前列表页为空)
    if (detail.companyName) {
      this.db.db.prepare(`
        UPDATE postings
        SET company_name = CASE WHEN company_name IS NULL OR company_name = '' THEN ? ELSE company_name END,
            recruiter_name = CASE WHEN recruiter_name IS NULL OR recruiter_name = '' THEN ? ELSE recruiter_name END
        WHERE posting_id = ?
      `).run(detail.companyName, detail.bossName || null, postingId);
    }

    const isAlreadyContacted = detail.buttonText && detail.buttonText.includes('继续沟通');

    // 保存快照
    const snapshotId = this.db.recordSnapshot({
      posting_id: postingId,
      jd_text: detail.jdText,
      plain_salary: detail.plainSalary,
      hr_active_tag: detail.hrActiveTag,
      is_active_within_3days: within3Days,
      posting_status: isAlreadyContacted ? 'ALREADY_CONTACTED' : 'DETAIL_SCRAPED'
    });

    // 若详情页按钮已显示“继续沟通”，直接登记为已建联，跳过后续冗余评估与重复打招呼
    if (isAlreadyContacted) {
      this.db.createOrUpdateOpportunity({
        posting_id: postingId,
        stage: 'CONTACTED',
        notes: '详情页识别已处于【继续沟通】状态，自动归入已建联'
      });
    }

    return {
      postingId,
      snapshotId,
      plainSalary: detail.plainSalary,
      companyName: detail.companyName,
      hrActiveTag: detail.hrActiveTag,
      within3Days,
      buttonText: detail.buttonText,
      status: isAlreadyContacted ? 'ALREADY_CONTACTED' : 'DETAIL_SCRAPED'
    };
  }
}
