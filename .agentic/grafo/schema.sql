-- Agentic KDD — Schema CoALA v3.0
-- SQLite — vive en .agentic/memoria.db
-- Arquitectura de memoria: Working | Episodic | Semantic | Procedural
-- Inspirado en: CoALA (arXiv:2309.02427), Mem0, agentmemory, MemGPT

-- ─── MEMORIA PROCEDURAL (lo que ya tenía KDD) ─────────────────────────────
-- Patrones, errores, decisiones — reglas y skills del proyecto
CREATE TABLE IF NOT EXISTS nodos (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tipo TEXT NOT NULL,        -- error | patron | decision | modulo | entidad
  titulo TEXT NOT NULL,
  contenido TEXT,
  area TEXT DEFAULT 'global',
  confianza TEXT DEFAULT 'BAJA',  -- BAJA | MEDIA | ALTA
  aplicado INTEGER DEFAULT 0,     -- cuántas veces se usó
  util INTEGER DEFAULT 0,         -- cuántas veces fue útil
  estado TEXT DEFAULT 'ACTIVO',   -- ACTIVO | OBSOLETO | CONSOLIDADO
  -- CoALA: decay temporal
  ultimo_acceso TEXT DEFAULT (datetime('now')),
  accesos_total INTEGER DEFAULT 0,
  decay_score REAL DEFAULT 1.0,   -- 1.0=máximo, decae con el tiempo sin uso
  -- Embeddings para búsqueda semántica (JSON array de floats, opcional)
  embedding TEXT,
  embedding_modelo TEXT,          -- qué modelo generó el embedding
  ultima_validacion TEXT DEFAULT (datetime('now')),
  fecha_creacion TEXT DEFAULT (datetime('now')),
  fecha_update TEXT DEFAULT (datetime('now'))
);

-- ─── MEMORIA EPISÓDICA ────────────────────────────────────────────────────
-- Trayectorias completas de lo que se intentó, en qué orden, resultado real
-- Crítico: NO summarizar al escribir (causa "summarization drift")
-- Registra la experiencia RAW, la consolidación ocurre después
CREATE TABLE IF NOT EXISTS episodios (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  episodio_id TEXT NOT NULL UNIQUE,
  -- Contexto del episodio
  ciclo_id TEXT,              -- FK a ciclos (si viene de un ciclo aa:)
  sesion_id TEXT,             -- agrupar episodios de una misma sesión de trabajo
  tipo TEXT DEFAULT 'accion', -- accion | decision | error | fix | aprendizaje
  -- Qué pasó exactamente (raw, sin summarizar)
  descripcion TEXT NOT NULL,  -- descripción detallada de lo que ocurrió
  intento_num INTEGER DEFAULT 1,   -- era el intento #N de resolver esto
  contexto_antes TEXT,        -- estado del proyecto antes
  accion_tomada TEXT,         -- qué se hizo exactamente
  resultado TEXT,             -- qué pasó (éxito | fallo | parcial)
  razon_resultado TEXT,       -- por qué pasó lo que pasó
  archivos_tocados TEXT DEFAULT '[]',  -- JSON array de archivos modificados
  -- Consolidación a memoria semántica/procedural
  consolidado INTEGER DEFAULT 0,  -- 0=raw, 1=ya extrajo patrones
  nodo_generado_id INTEGER,       -- FK a nodos si se consolidó en patrón
  -- Metadata
  area TEXT DEFAULT 'global',
  modulo TEXT DEFAULT 'global',
  relevancia REAL DEFAULT 1.0,    -- decae con el tiempo
  fecha TEXT DEFAULT (datetime('now')),
  FOREIGN KEY (nodo_generado_id) REFERENCES nodos(id)
);

