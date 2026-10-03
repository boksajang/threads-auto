import Database from 'better-sqlite3';

const migrations = [
  `
  CREATE TABLE IF NOT EXISTS schema_migrations (
    version INTEGER PRIMARY KEY,
    applied_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS accounts (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    threads_handle TEXT NOT NULL,
    topic TEXT NOT NULL,
    personality TEXT NOT NULL DEFAULT '',
    tone TEXT NOT NULL DEFAULT '',
    audience TEXT NOT NULL DEFAULT '',
    forbidden_topics TEXT NOT NULL DEFAULT '',
    forbidden_expressions TEXT NOT NULL DEFAULT '',
    daily_enabled INTEGER NOT NULL DEFAULT 1,
    promotion_enabled INTEGER NOT NULL DEFAULT 0,
    automation_target INTEGER NOT NULL DEFAULT 0,
    active INTEGER NOT NULL DEFAULT 1,
    daily_ratio INTEGER NOT NULL DEFAULT 3,
    promotion_ratio INTEGER NOT NULL DEFAULT 1,
    daily_post_target INTEGER NOT NULL DEFAULT 1,
    operation_start TEXT NOT NULL DEFAULT '09:00',
    operation_end TEXT NOT NULL DEFAULT '21:00',
    weekdays_json TEXT NOT NULL DEFAULT '[1,2,3,4,5,6,0]',
    comment_interval_minutes INTEGER NOT NULL DEFAULT 10,
    fixed_link_enabled INTEGER NOT NULL DEFAULT 0,
    fixed_link_url TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    CHECK (daily_enabled = 1 OR promotion_enabled = 1)
  );
  CREATE TABLE IF NOT EXISTS provider_configs (
    id TEXT PRIMARY KEY,
    account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    provider_type TEXT NOT NULL,
    enabled INTEGER NOT NULL DEFAULT 1,
    config_json TEXT NOT NULL DEFAULT '{}',
    UNIQUE(account_id, provider_type)
  );
  CREATE TABLE IF NOT EXISTS sources (
    id TEXT PRIMARY KEY,
    account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    source_type TEXT NOT NULL,
    source_key TEXT NOT NULL,
    source_url TEXT NOT NULL DEFAULT '',
    published_at TEXT,
    status TEXT NOT NULL DEFAULT 'PENDING',
    threads_post_id TEXT,
    metadata_json TEXT NOT NULL DEFAULT '{}',
    created_at TEXT NOT NULL,
    processed_at TEXT,
    UNIQUE(account_id, source_type, source_key)
  );
  CREATE TABLE IF NOT EXISTS posts (
    id TEXT PRIMARY KEY,
    account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    source_id TEXT REFERENCES sources(id),
    source_type TEXT NOT NULL,
    body TEXT NOT NULL,
    url TEXT,
    image_url TEXT,
    threads_post_id TEXT UNIQUE,
    created_at TEXT NOT NULL,
    published_at TEXT
  );
  CREATE TABLE IF NOT EXISTS comments (
    id TEXT PRIMARY KEY,
    account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    post_id TEXT NOT NULL,
    body TEXT NOT NULL,
    reply_id TEXT,
    processed_at TEXT,
    created_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS jobs (
    id TEXT PRIMARY KEY,
    account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    kind TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'PENDING',
    run_at TEXT NOT NULL,
    attempt INTEGER NOT NULL DEFAULT 0,
    payload_json TEXT NOT NULL DEFAULT '{}',
    last_error TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS jobs_due_idx ON jobs(status, run_at);
  CREATE TABLE IF NOT EXISTS insights (
    post_id TEXT PRIMARY KEY REFERENCES posts(id) ON DELETE CASCADE,
    views INTEGER NOT NULL DEFAULT 0,
    likes INTEGER NOT NULL DEFAULT 0,
    replies INTEGER NOT NULL DEFAULT 0,
    reposts INTEGER NOT NULL DEFAULT 0,
    quotes INTEGER NOT NULL DEFAULT 0,
    shares INTEGER NOT NULL DEFAULT 0,
    clicks INTEGER NOT NULL DEFAULT 0,
    orders INTEGER NOT NULL DEFAULT 0,
    order_amount REAL NOT NULL DEFAULT 0,
    revenue REAL NOT NULL DEFAULT 0,
    collected_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS user_logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    level TEXT NOT NULL,
    category TEXT NOT NULL,
    message TEXT NOT NULL,
    detail TEXT,
    account_id TEXT,
    created_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS logs_created_idx ON user_logs(created_at DESC);
  `,
  `
  CREATE TABLE IF NOT EXISTS pipeline_runs (
    id TEXT PRIMARY KEY,
    account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    job_id TEXT REFERENCES jobs(id) ON DELETE SET NULL,
    mode TEXT NOT NULL CHECK(mode IN ('PREVIEW','PUBLISH')),
    status TEXT NOT NULL CHECK(status IN ('QUEUED','RUNNING','STOPPED','REJECTED','FAILED','COMPLETED')),
    stage TEXT NOT NULL CHECK(stage IN ('QUEUED','DISCOVER','SOURCE','TOPIC','WRITER','REVIEWER','ORCHESTRATOR','PUBLISH','DONE')),
    progress INTEGER NOT NULL DEFAULT 0 CHECK(progress BETWEEN 0 AND 100),
    message TEXT NOT NULL DEFAULT '',
    error_summary TEXT,
    source_id TEXT REFERENCES sources(id) ON DELETE SET NULL,
    draft_body TEXT,
    quality_json TEXT NOT NULL DEFAULT '[]',
    started_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    finished_at TEXT
  );
  CREATE INDEX IF NOT EXISTS pipeline_runs_account_idx ON pipeline_runs(account_id, updated_at DESC);
  CREATE INDEX IF NOT EXISTS pipeline_runs_status_idx ON pipeline_runs(status, updated_at DESC);
  ALTER TABLE user_logs ADD COLUMN run_id TEXT REFERENCES pipeline_runs(id) ON DELETE SET NULL;
  ALTER TABLE user_logs ADD COLUMN stage TEXT;
  CREATE INDEX IF NOT EXISTS logs_account_id_idx ON user_logs(account_id, id DESC);
  CREATE INDEX IF NOT EXISTS logs_run_id_idx ON user_logs(run_id, id);
  `,
  `
  ALTER TABLE pipeline_runs ADD COLUMN post_id TEXT REFERENCES posts(id) ON DELETE SET NULL;
  CREATE INDEX IF NOT EXISTS pipeline_runs_post_id_idx ON pipeline_runs(post_id);
  `,
  `
  ALTER TABLE accounts ADD COLUMN threads_user_id TEXT;
  CREATE UNIQUE INDEX IF NOT EXISTS accounts_threads_user_id_idx ON accounts(threads_user_id) WHERE threads_user_id IS NOT NULL AND threads_user_id <> '';
  `,
  `
  ALTER TABLE comments ADD COLUMN author_username TEXT NOT NULL DEFAULT '';
  ALTER TABLE comments ADD COLUMN commented_at TEXT;
  ALTER TABLE comments ADD COLUMN decision TEXT NOT NULL DEFAULT 'PENDING';
  ALTER TABLE comments ADD COLUMN decision_reason TEXT;
  ALTER TABLE comments ADD COLUMN reply_body TEXT;
  ALTER TABLE comments ADD COLUMN reply_status TEXT NOT NULL DEFAULT 'NONE';
  ALTER TABLE comments ADD COLUMN replied_at TEXT;
  ALTER TABLE comments ADD COLUMN reply_deleted_at TEXT;
  ALTER TABLE comments ADD COLUMN last_error TEXT;
  ALTER TABLE comments ADD COLUMN updated_at TEXT;
  ALTER TABLE comments ADD COLUMN attempt_count INTEGER NOT NULL DEFAULT 0;
  UPDATE comments SET
    decision=CASE WHEN reply_id IS NULL THEN 'SKIPPED' ELSE 'REPLIED' END,
    reply_status=CASE WHEN reply_id IS NULL THEN 'NONE' ELSE 'PUBLISHED' END,
    replied_at=CASE WHEN reply_id IS NULL THEN NULL ELSE processed_at END,
    updated_at=COALESCE(processed_at,created_at),
    attempt_count=CASE WHEN reply_id IS NULL THEN 0 ELSE 1 END;
  CREATE INDEX IF NOT EXISTS comments_account_updated_idx ON comments(account_id, updated_at DESC);
  CREATE INDEX IF NOT EXISTS comments_account_post_idx ON comments(account_id, post_id);
  ALTER TABLE posts ADD COLUMN remote_deleted_at TEXT;
  CREATE INDEX IF NOT EXISTS posts_account_remote_deleted_idx ON posts(account_id, remote_deleted_at, published_at DESC);
  `,
  `
  CREATE TABLE IF NOT EXISTS threads_integration_runs (
    id TEXT PRIMARY KEY,
    account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    mode TEXT NOT NULL,
    status TEXT NOT NULL,
    stage TEXT NOT NULL,
    message TEXT NOT NULL DEFAULT '',
    summary TEXT,
    last_error TEXT,
    draft_body TEXT,
    parent_id TEXT,
    reply_id TEXT,
    nested_reply_id TEXT,
    cleanup_needed INTEGER NOT NULL DEFAULT 0,
    error_summary TEXT,
    metadata_json TEXT NOT NULL DEFAULT '{}',
    started_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    finished_at TEXT
  );
  CREATE INDEX IF NOT EXISTS threads_integration_runs_account_idx
    ON threads_integration_runs(account_id, updated_at DESC);
  CREATE TABLE IF NOT EXISTS threads_integration_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    run_id TEXT NOT NULL REFERENCES threads_integration_runs(id) ON DELETE CASCADE,
    stage TEXT NOT NULL,
    level TEXT NOT NULL,
    message TEXT NOT NULL,
    detail_json TEXT NOT NULL DEFAULT '{}',
    remote_id TEXT,
    remote_object_type TEXT,
    remote_object_id TEXT,
    created_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS threads_integration_events_run_idx
    ON threads_integration_events(run_id, id);
  `,
  `
  ALTER TABLE accounts ADD COLUMN threads_token_expires_at TEXT;
  ALTER TABLE accounts ADD COLUMN threads_token_last_refreshed_at TEXT;
  `,
  `
  ALTER TABLE accounts ADD COLUMN threads_token_issued_at TEXT;
  ALTER TABLE accounts ADD COLUMN threads_token_data_access_expires_at TEXT;
  ALTER TABLE accounts ADD COLUMN threads_token_checked_at TEXT;
  ALTER TABLE accounts ADD COLUMN threads_token_scopes_json TEXT;
  ALTER TABLE accounts ADD COLUMN threads_token_valid INTEGER;
  `,
  `
  ALTER TABLE user_logs ADD COLUMN threads_integration_run_id TEXT REFERENCES threads_integration_runs(id) ON DELETE SET NULL;
  CREATE INDEX IF NOT EXISTS logs_threads_integration_run_idx ON user_logs(threads_integration_run_id, id);
  `,
  `
  CREATE TABLE IF NOT EXISTS coupang_link_queue (
    id TEXT PRIMARY KEY,
    account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    original_input_type TEXT NOT NULL CHECK(original_input_type IN ('PLAIN_LINK','IFRAME','BLOG_ANCHOR_IMAGE')),
    affiliate_url TEXT NOT NULL,
    url_fingerprint TEXT NOT NULL,
    product_name TEXT,
    product_note TEXT NOT NULL DEFAULT '',
    image_url TEXT,
    product_facts_json TEXT NOT NULL DEFAULT '[]',
    research_source_urls_json TEXT NOT NULL DEFAULT '[]',
    metadata_status TEXT NOT NULL CHECK(metadata_status IN ('PENDING','READY','INFORMATION_REQUIRED','FAILED')),
    research_verified INTEGER NOT NULL DEFAULT 0,
    sort_order INTEGER NOT NULL,
    status TEXT NOT NULL CHECK(status IN ('INFORMATION_REQUIRED','QUEUED','PROCESSING','PREVIEW_READY','REVIEW_REQUIRED','COMPLETED','FAILED')),
    attempt_count INTEGER NOT NULL DEFAULT 0,
    active_source_id TEXT REFERENCES sources(id) ON DELETE SET NULL,
    draft_post_id TEXT REFERENCES posts(id) ON DELETE SET NULL,
    active_run_id TEXT REFERENCES pipeline_runs(id) ON DELETE SET NULL,
    last_error TEXT,
    claimed_at TEXT,
    previewed_at TEXT,
    completed_at TEXT,
    researched_at TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    UNIQUE(account_id, url_fingerprint)
  );
  CREATE INDEX IF NOT EXISTS coupang_link_queue_next_idx
    ON coupang_link_queue(account_id, status, metadata_status, sort_order, created_at);
  `,
  `
  ALTER TABLE posts ADD COLUMN coupang_reply_body TEXT;
  ALTER TABLE posts ADD COLUMN coupang_reply_id TEXT;
  ALTER TABLE posts ADD COLUMN coupang_reply_status TEXT NOT NULL DEFAULT 'NONE';
  ALTER TABLE posts ADD COLUMN coupang_reply_error TEXT;
  ALTER TABLE posts ADD COLUMN coupang_reply_published_at TEXT;
  ALTER TABLE posts ADD COLUMN coupang_reply_deleted_at TEXT;
  CREATE UNIQUE INDEX IF NOT EXISTS posts_coupang_reply_id_idx ON posts(coupang_reply_id) WHERE coupang_reply_id IS NOT NULL;
  CREATE INDEX IF NOT EXISTS posts_coupang_reply_status_idx ON posts(account_id, coupang_reply_status, published_at DESC);
  `,
  `
  ALTER TABLE coupang_link_queue ADD COLUMN image_urls_json TEXT NOT NULL DEFAULT '[]';
  ALTER TABLE coupang_link_queue ADD COLUMN media_json TEXT NOT NULL DEFAULT '[]';
  ALTER TABLE coupang_link_queue ADD COLUMN review_evidence_json TEXT NOT NULL DEFAULT '[]';
  ALTER TABLE coupang_link_queue ADD COLUMN research_version INTEGER NOT NULL DEFAULT 1;
  ALTER TABLE coupang_link_queue ADD COLUMN review_count INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE coupang_link_queue ADD COLUMN review_collected_at TEXT;

  ALTER TABLE posts ADD COLUMN image_urls_json TEXT NOT NULL DEFAULT '[]';
  ALTER TABLE posts ADD COLUMN media_json TEXT NOT NULL DEFAULT '[]';
  `,
  `
  ALTER TABLE accounts ADD COLUMN daily_keyword_search_enabled INTEGER NOT NULL DEFAULT 0;
  `,
  `
  ALTER TABLE accounts DROP COLUMN daily_keyword_search_enabled;
  `,
  `
  ALTER TABLE coupang_link_queue ADD COLUMN provider_type TEXT NOT NULL DEFAULT 'COUPANG'
    CHECK(provider_type IN ('COUPANG','NAVER_BRAND_CONNECT'));
  CREATE INDEX IF NOT EXISTS product_link_queue_provider_idx
    ON coupang_link_queue(account_id, provider_type, status, metadata_status, sort_order, created_at);
  `,
  `
  CREATE TABLE IF NOT EXISTS affiliate_performance_daily (
    account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    performance_date TEXT NOT NULL,
    sub_id TEXT NOT NULL DEFAULT '',
    clicks INTEGER NOT NULL DEFAULT 0,
    orders INTEGER NOT NULL DEFAULT 0,
    order_amount REAL NOT NULL DEFAULT 0,
    revenue REAL NOT NULL DEFAULT 0,
    collected_at TEXT NOT NULL,
    PRIMARY KEY(account_id,performance_date,sub_id)
  );
  CREATE INDEX IF NOT EXISTS affiliate_performance_daily_range_idx
    ON affiliate_performance_daily(account_id,performance_date);
  `,
  `
  CREATE TABLE IF NOT EXISTS affiliate_performance_by_key (
    credential_fingerprint TEXT NOT NULL,
    key_label TEXT NOT NULL,
    performance_date TEXT NOT NULL,
    clicks INTEGER NOT NULL DEFAULT 0,
    orders INTEGER NOT NULL DEFAULT 0,
    order_amount REAL NOT NULL DEFAULT 0,
    revenue REAL NOT NULL DEFAULT 0,
    collected_at TEXT NOT NULL,
    PRIMARY KEY(credential_fingerprint,performance_date)
  );
  CREATE INDEX IF NOT EXISTS affiliate_performance_by_key_range_idx
    ON affiliate_performance_by_key(credential_fingerprint,performance_date);
  `,
  `ALTER TABLE accounts ADD COLUMN threads_token_check_failed_at TEXT;`,
];

