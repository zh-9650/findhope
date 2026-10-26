import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export class AgentDatabase {
  constructor(dbPath) {
    this.dbPath = dbPath;
    const dir = path.dirname(dbPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    this.db = new DatabaseSync(dbPath);
    this.initPragmas();
    this.runMigrations();
  }

  initPragmas() {
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA foreign_keys = ON;
      PRAGMA busy_timeout = 5000;
    `);
  }

  runMigrations() {
    const schemaPath = path.join(__dirname, 'schema.sql');
    if (fs.existsSync(schemaPath)) {
      const sql = fs.readFileSync(schemaPath, 'utf8');
      this.db.exec(sql);
    }
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS rejection_feedbacks (
        feedback_id INTEGER PRIMARY KEY AUTOINCREMENT,
        conversation_id TEXT UNIQUE NOT NULL,
        posting_id TEXT,
        company_name TEXT,
        hr_name TEXT,
        job_title TEXT,
        hr_reject_message TEXT,
        followup_question TEXT,
        hr_reason_reply TEXT,
        inferred_category TEXT DEFAULT '待HR回复原因',
        status TEXT DEFAULT 'ASKING_REASON',
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
      );

      CREATE TABLE IF NOT EXISTS rejection_reports (
        report_id INTEGER PRIMARY KEY AUTOINCREMENT,
        total_rejected INTEGER DEFAULT 0,
        replied_count INTEGER DEFAULT 0,
        summary TEXT,
        category_breakdown TEXT,
        greeting_diagnosis TEXT,
        resume_suggestions TEXT,
        chat_suggestions TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      );
    `);

    // 增量添加 conversations 表的“已读未回/送达”定时二次评估与跟进字段
    const convAlterCols = [
      `ALTER TABLE conversations ADD COLUMN followup_count INTEGER DEFAULT 0`,
      `ALTER TABLE conversations ADD COLUMN followup_status TEXT DEFAULT 'PENDING'`,
      `ALTER TABLE conversations ADD COLUMN followup_eval_score REAL DEFAULT NULL`,
      `ALTER TABLE conversations ADD COLUMN followup_eval_reason TEXT DEFAULT NULL`,
      `ALTER TABLE conversations ADD COLUMN last_followup_text TEXT DEFAULT NULL`,
      `ALTER TABLE conversations ADD COLUMN last_followup_scan_at DATETIME DEFAULT NULL`,
      `ALTER TABLE conversations ADD COLUMN last_followup_sent_at DATETIME DEFAULT NULL`
    ];
    for (const alterSql of convAlterCols) {
      try { this.db.exec(alterSql); } catch (e) { /* 字段已存在则忽略 */ }
    }
  }

  close() {
    this.db.close();
  }

  // --- 1. 配置管理 ---
  saveConfigVersion(versionNumber, configObj) {
    const stmt = this.db.prepare(`
      INSERT INTO config_versions (version_number, config_json)
      VALUES (?, ?)
      ON CONFLICT(version_number) DO UPDATE SET config_json = excluded.config_json
    `);
    stmt.run(versionNumber, JSON.stringify(configObj));
  }

  getLatestConfig() {
    const stmt = this.db.prepare(`SELECT * FROM config_versions ORDER BY version_number DESC LIMIT 1`);
    const row = stmt.get();
    if (!row) return null;
    return {
      versionNumber: row.version_number,
      config: JSON.parse(row.config_json),
      createdAt: row.created_at
    };
  }

  // --- 2. 职位管理与去重 (支持搜岗与聊天跨渠道联合去重) ---
  recordPosting(posting) {
    const recruiterFp = posting.recruiter_name && posting.company_name
      ? `${posting.company_name}_${posting.recruiter_name}_${posting.recruiter_title || ''}`
      : null;

    // 1. 先按主键 posting_id 精确查询
    let existing = this.db.prepare(`SELECT posting_id, discovery_count, detail_url, status FROM postings WHERE posting_id = ?`).get(posting.posting_id);

    // 2. 若主键未命中，按 (company_name + job_title) 跨渠道联合查重（防止聊天岗位与搜索岗位分裂成两条）
    if (!existing && posting.company_name && posting.company_name !== '企业' && posting.job_title) {
      existing = this.db.prepare(`
        SELECT posting_id, discovery_count, detail_url, status
        FROM postings
        WHERE company_name = ? AND job_title = ?
        LIMIT 1
      `).get(posting.company_name, posting.job_title);
    }

    if (existing) {
      const shouldUpdateUrl = posting.detail_url && posting.detail_url.includes('/job_detail/') && (!existing.detail_url || existing.detail_url.includes('/web/geek/chat'));
      const updateStmt = this.db.prepare(`
        UPDATE postings
        SET discovery_count = discovery_count + 1,
            recruiter_name = COALESCE(recruiter_name, ?),
            recruiter_title = COALESCE(recruiter_title, ?),
            recruiter_fingerprint = COALESCE(recruiter_fingerprint, ?),
            list_salary_raw = COALESCE(list_salary_raw, ?),
            detail_url = CASE WHEN ? = 1 THEN ? ELSE detail_url END,
            updated_at = CURRENT_TIMESTAMP
        WHERE posting_id = ?
      `);
      updateStmt.run(
        posting.recruiter_name ?? null,
        posting.recruiter_title ?? null,
        recruiterFp,
        posting.list_salary_raw ?? null,
        shouldUpdateUrl ? 1 : 0,
        posting.detail_url,
        existing.posting_id
      );
      return { isNew: false, postingId: existing.posting_id };
    } else {
      const insertStmt = this.db.prepare(`
        INSERT INTO postings (
          posting_id, job_title, company_name, recruiter_name, recruiter_title,
          recruiter_fingerprint, city_name, list_salary_raw, detail_url, source_query, status
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      insertStmt.run(
        posting.posting_id,
        posting.job_title,
        posting.company_name,
        posting.recruiter_name ?? null,
        posting.recruiter_title ?? null,
        recruiterFp,
        posting.city_name ?? null,
        posting.list_salary_raw ?? null,
        posting.detail_url,
        posting.source_query ?? null,
        posting.status ?? 'DISCOVERED'
      );
      return { isNew: true, postingId: posting.posting_id };
    }
  }

  recordSnapshot(snapshot) {
    const jdHash = crypto.createHash('sha256').update(snapshot.jd_text).digest('hex');
    const stmt = this.db.prepare(`
      INSERT INTO posting_snapshots (
        posting_id, jd_hash, jd_text, plain_salary, hr_active_tag, is_active_within_3days
      ) VALUES (?, ?, ?, ?, ?, ?)
    `);
    const res = stmt.run(
      snapshot.posting_id,
      jdHash,
      snapshot.jd_text,
      snapshot.plain_salary ?? null,
      snapshot.hr_active_tag ?? null,
      snapshot.is_active_within_3days ?? -1
    );

    // 仅当主表处于 DISCOVERED 时才更新为 DETAIL_SCRAPED，避免覆盖 CHAT_ACTIVE 或 ALREADY_CONTACTED 状态
    const targetStatus = snapshot.posting_status || 'DETAIL_SCRAPED';
    this.db.prepare(`
      UPDATE postings
      SET status = CASE WHEN status IN ('CHAT_ACTIVE', 'ALREADY_CONTACTED') THEN status ELSE ? END,
          updated_at = CURRENT_TIMESTAMP
      WHERE posting_id = ?
    `).run(targetStatus, snapshot.posting_id);

    return res.lastInsertRowid;
  }

  getPostingWithLatestSnapshot(postingId) {
    const stmt = this.db.prepare(`
      SELECT p.*, s.jd_text, s.plain_salary, s.hr_active_tag, s.is_active_within_3days, s.jd_hash
      FROM postings p
      LEFT JOIN posting_snapshots s ON p.posting_id = s.posting_id
      WHERE p.posting_id = ?
      ORDER BY s.snapshot_id DESC LIMIT 1
    `);
    return stmt.get(postingId);
  }

  // --- 3. 智能评估管理 ---
  recordAssessment(assessment) {
    const stmt = this.db.prepare(`
      INSERT INTO assessments (
        assessment_id, posting_id, config_version, decision, match_score,
        matched_skills, missing_skills, reason, filter_stage
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(posting_id, config_version) DO UPDATE SET
        decision = excluded.decision,
        match_score = excluded.match_score,
        matched_skills = excluded.matched_skills,
        missing_skills = excluded.missing_skills,
        reason = excluded.reason,
        filter_stage = excluded.filter_stage
    `);

    stmt.run(
      assessment.assessment_id || `ASM_${assessment.posting_id}_v${assessment.config_version}`,
      assessment.posting_id,
      assessment.config_version,
      assessment.decision,
      assessment.match_score ?? 0.0,
      JSON.stringify(assessment.matched_skills || []),
      JSON.stringify(assessment.missing_skills || []),
      assessment.reason,
      assessment.filter_stage ?? 'SEMANTIC'
    );

    // 如果是 MATCH，仅在尚未存在 Opportunity 时生成 CONTACT_PENDING，绝不覆盖已在沟通或已建联的状态
    if (assessment.decision === 'MATCH') {
      const existingOpp = this.db.prepare(`SELECT opportunity_id, stage FROM opportunities WHERE posting_id = ? LIMIT 1`).get(assessment.posting_id);
      if (!existingOpp) {
        this.createOrUpdateOpportunity({
          posting_id: assessment.posting_id,
          stage: 'CONTACT_PENDING'
        });
      }
    }
  }

  // --- 4. 求职机会生命周期 ---
  createOrUpdateOpportunity(opp) {
    const oppId = opp.opportunity_id || `OPP_${opp.posting_id}`;
    const stmt = this.db.prepare(`
      INSERT INTO opportunities (
        opportunity_id, posting_id, conversation_id, stage, last_contact_at, notes
      ) VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP, ?)
      ON CONFLICT(opportunity_id) DO UPDATE SET
        stage = COALESCE(excluded.stage, opportunities.stage),
        conversation_id = COALESCE(excluded.conversation_id, opportunities.conversation_id),
        last_contact_at = CURRENT_TIMESTAMP,
        notes = COALESCE(excluded.notes, opportunities.notes),
        updated_at = CURRENT_TIMESTAMP
    `);
    stmt.run(
      oppId,
      opp.posting_id,
      opp.conversation_id ?? null,
      opp.stage ?? 'CONTACT_PENDING',
      opp.notes ?? null
    );
  }

  // --- 5. 聊天会话与消息管理 ---
  upsertConversation(conv) {
    const stmt = this.db.prepare(`
      INSERT INTO conversations (
        conversation_id, posting_id, hr_name, company_name, send_resume_status,
        exchange_wechat_status, exchange_phone_status, last_message_text, unread_count, memory_ledger
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(conversation_id) DO UPDATE SET
        posting_id = COALESCE(excluded.posting_id, conversations.posting_id),
        hr_name = COALESCE(excluded.hr_name, conversations.hr_name),
        company_name = COALESCE(excluded.company_name, conversations.company_name),
        send_resume_status = COALESCE(excluded.send_resume_status, conversations.send_resume_status),
        exchange_wechat_status = COALESCE(excluded.exchange_wechat_status, conversations.exchange_wechat_status),
        exchange_phone_status = COALESCE(excluded.exchange_phone_status, conversations.exchange_phone_status),
        last_message_text = COALESCE(excluded.last_message_text, conversations.last_message_text),
        unread_count = COALESCE(excluded.unread_count, conversations.unread_count),
        memory_ledger = COALESCE(excluded.memory_ledger, conversations.memory_ledger),
        updated_at = CURRENT_TIMESTAMP
    `);

    stmt.run(
      conv.conversation_id,
      conv.posting_id ?? null,
      conv.hr_name ?? null,
      conv.company_name ?? null,
      conv.send_resume_status ?? 'UNKNOWN',
      conv.exchange_wechat_status ?? 'UNKNOWN',
      conv.exchange_phone_status ?? 'UNKNOWN',
      conv.last_message_text ?? null,
      conv.unread_count ?? 0,
      typeof conv.memory_ledger === 'object' ? JSON.stringify(conv.memory_ledger) : (conv.memory_ledger ?? '{}')
    );
  }

  recordMessage(msg) {
    // 指纹：sha256(conversation_id + sender_type + content + sender_name)
    const fpStr = `${msg.conversation_id}_${msg.sender_type}_${msg.content.trim()}_${msg.sender_name || ''}`;
    const fingerprint = crypto.createHash('sha256').update(fpStr).digest('hex');

    const stmt = this.db.prepare(`
      INSERT INTO messages (
        conversation_id, fingerprint, sender_type, sender_name, content, message_type, delivery_status, sent_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(conversation_id, fingerprint) DO NOTHING
    `);

    const res = stmt.run(
      msg.conversation_id,
      fingerprint,
      msg.sender_type,
      msg.sender_name ?? null,
      msg.content,
      msg.message_type ?? 'TEXT',
      msg.delivery_status ?? 'SENT',
      msg.sent_at ?? null
    );

    return { inserted: res.changes > 0, fingerprint };
  }

  getRecentMessages(conversationId, limit = 20) {
    const stmt = this.db.prepare(`
      SELECT * FROM messages
      WHERE conversation_id = ?
      ORDER BY message_id ASC
      LIMIT ?
    `);
    return stmt.all(conversationId, limit);
  }

  // --- 6. 外部写操作四态状态机 ---
  prepareAction(action) {
    const contentHash = crypto.createHash('sha256').update(action.payload).digest('hex');
    const stmt = this.db.prepare(`
      INSERT INTO action_attempts (
        action_id, conversation_id, posting_id, action_kind, payload, content_hash,
        status, requires_approval, approved_by_user
      ) VALUES (?, ?, ?, ?, ?, ?, 'PREPARED', ?, ?)
    `);
    stmt.run(
      action.action_id,
      action.conversation_id ?? null,
      action.posting_id ?? null,
      action.action_kind,
      action.payload,
      contentHash,
      action.requires_approval ? 1 : 0,
      action.approved_by_user ? 1 : 0
    );
  }

  markActionAttempted(actionId) {
    this.db.prepare(`
      UPDATE action_attempts
      SET status = 'ATTEMPTED', attempt_count = attempt_count + 1, updated_at = CURRENT_TIMESTAMP
      WHERE action_id = ?
    `).run(actionId);
  }

  verifyActionSuccess(actionId, evidenceText) {
    this.db.prepare(`
      UPDATE action_attempts
      SET status = 'VERIFIED_SUCCESS', verification_evidence = ?, updated_at = CURRENT_TIMESTAMP
      WHERE action_id = ?
    `).run(evidenceText, actionId);
  }

  markActionUnknown(actionId, errorMsg) {
    this.db.prepare(`
      UPDATE action_attempts
      SET status = 'UNKNOWN', error_message = ?, updated_at = CURRENT_TIMESTAMP
      WHERE action_id = ?
    `).run(errorMsg, actionId);
  }

  getUnknownActions() {
    return this.db.prepare(`SELECT * FROM action_attempts WHERE status = 'UNKNOWN' ORDER BY created_at ASC`).all();
  }

  getPendingApprovals() {
    return this.db.prepare(`
      SELECT a.*, c.hr_name, c.company_name
      FROM action_attempts a
      LEFT JOIN conversations c ON a.conversation_id = c.conversation_id
      WHERE a.requires_approval = 1 AND a.approved_by_user = 0 AND a.status = 'PREPARED'
      ORDER BY a.created_at DESC
    `).all();
  }

  approveAction(actionId) {
    this.db.prepare(`UPDATE action_attempts SET approved_by_user = 1, updated_at = CURRENT_TIMESTAMP WHERE action_id = ?`).run(actionId);
  }

  getApprovedPendingActions() {
    return this.db.prepare(`
      SELECT a.*, c.hr_name, c.company_name
      FROM action_attempts a
      LEFT JOIN conversations c ON a.conversation_id = c.conversation_id
      WHERE a.approved_by_user = 1 AND a.status = 'PREPARED'
      ORDER BY a.created_at ASC
    `).all();
  }

  // --- 7. 任务队列与检查点 ---
  enqueueTask(task) {
    const stmt = this.db.prepare(`
      INSERT INTO tasks (task_id, task_type, priority, status, target_id, checkpoint_data)
      VALUES (?, ?, ?, 'QUEUED', ?, ?)
      ON CONFLICT(task_id) DO UPDATE SET
        priority = excluded.priority,
        status = 'QUEUED',
        updated_at = CURRENT_TIMESTAMP
    `);
    stmt.run(
      task.task_id,
      task.task_type,
      task.priority ?? 10,
      task.target_id ?? null,
      typeof task.checkpoint_data === 'object' ? JSON.stringify(task.checkpoint_data) : (task.checkpoint_data ?? null)
    );
  }

  saveTaskCheckpoint(taskId, status, checkpointData) {
    const stmt = this.db.prepare(`
      UPDATE tasks
      SET status = ?, checkpoint_data = ?, updated_at = CURRENT_TIMESTAMP
      WHERE task_id = ?
    `);
    stmt.run(status, JSON.stringify(checkpointData), taskId);
  }

  getNextTask() {
    // 优先取 YIELDED 检查点恢复任务，其次按 priority 倒序取 QUEUED 任务
    const stmt = this.db.prepare(`
      SELECT * FROM tasks
      WHERE status IN ('QUEUED', 'YIELDED')
      ORDER BY CASE WHEN status = 'YIELDED' THEN 0 ELSE 1 END ASC, priority DESC, created_at ASC
      LIMIT 1
    `);
    return stmt.get();
  }

  // --- 8. 单 Actor 租约锁与防僵尸锁 ---
  acquireLease(resourceName, holderId, ttlMs = 15000) {
    const now = Date.now();
    const expiresAt = new Date(now + ttlMs).toISOString();

    // 先清理或检查已过期的锁
    const current = this.db.prepare(`SELECT * FROM actor_leases WHERE resource_name = ?`).get(resourceName);

    if (!current) {
      this.db.prepare(`
        INSERT INTO actor_leases (resource_name, holder_id, expires_at, fencing_token)
        VALUES (?, ?, ?, 1)
      `).run(resourceName, holderId, expiresAt);
      return { acquired: true, token: 1 };
    }

    const currentExpires = new Date(current.expires_at).getTime();
    if (current.holder_id === holderId) {
      // 自身续约
      this.db.prepare(`
        UPDATE actor_leases
        SET expires_at = ?, fencing_token = fencing_token + 1
        WHERE resource_name = ?
      `).run(expiresAt, resourceName);
      return { acquired: true, token: current.fencing_token + 1 };
    }

    if (now > currentExpires) {
      // 锁已超时过期 (僵尸锁自动接管)
      this.db.prepare(`
        UPDATE actor_leases
        SET holder_id = ?, expires_at = ?, fencing_token = fencing_token + 1
        WHERE resource_name = ?
      `).run(holderId, expiresAt, resourceName);
      return { acquired: true, token: current.fencing_token + 1 };
    }

    // 锁仍有效且被其他人持有
    return { acquired: false, holder: current.holder_id, remainingMs: currentExpires - now };
  }

  releaseLease(resourceName, holderId) {
    const res = this.db.prepare(`DELETE FROM actor_leases WHERE resource_name = ? AND holder_id = ?`).run(resourceName, holderId);
    return res.changes > 0;
  }

  // --- 10. 系统实时日志流 ---
  logEvent(module, message, level = 'INFO', details = null) {
    try {
      const stmt = this.db.prepare(`
        INSERT INTO system_logs (level, module, message, details)
        VALUES (?, ?, ?, ?)
      `);
      stmt.run(level, module, message, typeof details === 'object' ? JSON.stringify(details) : details);
    } catch (e) {
      console.error("Failed to write system log:", e.message);
    }
  }

  getRecentLogs(limit = 40) {
    const stmt = this.db.prepare(`
      SELECT * FROM system_logs
      ORDER BY log_id DESC
      LIMIT ?
    `);
    return stmt.all(limit).reverse();
  }

  // --- 9. 真实全链路多维漏斗统计 ---
  getDashboardMetrics() {
    const totalPostings = this.db.prepare(`SELECT COUNT(*) as c FROM postings`).get().c;
    const scrapedPostings = this.db.prepare(`SELECT COUNT(*) as c FROM postings WHERE status = 'DETAIL_SCRAPED'`).get().c;
    const matchCount = this.db.prepare(`SELECT COUNT(*) as c FROM assessments WHERE decision = 'MATCH'`).get().c;
    const rejectCount = this.db.prepare(`SELECT COUNT(*) as c FROM assessments WHERE decision = 'REJECT'`).get().c;
    const reviewCount = this.db.prepare(`SELECT COUNT(*) as c FROM assessments WHERE decision = 'REVIEW'`).get().c;

    const contactPending = this.db.prepare(`SELECT COUNT(*) as c FROM opportunities WHERE stage = 'CONTACT_PENDING'`).get().c;
    const contacted = this.db.prepare(`SELECT COUNT(*) as c FROM opportunities WHERE stage = 'CONTACTED'`).get().c;
    const conversing = this.db.prepare(`SELECT COUNT(*) as c FROM opportunities WHERE stage = 'CONVERSING'`).get().c;
    const interviewCount = this.db.prepare(`SELECT COUNT(*) as c FROM opportunities WHERE stage LIKE 'INTERVIEW%'`).get().c;

    const pendingApprovals = this.db.prepare(`
      SELECT COUNT(*) as c FROM action_attempts WHERE requires_approval = 1 AND approved_by_user = 0 AND status = 'PREPARED'
    `).get().c;

    const unknownActions = this.db.prepare(`SELECT COUNT(*) as c FROM action_attempts WHERE status = 'UNKNOWN'`).get().c;
    const rejectionCount = this.db.prepare(`SELECT COUNT(*) as c FROM rejection_feedbacks`).get().c;
    const followupPoolCount = this.db.prepare(`
      SELECT COUNT(*) as c FROM conversations
      WHERE followup_count > 0 OR followup_status IN ('WAITING_HR', 'NO_RESPONSE', 'NOT_WORTH_FOLLOWUP', 'HR_REPLIED')
    `).get().c;

    return {
      search: {
        totalDiscovered: totalPostings,
        detailScraped: scrapedPostings,
        pendingScrape: totalPostings - scrapedPostings
      },
      assessment: {
        matched: matchCount,
        rejected: rejectCount,
        review: reviewCount,
        passRate: totalPostings > 0 ? ((matchCount / (matchCount + rejectCount + reviewCount || 1)) * 100).toFixed(1) + '%' : '0%'
      },
      funnel: {
        contactPending,
        contacted,
        conversing,
        interview: interviewCount
      },
      governance: {
        pendingApprovals,
        unknownActions,
        rejectionCount,
        followupPoolCount
      }
    };
  }

  // --- 10.5 已读未回/送达定时二次跟进状态管理 ---
  updateConversationFollowup(conversationId, data) {
    const stmt = this.db.prepare(`
      UPDATE conversations SET
        followup_count = COALESCE(?, followup_count),
        followup_status = COALESCE(?, followup_status),
        followup_eval_score = COALESCE(?, followup_eval_score),
        followup_eval_reason = COALESCE(?, followup_eval_reason),
        last_followup_text = COALESCE(?, last_followup_text),
        last_followup_scan_at = CASE WHEN ? = 1 THEN CURRENT_TIMESTAMP ELSE last_followup_scan_at END,
        last_followup_sent_at = CASE WHEN ? = 1 THEN CURRENT_TIMESTAMP ELSE last_followup_sent_at END,
        updated_at = CURRENT_TIMESTAMP
      WHERE conversation_id = ?
    `);
    stmt.run(
      data.followup_count ?? null,
      data.followup_status ?? null,
      data.followup_eval_score ?? null,
      data.followup_eval_reason ?? null,
      data.last_followup_text ?? null,
      data.touch_scan_at ? 1 : 0,
      data.touch_sent_at ? 1 : 0,
      conversationId
    );
  }

  getFollowupConversations() {
    return this.db.prepare(`
      SELECT c.*, p.job_title, p.list_salary_raw, s.plain_salary, o.stage as opp_stage
      FROM conversations c
      LEFT JOIN postings p ON c.posting_id = p.posting_id
      LEFT JOIN (
        SELECT posting_id, plain_salary, MAX(snapshot_id)
        FROM posting_snapshots
        GROUP BY posting_id
      ) s ON c.posting_id = s.posting_id
      LEFT JOIN opportunities o ON c.posting_id = o.posting_id
      WHERE c.followup_count > 0
         OR c.followup_status IN ('WAITING_HR', 'NO_RESPONSE', 'NOT_WORTH_FOLLOWUP', 'HR_REPLIED')
         OR c.last_message_text LIKE '[已读]%'
         OR c.last_message_text LIKE '[送达]%'
      GROUP BY c.conversation_id
      ORDER BY c.updated_at DESC
      LIMIT 60
    `).all();
  }

  // --- 11. HR 拒绝原因追踪与复盘诊断 ---
  upsertRejectionFeedback(item) {
    const stmt = this.db.prepare(`
      INSERT INTO rejection_feedbacks (
        conversation_id, posting_id, company_name, hr_name, job_title,
        hr_reject_message, followup_question, hr_reason_reply, inferred_category, status
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(conversation_id) DO UPDATE SET
        posting_id = COALESCE(excluded.posting_id, rejection_feedbacks.posting_id),
        company_name = COALESCE(excluded.company_name, rejection_feedbacks.company_name),
        hr_name = COALESCE(excluded.hr_name, rejection_feedbacks.hr_name),
        job_title = COALESCE(excluded.job_title, rejection_feedbacks.job_title),
        hr_reject_message = COALESCE(excluded.hr_reject_message, rejection_feedbacks.hr_reject_message),
        followup_question = COALESCE(excluded.followup_question, rejection_feedbacks.followup_question),
        hr_reason_reply = COALESCE(excluded.hr_reason_reply, rejection_feedbacks.hr_reason_reply),
        inferred_category = COALESCE(excluded.inferred_category, rejection_feedbacks.inferred_category),
        status = COALESCE(excluded.status, rejection_feedbacks.status),
        updated_at = CURRENT_TIMESTAMP
    `);
    stmt.run(
      item.conversation_id,
      item.posting_id ?? null,
      item.company_name ?? null,
      item.hr_name ?? null,
      item.job_title ?? null,
      item.hr_reject_message ?? null,
      item.followup_question ?? null,
      item.hr_reason_reply ?? null,
      item.inferred_category ?? '待HR回复原因',
      item.status ?? 'ASKING_REASON'
    );
  }

  getRejectionFeedback(conversationId) {
    return this.db.prepare(`SELECT * FROM rejection_feedbacks WHERE conversation_id = ?`).get(conversationId) || null;
  }

  getAllRejectionFeedbacks() {
    return this.db.prepare(`SELECT * FROM rejection_feedbacks ORDER BY updated_at DESC`).all();
  }

  saveRejectionReport(report) {
    const stmt = this.db.prepare(`
      INSERT INTO rejection_reports (
        total_rejected, replied_count, summary, category_breakdown,
        greeting_diagnosis, resume_suggestions, chat_suggestions
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
    `);
    const res = stmt.run(
      report.total_rejected ?? 0,
      report.replied_count ?? 0,
      report.summary ?? '',
      typeof report.category_breakdown === 'object' ? JSON.stringify(report.category_breakdown) : (report.category_breakdown ?? '[]'),
      report.greeting_diagnosis ?? '',
      typeof report.resume_suggestions === 'object' ? JSON.stringify(report.resume_suggestions) : (report.resume_suggestions ?? '[]'),
      typeof report.chat_suggestions === 'object' ? JSON.stringify(report.chat_suggestions) : (report.chat_suggestions ?? '[]')
    );
    return res.lastInsertRowid;
  }

  getLatestRejectionReport() {
    const row = this.db.prepare(`SELECT * FROM rejection_reports ORDER BY report_id DESC LIMIT 1`).get();
    if (!row) return null;
    try { row.category_breakdown = JSON.parse(row.category_breakdown || '[]'); } catch { row.category_breakdown = []; }
    try { row.resume_suggestions = JSON.parse(row.resume_suggestions || '[]'); } catch { row.resume_suggestions = []; }
    try { row.chat_suggestions = JSON.parse(row.chat_suggestions || '[]'); } catch { row.chat_suggestions = []; }
    return row;
  }
}