-- ─── MEMORIA SEMÁNTICA ────────────────────────────────────────────────────
-- Grafo de entidades del proyecto: módulos, APIs, convenciones, dependencias
-- Extrae el "mapa" del proyecto para que el agente entienda impacto de cambios
CREATE TABLE IF NOT EXISTS entidades (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  nombre TEXT NOT NULL UNIQUE,
  tipo TEXT NOT NULL,    -- modulo | archivo | funcion | api | tabla | variable | concepto
  descripcion TEXT,
  area TEXT DEFAULT 'global',
  -- Qué sabe el sistema sobre esta entidad
  propiedades TEXT DEFAULT '{}',  -- JSON: {ruta, lenguaje, exporta, importa, etc.}
  embedding TEXT,                 -- para búsqueda semántica
  -- Métricas de actividad
  modificaciones INTEGER DEFAULT 0,  -- cuántas veces fue tocada
  errores_asociados INTEGER DEFAULT 0,
  critica INTEGER DEFAULT 0,      -- 1 si es una entidad crítica del sistema
  fecha_creacion TEXT DEFAULT (datetime('now')),
  fecha_update TEXT DEFAULT (datetime('now'))
);

-- Relaciones semánticas entre entidades (grafo de conocimiento del proyecto)
CREATE TABLE IF NOT EXISTS relaciones_semanticas (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  desde_entidad TEXT NOT NULL,  -- nombre de la entidad origen
  tipo TEXT NOT NULL,           -- depende_de | importa | usa | extiende | llama | define
  hacia_entidad TEXT NOT NULL,  -- nombre de la entidad destino
  peso REAL DEFAULT 1.0,        -- fuerza de la relación
  descripcion TEXT,             -- por qué existe esta relación
  fecha TEXT DEFAULT (datetime('now')),
  UNIQUE(desde_entidad, tipo, hacia_entidad)
);

-- ─── RELACIONES (memoria procedural — ya existía) ─────────────────────────
CREATE TABLE IF NOT EXISTS relaciones (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  desde_id INTEGER NOT NULL,
  tipo TEXT NOT NULL,  -- resuelto_por | origino | aplica_a | relacionado_con | contradice
  hacia_id INTEGER NOT NULL,
  peso REAL DEFAULT 1.0,
  fecha TEXT DEFAULT (datetime('now')),
  FOREIGN KEY (desde_id) REFERENCES nodos(id),
  FOREIGN KEY (hacia_id) REFERENCES nodos(id)
);

-- ─── CICLOS — observabilidad y métricas ───────────────────────────────────
CREATE TABLE IF NOT EXISTS ciclos (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ciclo_id TEXT NOT NULL UNIQUE,
  tarea TEXT NOT NULL,
  tipo_tarea TEXT DEFAULT 'feature',  -- feature | bugfix | refactor | docs | audit
  modulo TEXT DEFAULT 'global',
  area TEXT DEFAULT 'global',
  estado TEXT DEFAULT 'EN_PROGRESO',  -- EN_PROGRESO | COMPLETADO | STOP
  context_guard TEXT DEFAULT 'OK',
  fases_total INTEGER DEFAULT 0,
  fases_completadas INTEGER DEFAULT 0,
  patrones_aplicados TEXT DEFAULT '[]',
  errores_evitados TEXT DEFAULT '[]',
  decisiones_usadas TEXT DEFAULT '[]',
  memory_trace TEXT DEFAULT '[]',     -- qué consultó el Analista
  tests_generados INTEGER DEFAULT 0,
  tests_pasando INTEGER DEFAULT 0,
  review_blockers INTEGER DEFAULT 0,
  review_required INTEGER DEFAULT 0,
  stops_count INTEGER DEFAULT 0,
  sync_grafo INTEGER DEFAULT 0,
  duracion_ms INTEGER DEFAULT 0,
  snapshot_inicio TEXT,   -- JSON: estado de memoria al inicio
  snapshot_fin TEXT,      -- JSON: estado de memoria al final
  fecha_inicio TEXT DEFAULT (datetime('now')),
  fecha_fin TEXT
);

