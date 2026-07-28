import { DurableObject } from "cloudflare:workers";

const DAY_MS = 86_400_000;
const LEASE_MS = 15 * 60_000;

function quotaKeys(now = Date.now()) {
  const kst = new Date(now + 9 * 60 * 60_000);
  const day = kst.toISOString().slice(0, 10);
  const weekday = (kst.getUTCDay() + 6) % 7;
  const monday = new Date(kst.getTime() - weekday * DAY_MS).toISOString().slice(0, 10);
  return { day, week: monday };
}

export class ImageQuota extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    ctx.blockConcurrencyWhile(async () => {
      this.ctx.storage.sql.exec(`
        CREATE TABLE IF NOT EXISTS quota (
          bucket TEXT PRIMARY KEY,
          units INTEGER NOT NULL
        );
        CREATE TABLE IF NOT EXISTS counters (
          key TEXT PRIMARY KEY,
          value INTEGER NOT NULL
        );
        CREATE TABLE IF NOT EXISTS prompt_presets (
          id TEXT PRIMARY KEY,
          name TEXT NOT NULL,
          spec TEXT NOT NULL,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL
        );
      `);
    });
  }

  reserve(units) {
    const { day, week } = quotaKeys();
    const dailyKey = `day:${day}`;
    const weeklyKey = `week:${week}`;
    const daily = this.#units(dailyKey);
    const weekly = this.#units(weeklyKey);
    const queued = this.#counter("queued");
    const running = this.#counter("running");
    if (daily + units > 100) return { ok: false, reason: "daily_quota", daily, weekly, queued, running };
    if (weekly + units > 500) return { ok: false, reason: "weekly_quota", daily, weekly, queued, running };
    if (queued >= 4) return { ok: false, reason: "queue_limit", daily, weekly, queued, running };
    this.ctx.storage.sql.exec(
      "INSERT INTO quota(bucket, units) VALUES (?, ?) ON CONFLICT(bucket) DO UPDATE SET units = units + excluded.units",
      dailyKey,
      units
    );
    this.ctx.storage.sql.exec(
      "INSERT INTO quota(bucket, units) VALUES (?, ?) ON CONFLICT(bucket) DO UPDATE SET units = units + excluded.units",
      weeklyKey,
      units
    );
    this.#changeCounter("queued", 1);
    return {
      ok: true,
      daily: daily + units,
      weekly: weekly + units,
      queued: queued + 1,
      running,
      dayKey: dailyKey,
      weekKey: weeklyKey
    };
  }

  markRunning() {
    if (this.#counter("running") >= 1) return { ok: false, reason: "already_running" };
    this.#changeCounter("queued", -1);
    this.#changeCounter("running", 1);
    return { ok: true };
  }

  finish() {
    this.#changeCounter("running", -1);
    return { ok: true };
  }

  requeue() {
    this.#changeCounter("running", -1);
    this.#changeCounter("queued", 1);
    return { ok: true };
  }

  release(units, state = "queued", dayKey = null, weekKey = null) {
    const { day, week } = quotaKeys();
    this.#changeUnits(dayKey ?? `day:${day}`, -units);
    this.#changeUnits(weekKey ?? `week:${week}`, -units);
    this.#changeCounter(state, -1);
    return { ok: true };
  }

  status() {
    const { day, week } = quotaKeys();
    return {
      dailyUnits: this.#units(`day:${day}`),
      weeklyUnits: this.#units(`week:${week}`),
      queued: this.#counter("queued"),
      running: this.#counter("running")
    };
  }

  listPresets() {
    return this.ctx.storage.sql.exec(
      "SELECT id, name, spec, created_at, updated_at FROM prompt_presets ORDER BY updated_at DESC"
    ).toArray().map((row) => ({
      id: row.id,
      name: row.name,
      spec: JSON.parse(row.spec),
      createdAt: new Date(row.created_at).toISOString(),
      updatedAt: new Date(row.updated_at).toISOString()
    }));
  }

  savePreset(preset) {
    const existing = this.ctx.storage.sql.exec(
      "SELECT id FROM prompt_presets WHERE id = ?",
      preset.id
    ).toArray()[0];
    if (!existing) {
      const count = this.ctx.storage.sql.exec(
        "SELECT COUNT(*) AS count FROM prompt_presets"
      ).toArray()[0].count;
      if (count >= 50) return { ok: false, reason: "preset_limit" };
    }
    const now = Date.now();
    this.ctx.storage.sql.exec(
      `INSERT INTO prompt_presets(id, name, spec, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET name = excluded.name,
       spec = excluded.spec, updated_at = excluded.updated_at`,
      preset.id,
      preset.name,
      JSON.stringify(preset.spec),
      now,
      now
    );
    return { ok: true, id: preset.id };
  }

  deletePreset(id) {
    this.ctx.storage.sql.exec("DELETE FROM prompt_presets WHERE id = ?", id);
    return { ok: true };
  }

  #units(key) {
    return this.ctx.storage.sql.exec("SELECT units FROM quota WHERE bucket = ?", key).toArray()[0]?.units ?? 0;
  }

  #counter(key) {
    return this.ctx.storage.sql.exec("SELECT value FROM counters WHERE key = ?", key).toArray()[0]?.value ?? 0;
  }

  #changeUnits(key, delta) {
    this.ctx.storage.sql.exec(
      `INSERT INTO quota(bucket, units) VALUES (?, MAX(0, ?))
       ON CONFLICT(bucket) DO UPDATE SET units = MAX(0, units + ?)`,
      key,
      delta,
      delta
    );
  }

  #changeCounter(key, delta) {
    this.ctx.storage.sql.exec(
      `INSERT INTO counters(key, value) VALUES (?, MAX(0, ?))
       ON CONFLICT(key) DO UPDATE SET value = MAX(0, value + ?)`,
      key,
      delta,
      delta
    );
  }
}

