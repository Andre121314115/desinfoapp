import Database from "better-sqlite3";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const dbPath = path.join(__dirname, "data", "desinfo.db");
const db = new Database(dbPath);

// Crear tablas si no existen
db.exec(`
CREATE TABLE IF NOT EXISTS analyses (
  id INTEGER PRIMARY KEY,
  source TEXT,
  title TEXT,
  body TEXT,
  score INTEGER,
  verdict TEXT,
  labels_json TEXT,
  rationale TEXT,
  evidence_json TEXT,
  explanation TEXT,
  gemini_score INTEGER,
  ml_score INTEGER,
  ml_verdict TEXT,
  model TEXT,
  latency_ms INTEGER,
  combination_flags_json TEXT,
  created_at TEXT
);

CREATE TABLE IF NOT EXISTS dataset (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  fuente TEXT,
  titulo TEXT,
  cuerpo TEXT,
  etiqueta TEXT,
  created_at TEXT
);

CREATE TABLE IF NOT EXISTS feedback (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  analysis_id INTEGER,
  original_score INTEGER,
  correct_score INTEGER,
  original_verdict TEXT,
  correct_verdict TEXT,
  user_feedback TEXT,
  timestamp TEXT
);
`);

export function insertAnalysis(row) {
  const stmt = db.prepare(`
    INSERT OR REPLACE INTO analyses (
      id, source, title, body, score, verdict,
      labels_json, rationale, evidence_json, explanation,
      gemini_score, ml_score, ml_verdict, model,
      latency_ms, combination_flags_json, created_at
    ) VALUES (
      @id, @source, @title, @body, @score, @verdict,
      @labels_json, @rationale, @evidence_json, @explanation,
      @gemini_score, @ml_score, @ml_verdict, @model,
      @latency_ms, @combination_flags_json, @created_at
    )
  `);

  stmt.run({
    ...row,
    labels_json: JSON.stringify(row.labels || []),
    evidence_json: JSON.stringify(row.evidence || []),
    combination_flags_json: JSON.stringify(row.combination_flags || []),
  });
}

export function getAnalyses({ q = "", limit = 100 }) {
  if (q) {
    const stmt = db.prepare(`
      SELECT * FROM analyses
      WHERE lower(title) LIKE ? OR lower(source) LIKE ? OR lower(body) LIKE ?
      ORDER BY id DESC
      LIMIT ?
    `);
    const like = `%${q.toLowerCase()}%`;
    return stmt.all(like, like, like, limit);
  } else {
    const stmt = db.prepare(`
      SELECT * FROM analyses ORDER BY id DESC LIMIT ?
    `);
    return stmt.all(limit);
  }
}

export function insertDatasetRows(rows) {
  const stmt = db.prepare(`
    INSERT INTO dataset (fuente, titulo, cuerpo, etiqueta, created_at)
    VALUES (@fuente, @titulo, @cuerpo, @etiqueta, @created_at)
  `);
  const now = new Date().toISOString();

  const insertMany = db.transaction((items) => {
    for (const r of items) {
      stmt.run({
        fuente: r.fuente || "",
        titulo: r.titulo || "",
        cuerpo: r.cuerpo || "",
        etiqueta: (r.etiqueta || "").toString().trim().toLowerCase(),
        created_at: now,
      });
    }
  });

  insertMany(rows);
}

export function insertFeedback(feedback) {
  const stmt = db.prepare(`
    INSERT INTO feedback (
      analysis_id, original_score, correct_score,
      original_verdict, correct_verdict, user_feedback, timestamp
    ) VALUES (
      @analysis_id, @original_score, @correct_score,
      @original_verdict, @correct_verdict, @user_feedback, @timestamp
    )
  `);
  stmt.run(feedback);
}