-- ─── FASES — tracing detallado ────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS fases (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ciclo_id TEXT NOT NULL,
  fase_num INTEGER NOT NULL,
  fase_nombre TEXT,
  agente TEXT,
  estado TEXT DEFAULT 'EN_PROGRESO',
  memoria_leida TEXT DEFAULT '[]',
  decision_tomada TEXT,
  resultado TEXT,
  intentos INTEGER DEFAULT 1,
  duracion_ms INTEGER DEFAULT 0,
  tokens_aprox INTEGER DEFAULT 0,
  fecha_inicio TEXT DEFAULT (datetime('now')),
  fecha_fin TEXT,
  FOREIGN KEY (ciclo_id) REFERENCES ciclos(ciclo_id)
);

-- ─── WORKING MEMORY — contexto activo de la sesión ────────────────────────
-- Buffer temporal que se vacía al inicio de cada sesión nueva
-- Equivale al "context window estructurado" de CoALA
CREATE TABLE IF NOT EXISTS working_memory (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  sesion_id TEXT NOT NULL,
  tipo TEXT NOT NULL,       -- observacion | razonamiento | plan | resultado
  contenido TEXT NOT NULL,
  relevancia REAL DEFAULT 1.0,
  expirado INTEGER DEFAULT 0,  -- 1 si ya fue consolidado o expiró
  fecha TEXT DEFAULT (datetime('now'))
);

-- ─── ÍNDICES OPTIMIZADOS ──────────────────────────────────────────────────
-- Nodos (procedural)
CREATE UNIQUE INDEX IF NOT EXISTS idx_nodos_unique ON nodos(tipo, titulo);
CREATE INDEX IF NOT EXISTS idx_nodos_area_tipo ON nodos(area, tipo);
CREATE INDEX IF NOT EXISTS idx_nodos_area_confianza ON nodos(area, confianza);
CREATE INDEX IF NOT EXISTS idx_nodos_tipo_confianza ON nodos(tipo, confianza);
CREATE INDEX IF NOT EXISTS idx_nodos_tipo_estado ON nodos(tipo, estado);
CREATE INDEX IF NOT EXISTS idx_nodos_area_tipo_estado ON nodos(area, tipo, estado);
CREATE INDEX IF NOT EXISTS idx_nodos_confianza_aplicado ON nodos(confianza, aplicado);
CREATE INDEX IF NOT EXISTS idx_nodos_decay ON nodos(decay_score, confianza);

-- Episódica
CREATE INDEX IF NOT EXISTS idx_episodios_ciclo ON episodios(ciclo_id);
CREATE INDEX IF NOT EXISTS idx_episodios_sesion ON episodios(sesion_id);
CREATE INDEX IF NOT EXISTS idx_episodios_tipo ON episodios(tipo);
CREATE INDEX IF NOT EXISTS idx_episodios_area ON episodios(area);
CREATE INDEX IF NOT EXISTS idx_episodios_consolidado ON episodios(consolidado);
CREATE INDEX IF NOT EXISTS idx_episodios_fecha ON episodios(fecha);

-- Semántica
CREATE INDEX IF NOT EXISTS idx_entidades_tipo ON entidades(tipo);
CREATE INDEX IF NOT EXISTS idx_entidades_area ON entidades(area);
CREATE INDEX IF NOT EXISTS idx_rel_semanticas_desde ON relaciones_semanticas(desde_entidad);
CREATE INDEX IF NOT EXISTS idx_rel_semanticas_hacia ON relaciones_semanticas(hacia_entidad);

-- Ciclos y fases
CREATE UNIQUE INDEX IF NOT EXISTS idx_ciclos_unique ON ciclos(ciclo_id);
CREATE INDEX IF NOT EXISTS idx_ciclos_estado ON ciclos(estado);
CREATE INDEX IF NOT EXISTS idx_ciclos_modulo ON ciclos(modulo);
CREATE INDEX IF NOT EXISTS idx_ciclos_fecha ON ciclos(fecha_inicio);
CREATE INDEX IF NOT EXISTS idx_fases_ciclo ON fases(ciclo_id);
CREATE INDEX IF NOT EXISTS idx_fases_agente ON fases(agente);

