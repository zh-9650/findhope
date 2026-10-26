export class JobMatcher {
  constructor(claudeRunner, db) {
    this.runner = claudeRunner;
    this.db = db;
  }

  /**
   * 两级漏斗评估岗位
   * Level 1: 本地硬规则 (0 Token 毫秒级)
   * Level 2: Claude CLI 语义精筛
   */
  async evaluatePosting(postingWithSnapshot, candidateProfile, configVersion = 1) {
    const { posting_id, job_title, company_name, plain_salary, jd_text, hr_active_tag, is_active_within_3days } = postingWithSnapshot;

    // --- Level 1: 本地硬规则过滤 ---
    // 1.1 黑名单关键词过滤 (如外包、派遣、驻场；先剔除“非外包/不外包/不驻场”等否定表述防止误伤)
    const sanitizeNegated = (s) => (s || '').replace(/(非|不|不是|拒绝|无)(外包|派遣|驻场|外派)/g, '');
    const cleanTitle = sanitizeNegated(job_title);
    const cleanJd = sanitizeNegated(jd_text);
    const cleanComp = sanitizeNegated(company_name);

    if (candidateProfile.blacklistKeywords && candidateProfile.blacklistKeywords.length > 0) {
      for (const kw of candidateProfile.blacklistKeywords) {
        if (cleanTitle.includes(kw) || cleanJd.includes(kw) || cleanComp.includes(kw)) {
          const res = {
            assessment_id: `ASM_${posting_id}_v${configVersion}`,
            posting_id,
            config_version: configVersion,
            decision: 'REJECT',
            match_score: 0.1,
            matched_skills: [],
            missing_skills: [],
            reason: `命中排除黑名单关键词: "${kw}"`,
            filter_stage: 'HARD_RULE'
          };
          this.db.recordAssessment(res);
          return res;
        }
      }
    }

    // 1.2 HR 活跃度硬门槛 (若确定超时如半年前活跃，标记为 REVIEW 或 REJECT)
    if (is_active_within_3days === 0) {
      const res = {
        assessment_id: `ASM_${posting_id}_v${configVersion}`,
        posting_id,
        config_version: configVersion,
        decision: 'REVIEW',
        match_score: 0.3,
        matched_skills: [],
        missing_skills: [],
        reason: `HR 活跃度过低 (${hr_active_tag || '长期未活跃'})，建议人工核验`,
        filter_stage: 'HARD_RULE'
      };
      this.db.recordAssessment(res);
      return res;
    }

    // --- Level 2: Claude 深度语义复筛 ---
    const prompt = `请作为求职匹配评估专家，对照候选人画像与岗位信息进行客观打分评估：
【候选人真实画像】：
- 姓名/学历/年限：${candidateProfile.name} (全日制专升本，${candidateProfile.yearsOfExperience}年测试工程师实战经验)
- 具备全部技能库：${candidateProfile.preferredSkills.join(', ')}
- 详细背景：${candidateProfile.resumeSummary}

【目标岗位】：
- 职位名称：${job_title} (${company_name})
- 薪资范围：${plain_salary || '面议'}
- HR活跃度：${hr_active_tag || '未知'}
- 完整职责与要求：
${jd_text}

【核心评估判定红线与准则（非常重要）】：
1. 年限容差与扣分原则：
   - 候选人实战能力扎实，全面掌握自动化、性能测试、Linux/MySQL及微服务容器化；
   - 若岗位要求“3年”或“3-5年”经验，严禁一票否决(REJECT)！年限差异仅作为轻度扣分项（扣5-10分）；
   - 只要技能匹配度良好，综合得分>=0.65即必须给出【MATCH】（强烈推荐建联投递）！
   - 只有明确要求“5年以上资深 / 8-10年总监架构师”等严重跨梯队的岗位才予以 REJECT。
2. 技能全面性认定：
   - 候选人已全面掌握性能测试（JMeter/并发压测）、Linux/Shell、MySQL数据库、微服务Docker容器化与自动化测试；不要错误判定为“缺失上述技能”。

请严格按以下 JSON Schema 输出评估结果：
{
  "posting_id": "${posting_id}",
  "decision": "MATCH" | "REJECT" | "REVIEW",
  "match_score": 0.0到1.0的浮点数,
  "matched_skills": ["命中的技能1", "命中的技能2"],
  "missing_skills": ["确属缺失的高级领域技能"],
  "reason": "清晰扼要的评估判定理由（中文50字以内）"
}`;

    const evaluated = await this.runner.invokeReasoning(prompt, "JOB_ASSESSMENT");

    const assessmentRecord = {
      assessment_id: `ASM_${posting_id}_v${configVersion}`,
      posting_id,
      config_version: configVersion,
      decision: evaluated.decision || 'REVIEW',
      match_score: evaluated.match_score ?? 0.5,
      matched_skills: evaluated.matched_skills || [],
      missing_skills: evaluated.missing_skills || [],
      reason: evaluated.reason || 'Claude 语义评估完成',
      filter_stage: 'SEMANTIC'
    };

    this.db.recordAssessment(assessmentRecord);
    return assessmentRecord;
  }
}