export class AppDatabase {
  readonly raw: Database.Database;

  constructor(filePath: string) {
    this.raw = new Database(filePath);
    // 이 앱은 single-instance로만 DB를 연다. WAL은 실행 중 파일 교체·백업 시
    // 본체와 WAL이 갈라져 서로 다른 데이터를 보는 원인이 될 수 있으므로,
    // 완결된 단일 DB 파일을 유지하는 DELETE 저널을 사용한다.
    this.raw.pragma('journal_mode = DELETE');
    this.raw.pragma('busy_timeout = 5000');
    this.raw.pragma('foreign_keys = ON');
    const integrity = this.raw.pragma('integrity_check') as Array<Record<string, unknown>>;
    if (integrity.length !== 1 || integrity[0]?.integrity_check !== 'ok') {
      this.raw.close();
      throw new Error('SQLite 데이터베이스 무결성 검사에 실패했습니다. 백업 DB를 복원해야 합니다.');
    }
    this.migrate();
    this.raw.prepare(`UPDATE coupang_link_queue
      SET status='REVIEW_REQUIRED',last_error='이전 실행이 중단되어 처리 결과 확인이 필요합니다.',updated_at=?
      WHERE status='PROCESSING'`).run(new Date().toISOString());
    this.raw.prepare("UPDATE jobs SET status='FAILED', last_error='이전 실행 중 앱이 종료되어 중복 방지를 위해 자동 재시도하지 않습니다.', updated_at=? WHERE status='RUNNING'")
      .run(new Date().toISOString());
    this.raw.prepare("UPDATE pipeline_runs SET status='STOPPED', stage='DONE', progress=100, message='앱 종료로 작업이 중단되었습니다.', error_summary='이전 실행 중 앱이 종료되어 작업 상태를 중단으로 복구했습니다.', updated_at=?, finished_at=? WHERE status IN ('RUNNING','QUEUED')")
      .run(new Date().toISOString(), new Date().toISOString());
    this.raw.prepare("UPDATE threads_integration_runs SET status='CLEANUP_NEEDED', cleanup_needed=1, stage='RECOVERY', message='이전 실행이 중단되어 원격 테스트 항목 확인이 필요합니다.', error_summary='앱 종료로 통합 테스트가 중단되었습니다.', updated_at=? WHERE status='RUNNING'")
      .run(new Date().toISOString());
  }

  private migrate(): void {
    this.raw.exec('CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)');
    const applied = new Set(
      this.raw.prepare('SELECT version FROM schema_migrations').all().map((row: any) => row.version as number),
    );
    const apply = this.raw.transaction((version: number, sql: string) => {
      this.raw.exec(sql);
      this.raw.prepare('INSERT INTO schema_migrations(version, applied_at) VALUES (?, ?)').run(version, new Date().toISOString());
    });
    migrations.forEach((sql, index) => {
      const version = index + 1;
      if (!applied.has(version)) apply(version, sql);
    });
  }

  close(): void {
    this.raw.close();
  }
}