-- Working memory
CREATE INDEX IF NOT EXISTS idx_working_sesion ON working_memory(sesion_id);
CREATE INDEX IF NOT EXISTS idx_working_expirado ON working_memory(expirado);

-- Relaciones
CREATE UNIQUE INDEX IF NOT EXISTS idx_rel_unique ON relaciones(desde_id, tipo, hacia_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_rel_sem_unique ON relaciones_semanticas(desde_entidad, tipo, hacia_entidad);
-- Agentic KDD — Schema CoALA v3.1 (v2.2)
-- Agrega soporte para embeddings locales, git context y CI/CD
-- Compatible con schema v3.0 — migrations automáticas en migrateDB()

-- ─── MIGRACIÓN v2.2: embedding en episodios ──────────────────────────────────
-- ALTER TABLE episodios ADD COLUMN embedding TEXT;  (via migrateDB)

-- ─── GIT CONTEXT LOG ─────────────────────────────────────────────────────────
-- Historial de análisis git — qué se detectó en cada sync
CREATE TABLE IF NOT EXISTS git_context_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  sesion_id TEXT NOT NULL,
  rama TEXT,
  commit_hash TEXT,
  archivos_modificados TEXT DEFAULT '[]',    -- JSON array
  riesgos_detectados TEXT DEFAULT '[]',      -- JSON array de riesgos
  predicciones TEXT DEFAULT '[]',            -- JSON array de predicciones
  tiene_riesgos_altos INTEGER DEFAULT 0,
  fecha TEXT DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_git_context_fecha ON git_context_log(fecha);
CREATE INDEX IF NOT EXISTS idx_git_context_rama ON git_context_log(rama);

-- ─── CI/CD REPORTS ───────────────────────────────────────────────────────────
-- Los episodios CI se guardan en la tabla episodios con area='ci-cd'
-- Esta tabla guarda metadata adicional del run
CREATE TABLE IF NOT EXISTS cicd_reports (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  episodio_id TEXT,                          -- FK a episodios
  plataforma TEXT DEFAULT 'github',          -- github | gitlab | bitbucket | jenkins
  workflow TEXT,
  rama TEXT,
  commit_hash TEXT,
  actor TEXT,
  repo TEXT,
  run_id TEXT,
  run_url TEXT,
  tests_pasando INTEGER DEFAULT 0,
  tests_fallando INTEGER DEFAULT 0,
  archivos_tocados TEXT DEFAULT '[]',
  errores_tests TEXT DEFAULT '[]',           -- JSON array de tests fallidos
  es_exito INTEGER DEFAULT 0,
  fecha TEXT DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_cicd_fecha ON cicd_reports(fecha);
CREATE INDEX IF NOT EXISTS idx_cicd_rama ON cicd_reports(rama);
CREATE INDEX IF NOT EXISTS idx_cicd_exito ON cicd_reports(es_exito);

-- ─── PREDICTION LOG ──────────────────────────────────────────────────────────
-- Registro de predicciones y si fueron correctas (para mejorar precisión)
CREATE TABLE IF NOT EXISTS prediction_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tarea TEXT,
  modulo TEXT,
  archivos TEXT DEFAULT '[]',
  nivel_predicho TEXT,                       -- ALTO | MEDIO | BAJO
  alertas TEXT DEFAULT '[]',
  precondiciones TEXT DEFAULT '[]',
  fue_correcto INTEGER,                      -- NULL=no evaluado, 1=correcto, 0=incorrecto
  ciclo_id TEXT,
  fecha TEXT DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_prediction_fecha ON prediction_log(fecha);
CREATE INDEX IF NOT EXISTS idx_prediction_correcto ON prediction_log(fue_correcto);
