'use strict';
/**
 * DDL de las tablas que 3.20.1 añade para memoria con evidencia, cola durable,
 * compresión recuperable y paquetes TEAMS. Es la ÚNICA fuente: el generador del
 * catálogo (gen-schema-catalog.cjs) lo vuelca a schema-catalog.data.json y desde
 * ahí lo aplican `akdd update`, `akdd init` y `schema-columns fix`.
 *
 * Reglas del diseño (docs C01/C02/H01/H02):
 *   · Solo tablas e índices NUEVOS: nada altera una tabla anterior ni sus IDs.
 *   · Sin defaults dinámicos (datetime('now')): las fechas las escribe el código.
 *   · node_id es TEXT: los nodos históricos tienen id INTEGER o TEXT y no se tocan.
 *   · Ningún dato de cliente viaja en el paquete: son estructuras vacías.
 */
const T = {
  mem_project: {
    create: `CREATE TABLE IF NOT EXISTS mem_project (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  project_id TEXT NOT NULL,
  canonical_root TEXT NOT NULL,
  created_at TEXT NOT NULL,
  origin TEXT NOT NULL DEFAULT 'created',
  previous_ids TEXT
)`,
    indexes: [],
  },
  mem_events: {
    create: `CREATE TABLE IF NOT EXISTS mem_events (
  event_id TEXT PRIMARY KEY,
  schema_version INTEGER NOT NULL DEFAULT 1,
  project_id TEXT NOT NULL,
  canonical_project_root TEXT NOT NULL,
  session_id TEXT NOT NULL,
  task_id TEXT,
  cycle_id TEXT,
  host TEXT NOT NULL,
  role TEXT,
  host_event_id TEXT NOT NULL,
  event_type TEXT NOT NULL,
  sequence INTEGER NOT NULL DEFAULT 0,
  occurred_at TEXT NOT NULL,
  received_at TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'CAPTURED',
  paths TEXT,
  input_summary TEXT,
  output_summary TEXT,
  evidence_refs TEXT,
  redaction_version TEXT NOT NULL,
  privacy_class TEXT NOT NULL DEFAULT 'redacted',
  attempts INTEGER NOT NULL DEFAULT 1,
  UNIQUE (project_id, host, session_id, host_event_id)
)`,
    indexes: [
      'CREATE INDEX IF NOT EXISTS idx_mem_events_time ON mem_events (project_id, occurred_at, sequence)',
      'CREATE INDEX IF NOT EXISTS idx_mem_events_task ON mem_events (project_id, task_id, sequence)',
    ],
  },
  mem_observations: {
    create: `CREATE TABLE IF NOT EXISTS mem_observations (
  observation_id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  task_id TEXT,
  kind TEXT NOT NULL,
  summary TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'CAPTURED',
  dedupe_key TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  processor TEXT,
  error_code TEXT
)`,
    indexes: [
      'CREATE INDEX IF NOT EXISTS idx_mem_obs_status ON mem_observations (project_id, status)',
      'CREATE INDEX IF NOT EXISTS idx_mem_obs_dedupe ON mem_observations (project_id, dedupe_key)',
    ],
  },
  mem_observation_events: {
    create: `CREATE TABLE IF NOT EXISTS mem_observation_events (
  observation_id TEXT NOT NULL,
  event_id TEXT NOT NULL,
  PRIMARY KEY (observation_id, event_id)
)`,
    indexes: ['CREATE INDEX IF NOT EXISTS idx_mem_obs_events_event ON mem_observation_events (event_id)'],
  },
  mem_knowledge: {
    create: `CREATE TABLE IF NOT EXISTS mem_knowledge (
  node_id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'PROPOSED',
  provenance TEXT NOT NULL DEFAULT 'OBSERVED',
  scope TEXT,
  content_key TEXT,
  occurrences INTEGER NOT NULL DEFAULT 1,
  validated_at TEXT,
  validated_by TEXT,
  stale_since TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
)`,
    indexes: [
      'CREATE INDEX IF NOT EXISTS idx_mem_knowledge_state ON mem_knowledge (project_id, state)',
      'CREATE INDEX IF NOT EXISTS idx_mem_knowledge_key ON mem_knowledge (project_id, content_key)',
    ],
  },
  mem_provenance: {
    create: `CREATE TABLE IF NOT EXISTS mem_provenance (
  provenance_id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id TEXT NOT NULL,
  node_id TEXT NOT NULL,
  relation TEXT NOT NULL,
  observation_id TEXT NOT NULL DEFAULT '',
  event_id TEXT NOT NULL DEFAULT '',
  evidence_id TEXT NOT NULL DEFAULT '',
  related_node_id TEXT NOT NULL DEFAULT '',
  note TEXT,
  created_at TEXT NOT NULL,
  UNIQUE (project_id, node_id, relation, observation_id, event_id, evidence_id, related_node_id)
)`,
    indexes: [
      'CREATE INDEX IF NOT EXISTS idx_mem_prov_node ON mem_provenance (project_id, node_id)',
      'CREATE INDEX IF NOT EXISTS idx_mem_prov_event ON mem_provenance (event_id)',
    ],
  },
  mem_evidence: {
    create: `CREATE TABLE IF NOT EXISTS mem_evidence (
  evidence_id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  store TEXT NOT NULL,
  locator TEXT NOT NULL,
  sha256 TEXT NOT NULL,
  bytes INTEGER NOT NULL,
  content_type TEXT,
  scope TEXT,
  policy_id TEXT,
  privacy_class TEXT NOT NULL DEFAULT 'redacted',
  retention TEXT NOT NULL DEFAULT 'cache',
  status TEXT NOT NULL DEFAULT 'AVAILABLE',
  created_at TEXT NOT NULL,
  last_verified_at TEXT,
  last_accessed_at TEXT,
  expires_at TEXT
)`,
    indexes: [
      'CREATE INDEX IF NOT EXISTS idx_mem_evidence_hash ON mem_evidence (project_id, sha256)',
      'CREATE INDEX IF NOT EXISTS idx_mem_evidence_retention ON mem_evidence (retention, last_accessed_at)',
    ],
  },
  mem_evidence_pins: {
    create: `CREATE TABLE IF NOT EXISTS mem_evidence_pins (
  evidence_id TEXT NOT NULL,
  owner_kind TEXT NOT NULL,
  owner_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (evidence_id, owner_kind, owner_id)
)`,
    indexes: ['CREATE INDEX IF NOT EXISTS idx_mem_pins_owner ON mem_evidence_pins (owner_kind, owner_id)'],
  },
  mem_jobs: {
    create: `CREATE TABLE IF NOT EXISTS mem_jobs (
  job_id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'observe',
  state TEXT NOT NULL DEFAULT 'PENDING',
  required INTEGER NOT NULL DEFAULT 0,
  attempts INTEGER NOT NULL DEFAULT 0,
  max_attempts INTEGER NOT NULL DEFAULT 5,
  manual_retries INTEGER NOT NULL DEFAULT 0,
  next_attempt_at TEXT NOT NULL,
  lease_owner TEXT,
  lease_token INTEGER NOT NULL DEFAULT 0,
  lease_until TEXT,
  result_ref TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  error_code TEXT
)`,
    indexes: ['CREATE INDEX IF NOT EXISTS idx_mem_jobs_state ON mem_jobs (project_id, state, next_attempt_at)'],
  },
  mem_job_events: {
    create: `CREATE TABLE IF NOT EXISTS mem_job_events (
  job_id TEXT NOT NULL,
  event_id TEXT NOT NULL,
  PRIMARY KEY (job_id, event_id)
)`,
    indexes: ['CREATE INDEX IF NOT EXISTS idx_mem_job_events_event ON mem_job_events (event_id)'],
  },
  mem_compression_refs: {
    create: `CREATE TABLE IF NOT EXISTS mem_compression_refs (
  reference_id TEXT PRIMARY KEY,
  schema_version INTEGER NOT NULL DEFAULT 1,
  project_id TEXT NOT NULL,
  task_id TEXT,
  evidence_id TEXT NOT NULL,
  source_kind TEXT NOT NULL,
  source_hash TEXT NOT NULL,
  content_type TEXT NOT NULL,
  original_bytes INTEGER NOT NULL,
  delivered_bytes INTEGER NOT NULL,
  compression_method TEXT NOT NULL,
  complete INTEGER NOT NULL DEFAULT 0,
  retrieval_count INTEGER NOT NULL DEFAULT 0,
  recovered_bytes INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
)`,
    indexes: ['CREATE INDEX IF NOT EXISTS idx_mem_cref_task ON mem_compression_refs (project_id, task_id)'],
  },
  mem_context_usage: {
    create: `CREATE TABLE IF NOT EXISTS mem_context_usage (
  usage_id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id TEXT NOT NULL,
  task_id TEXT NOT NULL,
  sprint_id TEXT,
  role TEXT,
  kind TEXT NOT NULL,
  original_bytes INTEGER NOT NULL DEFAULT 0,
  delivered_bytes INTEGER NOT NULL DEFAULT 0,
  recovered_bytes INTEGER NOT NULL DEFAULT 0,
  measure TEXT NOT NULL DEFAULT 'estimated_bytes4',
  tokens_original INTEGER,
  tokens_delivered INTEGER,
  latency_ms INTEGER,
  observed INTEGER NOT NULL DEFAULT 1,
  detail TEXT,
  created_at TEXT NOT NULL
)`,
    indexes: ['CREATE INDEX IF NOT EXISTS idx_mem_usage_task ON mem_context_usage (project_id, task_id, kind)'],
  },
  mem_context_packets: {
    create: `CREATE TABLE IF NOT EXISTS mem_context_packets (
  packet_id TEXT PRIMARY KEY,
  schema_version INTEGER NOT NULL DEFAULT 1,
  project_id TEXT NOT NULL,
  plan_id TEXT,
  sprint_id TEXT,
  task_id TEXT NOT NULL,
  sender_role TEXT NOT NULL,
  recipient_role TEXT NOT NULL,
  revision INTEGER NOT NULL,
  base_revision INTEGER,
  kind TEXT NOT NULL DEFAULT 'snapshot',
  body TEXT NOT NULL,
  body_hash TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'SENT',
  acked_revision INTEGER,
  acked_hash TEXT,
  acked_at TEXT,
  created_at TEXT NOT NULL,
  UNIQUE (project_id, task_id, recipient_role, revision)
)`,
    indexes: ['CREATE INDEX IF NOT EXISTS idx_mem_packets_task ON mem_context_packets (project_id, task_id, recipient_role, revision)'],
  },
  mem_health: {
    create: `CREATE TABLE IF NOT EXISTS mem_health (
  check_name TEXT NOT NULL,
  scope TEXT NOT NULL DEFAULT 'project',
  status TEXT NOT NULL,
  detail TEXT,
  source TEXT NOT NULL,
  checked_at TEXT NOT NULL,
  expires_at TEXT,
  PRIMARY KEY (check_name, scope)
)`,
    indexes: [],
  },
};

module.exports = { TABLAS_3_20_1: T, SINCE: '3.20.1' };
