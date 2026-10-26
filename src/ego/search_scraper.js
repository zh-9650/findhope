export class SearchScraper {
  constructor(bridge, db) {
    this.bridge = bridge;
    this.db = db;
  }

  /**
   * 执行单次搜索微批次采集（限制最多滚动 maxScrolls 次，防止长任务卡死）
   */
  async runSearchBatch(keyword, cityCode = '101270100', maxScrolls = 2) {
    // 根据该关键词历史搜索轮次，动态加深滚动次数（2 -> 4 -> 6 -> 8），避免每次重回首页只扫前18个老岗位
    const prevRunRow = this.db.db.prepare(`SELECT COUNT(*) as c FROM search_runs WHERE keyword = ?`).get(keyword);
    const prevRuns = prevRunRow ? prevRunRow.c : 0;
    const effectiveScrolls = Math.min(Math.max(maxScrolls, 2) + (prevRuns % 4) * 2, 8);

    const actionBody = `
      const targetUrl = 'https://www.zhipin.com/web/geek/job?query=' + encodeURIComponent(context.keyword) + '&city=' + context.cityCode;
      
      const currentUrl = await page.url();
      if (!currentUrl.includes('/web/geek/job') || !currentUrl.includes(encodeURIComponent(context.keyword))) {
        await page.goto(targetUrl);
        await page.waitForTimeout(3500);
      }

      let previousCount = 0;
      let scrollsDone = 0;
      let isEndReached = false;

      while (scrollsDone < context.maxScrolls) {
        scrollsDone++;
        await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
        await page.waitForTimeout(2500);

        const checkResult = await page.evaluate(() => {
          const cards = document.querySelectorAll('li.job-card-box, .job-card-wrapper');
          const hasNoMore = !!document.querySelector('.no-more, .load-more-no, .empty-area');
          return { count: cards.length, hasNoMore };
        });

        if (checkResult.hasNoMore || checkResult.count === previousCount) {
          isEndReached = checkResult.hasNoMore;
          break;
        }
        previousCount = checkResult.count;
      }

      // 提取全部可见卡片数据 (精确 DOM 契约)
      const extractedJobs = await page.evaluate(() => {
        const cards = Array.from(document.querySelectorAll('li.job-card-box, .job-card-wrapper'));
        return cards.map(c => {
          const linkEl = c.querySelector("a.job-card-left, a[href*='/job_detail/'], a.job-name");
          const href = linkEl ? linkEl.getAttribute('href') : '';
          const match = href.match(/\\/job_detail\\/([a-zA-Z0-9~_]+)\\.html/);
          const jobId = match ? match[1] : null;

          // 核心修复：必须精确匹配 a.job-name，避免把子元素 .job-salary 包含进职位名称中
          const titleEl = c.querySelector('a.job-name') || c.querySelector('.job-name');
          let jobTitle = titleEl ? titleEl.innerText.trim() : '';
          if (jobTitle.includes('\\n')) {
            jobTitle = jobTitle.split('\\n')[0].trim();
          }

          // 核心修复：列表页类名为 .job-salary
          const salaryEl = c.querySelector('.job-salary, .salary');
          const salaryRaw = salaryEl ? salaryEl.innerText.trim() : '';

          // 核心修复：真实公司名类名为 a.boss-info .boss-name 或 .company-name
          const companyEl = c.querySelector('a.boss-info .boss-name') || 
                            c.querySelector('.company-name a, .company-name') ||
                            c.querySelector('.boss-name');
          const companyName = companyEl ? companyEl.innerText.trim() : '';

          const bossEl = c.querySelector('.info-public, .boss-info-wrapper, .boss-name');

          return {
            jobId,
            jobTitle,
            salaryRaw,
            companyName,
            recruiterInfo: bossEl ? bossEl.innerText.trim() : '',
            detailUrl: href
          };
        }).filter(j => !!j.jobId);
      });

      return {
        jobs: extractedJobs,
        totalFound: extractedJobs.length,
        isEndReached
      };
    `;

    const result = await this.bridge.runInBrowser(actionBody, { keyword, cityCode, maxScrolls: effectiveScrolls });

    // 落盘写入数据库
    let newCount = 0;
    let duplicateCount = 0;

    for (const item of result.jobs) {
      const parts = (item.recruiterInfo || '').split(/\s+/);
      const rName = parts[0] || '';
      const rTitle = parts.slice(1).join(' ') || '';

      const res = this.db.recordPosting({
        posting_id: item.jobId,
        job_title: item.jobTitle,
        company_name: item.companyName,
        recruiter_name: rName,
        recruiter_title: rTitle,
        city_name: '成都',
        list_salary_raw: item.salaryRaw,
        detail_url: item.detailUrl.startsWith('http') ? item.detailUrl : `https://www.zhipin.com${item.detailUrl}`,
        source_query: keyword
      });

      if (res.isNew) newCount++;
      else duplicateCount++;
    }

    // 记录搜索轮次审计
    this.db.db.prepare(`
      INSERT INTO search_runs (
        keyword, city_code, scanned_count, new_jobs_count, duplicate_jobs_count, completion_status, finished_at
      ) VALUES (?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
    `).run(
      keyword,
      cityCode,
      result.totalFound,
      newCount,
      duplicateCount,
      result.isEndReached ? 'COMPLETE' : 'PARTIAL'
    );

    return {
      keyword,
      totalScanned: result.totalFound,
      newCount,
      duplicateCount,
      completionStatus: result.isEndReached ? 'COMPLETE' : 'PARTIAL'
    };
  }
}
