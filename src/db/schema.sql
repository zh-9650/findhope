-- BOSS Autonomous Job-Seeking Agent DDL
PRAGMA foreign_keys = ON;
PRAGMA journal_mode = WAL;

-- 1. 配置快照表 (不可变版本)
CREATE TABLE IF NOT EXISTS config_versions (
    version_id INTEGER PRIMARY KEY AUTOINCREMENT,
    version_number INTEGER NOT NULL UNIQUE,
    config_json TEXT NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- 2. 职位主表 (以 platform_job_id 为唯一物理主键)
CREATE TABLE IF NOT EXISTS postings (
    posting_id TEXT PRIMARY KEY,               -- 平台提取的唯一 jobId
    job_title TEXT NOT NULL,                  -- 职位名
    company_name TEXT NOT NULL,               -- 公司名
    recruiter_name TEXT,                      -- HR 姓名
    recruiter_title TEXT,                     -- HR 职务展示
    recruiter_fingerprint TEXT,               -- company + recruiter 聚合指纹 (防同HR刷屏)
    city_name TEXT,                           -- 城市
    list_salary_raw TEXT,                     -- 列表页薪资 (可能带私有字体)
    detail_url TEXT NOT NULL,                 -- 详情页绝对/相对路径
    source_query TEXT,                        -- 搜索关键词来源
    discovery_count INTEGER DEFAULT 1,        -- 累计被搜索发现次数
    status TEXT DEFAULT 'DISCOVERED',         -- DISCOVERED | DETAIL_SCRAPED | EXPIRED_CLOSED
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_postings_recruiter_fingerprint ON postings(recruiter_fingerprint);
CREATE INDEX IF NOT EXISTS idx_postings_status ON postings(status);

-- 3. 职位快照与明文 JD 表 (支持版本变更追踪)
CREATE TABLE IF NOT EXISTS posting_snapshots (
    snapshot_id INTEGER PRIMARY KEY AUTOINCREMENT,
    posting_id TEXT NOT NULL REFERENCES postings(posting_id) ON DELETE CASCADE,
    jd_hash TEXT NOT NULL,                    -- JD 文本的 SHA256
    jd_text TEXT NOT NULL,                    -- 完整 JD 职责文本
    plain_salary TEXT,                        -- 详情页解密明文薪资 (如 "8-9K")
    hr_active_tag TEXT,                       -- HR 活跃状态原文 (如 "刚刚活跃", "2月内活跃")
    is_active_within_3days INTEGER,           -- 1: 确定3天内, 0: 确定超时, -1: 无法确定/保留原文
    scraped_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_snapshots_posting_id ON posting_snapshots(posting_id);

-- 4. 岗位智能评估记录表 (绑定 posting + jd_version + config_version)
CREATE TABLE IF NOT EXISTS assessments (
    assessment_id TEXT PRIMARY KEY,
    posting_id TEXT NOT NULL REFERENCES postings(posting_id) ON DELETE CASCADE,
    config_version INTEGER NOT NULL,
    decision TEXT NOT NULL,                   -- MATCH | REJECT | REVIEW
    match_score REAL DEFAULT 0.0,             -- 0.0 ~ 1.0 或 0 ~ 100
    matched_skills TEXT,                      -- 命中技能 JSON 数组
    missing_skills TEXT,                      -- 缺失技能 JSON 数组
    reason TEXT NOT NULL,                     -- 详细结构化理由
    filter_stage TEXT DEFAULT 'SEMANTIC',     -- HARD_RULE | SEMANTIC
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(posting_id, config_version)
);
CREATE INDEX IF NOT EXISTS idx_assessments_decision ON assessments(decision);

-- 5. 求职机会生命周期表 (长期招聘关系)
CREATE TABLE IF NOT EXISTS opportunities (
    opportunity_id TEXT PRIMARY KEY,          -- 通常为 OPP_ + posting_id
    posting_id TEXT NOT NULL REFERENCES postings(posting_id) ON DELETE CASCADE,
    conversation_id TEXT,                     -- 绑定的会话 ID (若已建立)
    stage TEXT NOT NULL DEFAULT 'CONTACT_PENDING', 
    -- CONTACT_PENDING -> CONTACTED -> CONVERSING -> INTERVIEW_PENDING -> INTERVIEW_CONFIRMED | HUMAN_HANDOFF | DORMANT | CLOSED
    last_contact_at DATETIME,
    interview_info TEXT,                      -- JSON: { date, time, address, type }
    notes TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_opportunities_stage ON opportunities(stage);

-- 6. 平台聊天会话表 (带工具解锁状态与双轨记忆账本)
CREATE TABLE IF NOT EXISTS conversations (
    conversation_id TEXT PRIMARY KEY,         -- BOSS 会话 ID (如 URL 中的 id 参数)
    posting_id TEXT,                          -- 关联的主职位
    hr_name TEXT,
    company_name TEXT,
    send_resume_status TEXT DEFAULT 'UNKNOWN',-- LOCKED | AVAILABLE | UNKNOWN
    exchange_wechat_status TEXT DEFAULT 'UNKNOWN',
    exchange_phone_status TEXT DEFAULT 'UNKNOWN',
    last_message_text TEXT,
    last_message_at DATETIME,
    unread_count INTEGER DEFAULT 0,
    memory_ledger TEXT DEFAULT '{}',          -- 结构化承诺与事实账本 JSON
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- 7. 聊天消息记录表 (复合指纹精准去重)
CREATE TABLE IF NOT EXISTS messages (
    message_id INTEGER PRIMARY KEY AUTOINCREMENT,
    conversation_id TEXT NOT NULL REFERENCES conversations(conversation_id) ON DELETE CASCADE,
    fingerprint TEXT NOT NULL,                -- sha256(conversation_id + direction + content + sender)
    sender_type TEXT NOT NULL,                -- 'HR' | 'CANDIDATE' | 'SYSTEM'
    sender_name TEXT,
    content TEXT NOT NULL,
    message_type TEXT DEFAULT 'TEXT',         -- TEXT | SYSTEM_EVENT | CARD
    delivery_status TEXT DEFAULT 'SENT',      -- SENT | DELIVERED | READ
    sent_at TEXT,
    scraped_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(conversation_id, fingerprint)
);
CREATE INDEX IF NOT EXISTS idx_messages_conversation ON messages(conversation_id);

-- 8. 外部写操作意图与防重执行记录表 (四态受控)
CREATE TABLE IF NOT EXISTS action_attempts (
    action_id TEXT PRIMARY KEY,
    conversation_id TEXT,
    posting_id TEXT,
    action_kind TEXT NOT NULL,                -- GREETING | REPLY_TEXT | SEND_RESUME | EXCHANGE_WECHAT | EXCHANGE_PHONE
    payload TEXT NOT NULL,                    -- 发送文本或参数 JSON
    content_hash TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'PREPARED',  -- PREPARED | ATTEMPTED | VERIFIED_SUCCESS | VERIFIED_FAILURE | UNKNOWN
    requires_approval INTEGER DEFAULT 0,      -- 1: 需用户人工点击批准
    approved_by_user INTEGER DEFAULT 0,       -- 1: 用户已批准
    verification_evidence TEXT,               -- 页面回读核验的真实证据或 DOM 片段
    error_message TEXT,
    attempt_count INTEGER DEFAULT 0,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_action_attempts_status ON action_attempts(status);

-- 9. 任务队列与检查点表 (支持抢占让权与断点恢复)
CREATE TABLE IF NOT EXISTS tasks (
    task_id TEXT PRIMARY KEY,
    task_type TEXT NOT NULL,                  -- SEARCH | DETAIL_FETCH | ASSESS | CHAT_SYNC | DRAFT_REPLY | VERIFY
    priority INTEGER DEFAULT 10,              -- 越高越优先 (HR 消息处理通常为 100, 搜岗为 10)
    status TEXT NOT NULL DEFAULT 'QUEUED',    -- QUEUED | RUNNING | YIELDED | DONE | FAILED | BLOCKED
    target_id TEXT,                           -- 关联的 posting_id 或 conversation_id
    checkpoint_data TEXT,                     -- 断点恢复 JSON 数据 (如游标、已处理子集)
    retry_count INTEGER DEFAULT 0,
    error_log TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_tasks_priority_status ON tasks(priority DESC, status);

-- 10. 单 Actor 租约互斥锁表 (防僵尸锁与双 Actor 碰撞)
CREATE TABLE IF NOT EXISTS actor_leases (
    resource_name TEXT PRIMARY KEY,           -- 如 'EGO_BROWSER_RESOURCE'
    holder_id TEXT NOT NULL,                  -- 持有任务/进程 ID
    acquired_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    expires_at DATETIME NOT NULL,             -- 绝对过期时间戳
    fencing_token INTEGER DEFAULT 1           -- 递增代际令牌
);

-- 11. 搜索轮次审计表
CREATE TABLE IF NOT EXISTS search_runs (
    run_id INTEGER PRIMARY KEY AUTOINCREMENT,
    keyword TEXT NOT NULL,
    city_code TEXT NOT NULL,
    scanned_count INTEGER DEFAULT 0,
    new_jobs_count INTEGER DEFAULT 0,
    duplicate_jobs_count INTEGER DEFAULT 0,
    completion_status TEXT DEFAULT 'PARTIAL', -- COMPLETE | PARTIAL | BLOCKED
    evidence_text TEXT,
    started_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    finished_at DATETIME
);
-- 增加系统实时事件日志表
CREATE TABLE IF NOT EXISTS system_logs (
    log_id INTEGER PRIMARY KEY AUTOINCREMENT,
    level TEXT DEFAULT 'INFO',               -- INFO | SUCCESS | WARN | ERROR
    module TEXT NOT NULL,                    -- SEARCH | DETAIL | CLAUDE | CHAT | GUARD | SCHEDULER
    message TEXT NOT NULL,
    details TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_system_logs_created ON system_logs(created_at DESC);