export class ImageQueue extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    ctx.blockConcurrencyWhile(async () => {
      this.ctx.storage.sql.exec(`
        CREATE TABLE IF NOT EXISTS jobs (
          id TEXT PRIMARY KEY,
          account_id TEXT NOT NULL,
          status TEXT NOT NULL,
          cost_units INTEGER NOT NULL,
          quota_day_key TEXT NOT NULL,
          quota_week_key TEXT NOT NULL,
          spec TEXT NOT NULL,
          input_key TEXT,
          output_key TEXT,
          output_type TEXT,
          error_code TEXT,
          saved_gallery INTEGER NOT NULL DEFAULT 0,
          pinned_history INTEGER NOT NULL DEFAULT 0,
          lease_token TEXT,
          lease_until INTEGER,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS jobs_status_created
          ON jobs(status, created_at);
        CREATE TABLE IF NOT EXISTS runtime (
          key TEXT PRIMARY KEY,
          value INTEGER NOT NULL
        );
      `);
    });
  }

  enqueue(job) {
    const now = Date.now();
    this.ctx.storage.sql.exec(
      `INSERT INTO jobs(
        id, account_id, status, cost_units, quota_day_key, quota_week_key,
        spec, input_key, created_at, updated_at
      ) VALUES (?, ?, 'queued', ?, ?, ?, ?, ?, ?, ?)`,
      job.id,
      job.accountId,
      job.costUnits,
      job.quotaDayKey,
      job.quotaWeekKey,
      JSON.stringify(job.spec),
      job.inputKey ?? null,
      now,
      now
    );
    return { ok: true, id: job.id };
  }

  async lease() {
    const now = Date.now();
    this.ctx.storage.sql.exec(
      "INSERT INTO runtime(key, value) VALUES ('gpu_last_seen', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
      now
    );
    await this.#expireLeases(now);
    const row = this.ctx.storage.sql.exec(
      "SELECT * FROM jobs WHERE status = 'queued' ORDER BY created_at ASC LIMIT 1"
    ).toArray()[0];
    if (!row) return null;
    const token = crypto.randomUUID();
    const leaseUntil = now + LEASE_MS;
    this.ctx.storage.sql.exec(
      `UPDATE jobs SET status = 'running', lease_token = ?, lease_until = ?, updated_at = ?
       WHERE id = ? AND status = 'queued'`,
      token,
      leaseUntil,
      now,
      row.id
    );
    await this.ctx.storage.setAlarm(leaseUntil);
    return {
      id: row.id,
      accountId: row.account_id,
      costUnits: row.cost_units,
      quotaDayKey: row.quota_day_key,
      quotaWeekKey: row.quota_week_key,
      spec: JSON.parse(row.spec),
      hasInput: Boolean(row.input_key),
      leaseToken: token,
      leaseUntil
    };
  }

  get(jobId, accountId = null) {
    const row = this.ctx.storage.sql.exec("SELECT * FROM jobs WHERE id = ?", jobId).toArray()[0];
    if (!row || (accountId && row.account_id !== accountId)) return null;
    const position = row.status === "queued"
      ? this.ctx.storage.sql.exec(
          "SELECT COUNT(*) AS count FROM jobs WHERE status = 'queued' AND created_at < ?",
          row.created_at
        ).toArray()[0].count + 1
      : null;
    return this.#publicJob(row, position);
  }

  list(accountId, kind = "history") {
    const rows = kind === "gallery"
      ? this.ctx.storage.sql.exec(
          `SELECT * FROM jobs WHERE account_id = ? AND saved_gallery = 1
           AND status = 'completed' ORDER BY created_at DESC LIMIT 15`,
          accountId
        ).toArray()
      : this.ctx.storage.sql.exec(
          `SELECT * FROM jobs WHERE account_id = ? AND
           (created_at >= ? OR pinned_history = 1)
           ORDER BY created_at DESC LIMIT 100`,
          accountId,
          Date.now() - 7 * DAY_MS
        ).toArray();
    return rows.map((row) => ({
      ...this.#publicJob(row, null),
      saved: Boolean(row.saved_gallery),
      pinned: Boolean(row.pinned_history)
    }));
  }

  setCollection(jobId, accountId, collection, enabled) {
    const column = collection === "gallery"
      ? "saved_gallery"
      : collection === "history"
        ? "pinned_history"
        : null;
    if (!column) return { ok: false, reason: "invalid_collection" };
    const limit = collection === "gallery" ? 15 : 10;
    const row = this.ctx.storage.sql.exec(
      "SELECT status FROM jobs WHERE id = ? AND account_id = ?",
      jobId,
      accountId
    ).toArray()[0];
    if (!row || row.status !== "completed") return { ok: false, reason: "job_not_found" };
    if (enabled) {
      const count = this.ctx.storage.sql.exec(
        `SELECT COUNT(*) AS count FROM jobs WHERE account_id = ? AND ${column} = 1`,
        accountId
      ).toArray()[0].count;
      if (count >= limit) return { ok: false, reason: "collection_limit" };
    }
    this.ctx.storage.sql.exec(
      `UPDATE jobs SET ${column} = ?, updated_at = ? WHERE id = ? AND account_id = ?`,
      enabled ? 1 : 0,
      Date.now(),
      jobId,
      accountId
    );
    return { ok: true };
  }

  cleanup(now = Date.now()) {
    const imageCutoff = now - 30 * DAY_MS;
    const stale = this.ctx.storage.sql.exec(
      `SELECT id, output_key FROM jobs WHERE output_key IS NOT NULL
       AND created_at < ? AND saved_gallery = 0 AND pinned_history = 0 LIMIT 100`,
      imageCutoff
    ).toArray();
    for (const row of stale) {
      this.ctx.storage.sql.exec(
        "UPDATE jobs SET output_key = NULL, updated_at = ? WHERE id = ?",
        now,
        row.id
      );
    }
    this.ctx.storage.sql.exec(
      `DELETE FROM jobs WHERE created_at < ? AND output_key IS NULL
       AND saved_gallery = 0 AND pinned_history = 0`,
      imageCutoff
    );
    return stale.map((row) => row.output_key);
  }

  stats() {
    const counts = Object.fromEntries(
      this.ctx.storage.sql.exec(
        "SELECT status, COUNT(*) AS count FROM jobs GROUP BY status"
      ).toArray().map((row) => [row.status, row.count])
    );
    const oldest = this.ctx.storage.sql.exec(
      "SELECT created_at FROM jobs WHERE status = 'queued' ORDER BY created_at LIMIT 1"
    ).toArray()[0]?.created_at ?? null;
    const lastSeen = this.ctx.storage.sql.exec(
      "SELECT value FROM runtime WHERE key = 'gpu_last_seen'"
    ).toArray()[0]?.value ?? null;
    return {
      counts,
      oldestQueuedAt: oldest ? new Date(oldest).toISOString() : null,
      gpuLastSeenAt: lastSeen ? new Date(lastSeen).toISOString() : null,
      gpuOnline: Boolean(lastSeen && Date.now() - lastSeen < 30_000)
    };
  }

  inputKey(jobId, leaseToken) {
    const row = this.#leased(jobId, leaseToken);
    return row?.input_key ?? null;
  }

  resultTarget(jobId, leaseToken) {
    const row = this.#leased(jobId, leaseToken);
    return row ? { accountId: row.account_id } : null;
  }

  complete(jobId, leaseToken, outputKey, outputType) {
    const row = this.#leased(jobId, leaseToken);
    if (!row) return null;
    this.ctx.storage.sql.exec(
      `UPDATE jobs SET status = 'completed', output_key = ?, output_type = ?,
       lease_token = NULL, lease_until = NULL, updated_at = ? WHERE id = ?`,
      outputKey,
      outputType,
      Date.now(),
      jobId
    );
    return {
      accountId: row.account_id,
      costUnits: row.cost_units,
      inputKey: row.input_key,
      quotaDayKey: row.quota_day_key,
      quotaWeekKey: row.quota_week_key
    };
  }

  fail(jobId, leaseToken, errorCode) {
    const row = this.#leased(jobId, leaseToken);
    if (!row) return null;
    this.ctx.storage.sql.exec(
      `UPDATE jobs SET status = 'failed', error_code = ?, lease_token = NULL,
       lease_until = NULL, updated_at = ? WHERE id = ?`,
      errorCode,
      Date.now(),
      jobId
    );
    return {
      accountId: row.account_id,
      costUnits: row.cost_units,
      inputKey: row.input_key,
      quotaDayKey: row.quota_day_key,
      quotaWeekKey: row.quota_week_key
    };
  }

  async alarm() {
    await this.#expireLeases(Date.now());
  }

  #leased(jobId, leaseToken) {
    return this.ctx.storage.sql.exec(
      `SELECT * FROM jobs WHERE id = ? AND status = 'running'
       AND lease_token = ? AND lease_until > ?`,
      jobId,
      leaseToken,
      Date.now()
    ).toArray()[0] ?? null;
  }

  async #expireLeases(now) {
    const expired = this.ctx.storage.sql.exec(
      `SELECT account_id FROM jobs
       WHERE status = 'running' AND lease_until <= ?`,
      now
    ).toArray();
    this.ctx.storage.sql.exec(
      `UPDATE jobs SET status = 'queued', lease_token = NULL, lease_until = NULL,
       updated_at = ? WHERE status = 'running' AND lease_until <= ?`,
      now,
      now
    );
    for (const row of expired) {
      await this.env.IMAGE_QUOTA.getByName(`account:${row.account_id}`).requeue();
    }
    const next = this.ctx.storage.sql.exec(
      "SELECT MIN(lease_until) AS next_alarm FROM jobs WHERE status = 'running'"
    ).toArray()[0]?.next_alarm;
    if (next) await this.ctx.storage.setAlarm(next);
  }

  #publicJob(row, position) {
    return {
      id: row.id,
      status: row.status,
      position,
      errorCode: row.error_code,
      outputType: row.output_type,
      hasResult: Boolean(row.output_key),
      saved: Boolean(row.saved_gallery),
      pinned: Boolean(row.pinned_history),
      createdAt: new Date(row.created_at).toISOString(),
      updatedAt: new Date(row.updated_at).toISOString()
    };
  }
}
