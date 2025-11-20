// DesInfoApp/backend/server.js
import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import Groq from "groq-sdk";               // 👈 ahora usamos Groq
import fs from "fs-extra";
import path from "node:path";
import { fileURLToPath } from "node:url";
import multer from "multer";
import csv from "csv-parser";
import xlsx from "xlsx";
import { spawn } from "node:child_process";

console.log("🔎 Iniciando servidor...");

// --- Config base (.env + rutas) ---
dotenv.config();
console.log("🔎 DOTENV cargado. PORT=%s", process.env.PORT || "3000");

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const DATA_DIR = path.join(__dirname, "data");
const DATA_FILE = path.join(DATA_DIR, "data.json");

// --- App / middlewares ---
const app = express();
app.use(cors());
app.use(express.json({ limit: "2mb" }));

// --- Groq (LLaMA 3) como verificador externo ---
let groqClient;
try {
  const groqKey = process.env.GROQ_API_KEY;

  if (!groqKey) {
    console.warn(
      "⚠️ GROQ_API_KEY no está definida en .env. El sistema usará solo el modelo local de ML cuando falle el LLM externo."
    );
  } else {
    groqClient = new Groq({ apiKey: groqKey });
    console.log("🔎 Cliente Groq inicializado (LLaMA 3).");
  }
} catch (e) {
  console.error("❌ Error creando cliente Groq:", e);
  // No matamos el servidor: dejamos groqClient = undefined y luego hacemos fallback en /analyze
}

// --- Configuración para subir datasets ---
const upload = multer({ dest: path.join(__dirname, "uploads") });
const AUTH_USER = "admin";
const AUTH_PASS = "1234";

// ======================================================
// 🔧 FUNCIONES DE VEREDICTO Y COMBINACIÓN LLM + ML
// ======================================================
function normalizeVerdict(raw) {
  if (!raw) return "desconocido";
  const v = String(raw).trim().toLowerCase();

  if (["verdadera", "real", "confiable", "true"].includes(v)) return "verdadera";
  if (["falsa", "engañosa", "fake", "false"].includes(v)) return "falsa";
  if (["dudosa", "incierta", "incompleta", "no_concluyente"].includes(v))
    return "dudosa";

  return "desconocido";
}

function combineGeminiAndML(gemini, ml) {
  // 👆 El nombre de la función se queda por compatibilidad,
  // pero ahora "gemini" = salida del LLM Groq.
  const geminiVerdict = normalizeVerdict(gemini.verdict);
  const geminiScore = Number(gemini.score ?? 50); // 0-100

  const mlVerdict = normalizeVerdict(ml.verdict);
  const mlConf = Number(ml.confidence ?? 0.5); // 0-1
  const mlScore =
    typeof ml.score === "number" ? ml.score : Math.round(mlConf * 100);

  const HIGH_CONF = 0.75;
  const MEDIUM_CONF = 0.6;

  let finalVerdict = "requiere_verificacion";
  let finalScore = 50;
  const flags = [];

  // 1) LLM "dudosa" + ML "falsa" con alta confianza
  if (geminiVerdict === "dudosa" && mlVerdict === "falsa" && mlConf >= HIGH_CONF) {
    finalVerdict = "falsa";
    finalScore = Math.round(mlScore * 0.9 + geminiScore * 0.1);
    flags.push("llm_dudosa_ml_falsa_alta_confianza");
  }

  // 2) Coincidencia fuerte: ambos verdadera
  else if (geminiVerdict === "verdadera" && mlVerdict === "verdadera") {
    finalScore = Math.min(
      100,
      Math.round(geminiScore * 0.6 + mlScore * 0.4 + 5)
    );
    finalVerdict = "verdadera";
    flags.push("consenso_verdadera");
  }

  // 3) Coincidencia fuerte: ambos falsa
  else if (geminiVerdict === "falsa" && mlVerdict === "falsa") {
    finalScore = Math.min(
      100,
      Math.round(geminiScore * 0.5 + mlScore * 0.5 + 5)
    );
    finalVerdict = "falsa";
    flags.push("consenso_falsa");
  }

  // 4) LLM seguro, ML más flojo → confiar más en LLM
  else if (geminiScore >= 70 && mlConf < MEDIUM_CONF) {
    finalVerdict = geminiVerdict !== "desconocido" ? geminiVerdict : mlVerdict;
    finalScore = Math.round(geminiScore * 0.7 + mlScore * 0.3);
    flags.push("llm_predomina");
  }

  // 5) ML muy confiado, LLM flojo o dudosa → confiar más en ML
  else if (mlConf >= HIGH_CONF && (geminiVerdict === "dudosa" || geminiScore < 60)) {
    finalVerdict = mlVerdict;
    finalScore = Math.round(mlScore * 0.7 + geminiScore * 0.3);
    flags.push("ml_predomina");
  }

  // 6) Desacuerdo fuerte → requiere verificación
  else if (
    (geminiVerdict === "verdadera" && mlVerdict === "falsa") ||
    (geminiVerdict === "falsa" && mlVerdict === "verdadera")
  ) {
    finalVerdict = "requiere_verificacion";
    finalScore = Math.round(Math.abs(geminiScore - mlScore));
    flags.push("desacuerdo_fuerte");
  }

  // 7) Caso neutro / fallback
  else {
    finalVerdict = geminiVerdict !== "desconocido" ? geminiVerdict : mlVerdict;
    finalScore = Math.round((geminiScore + mlScore) / 2);
    flags.push("fallback_promedio");
  }

  return {
    finalVerdict,
    finalScore,
    geminiVerdict,
    geminiScore,
    mlVerdict,
    mlConf,
    mlScore,
    flags,
  };
}

// ======================================================
// 🔗 INTEGRACIÓN ML LOCAL (Python)
// ======================================================
async function analyzeWithLocalML(newsData, geminiResult) {
  // geminiResult ahora en realidad es el resultado del LLM de Groq;
  // mantenemos los nombres de campos que espera Python: gemini_score, gemini_verdict.
  return new Promise((resolve) => {
    const scriptPath = path.join(__dirname, "ml", "predict.py");

    const py = spawn("python", [scriptPath], {
      stdio: ["pipe", "pipe", "pipe"],
    });

    const payload = {
      news_data: {
        title: newsData.title,
        body: newsData.body,
        source: newsData.source,
      },
      gemini_score: geminiResult.score,
      gemini_verdict: geminiResult.verdict,
    };

    let stdout = "";
    let stderr = "";

    py.stdout.on("data", (chunk) => (stdout += chunk.toString()));
    py.stderr.on("data", (chunk) => (stderr += chunk.toString()));

    py.on("close", (code) => {
      if (code !== 0) {
        console.error("❌ Python ML error (código %s): %s", code, stderr);
        // Fallback: solo LLM (Groq)
        return resolve({
          ml_analysis: {
            ml_verdict: "error",
            ml_score: geminiResult.score,
            ml_confidence: 0.5,
            ml_features_used: 0,
            ml_model_accuracy: 0,
          },
          final_verdict: geminiResult.verdict,
          combined_confidence: geminiResult.score / 100,
          analysis_method: "llm_only_fallback",
        });
      }

      try {
        const parsed = JSON.parse(stdout);
        return resolve(parsed);
      } catch (err) {
        console.error("❌ Error parseando salida ML:", err);
        console.error("STDOUT crudo:", stdout);
        return resolve({
          ml_analysis: {
            ml_verdict: "error_parse",
            ml_score: geminiResult.score,
            ml_confidence: 0.5,
            ml_features_used: 0,
            ml_model_accuracy: 0,
          },
          final_verdict: geminiResult.verdict,
          combined_confidence: geminiResult.score / 100,
          analysis_method: "llm_only_fallback",
        });
      }
    });

    py.stdin.write(JSON.stringify(payload));
    py.stdin.end();
  });
}

// --- Función para procesar dataset ---
async function processDataset(records, res, filePath) {
  try {
    await fs.ensureDir(DATA_DIR);

    let existingData = [];
    if (await fs.pathExists(DATA_FILE)) {
      const content = await fs.readFile(DATA_FILE, "utf8");
      existingData = content ? JSON.parse(content) : [];
    }

    for (const r of records) {
      if (
        r.titulo &&
        r.fuente &&
        !existingData.find(
          (e) => e.titulo === r.titulo && e.fuente === r.fuente
        )
      ) {
        existingData.push({
          fuente: r.fuente,
          titulo: r.titulo,
          cuerpo: r.cuerpo || "",
          score: 0,
          etiqueta: "",
          explicacion: "",
          fecha: new Date().toISOString(),
        });
      }
    }

    await fs.writeFile(DATA_FILE, JSON.stringify(existingData, null, 2));
    await fs.remove(filePath);

    res.json({ ok: true, message: "Dataset cargado correctamente" });
  } catch (error) {
    console.error("❌ Error procesando dataset:", error);
    res
      .status(500)
      .json({ ok: false, message: "Error al procesar el archivo" });
  }
}

// --- Endpoint para subir dataset ---
app.post("/upload-dataset", upload.single("file"), async (req, res) => {
  try {
    if (!req.file) return res.status(400).send("No se subió ningún archivo.");

    const ext = path.extname(req.file.originalname).toLowerCase();
    const filePath = req.file.path;

    const readDataset = async () => {
      const results = [];

      if (ext === ".csv") {
        return new Promise((resolve, reject) => {
          fs.createReadStream(filePath)
            .pipe(csv())
            .on("data", (data) => results.push(data))
            .on("end", () => resolve(results))
            .on("error", reject);
        });
      } else if (ext === ".xlsx") {
        const workbook = xlsx.readFile(filePath);
        const sheetName = workbook.SheetNames[0];
        const sheet = xlsx.utils.sheet_to_json(workbook.Sheets[sheetName]);
        return sheet;
      } else {
        throw new Error("Formato de archivo no compatible");
      }
    };

    const newData = await readDataset();

    const hasEtiqueta =
      newData.length > 0 &&
      Object.keys(newData[0]).some(
        (k) => k.toLowerCase().trim() === "etiqueta"
      );

    const dataPath = path.join(__dirname, "data", "data.json");
    const datasetPath = path.join(__dirname, "data", "dataset.json");

    const targetFile = hasEtiqueta ? datasetPath : dataPath;

    if (!fs.existsSync(targetFile)) {
      fs.writeFileSync(targetFile, "[]", "utf-8");
    }

    const existing = JSON.parse(fs.readFileSync(targetFile, "utf-8"));
    const updated = [...existing, ...newData];
    fs.writeFileSync(targetFile, JSON.stringify(updated, null, 2), "utf-8");

    fs.unlinkSync(filePath);

    res.json({
      message: hasEtiqueta
        ? "✅ Dataset con etiquetas guardado en dataset.json"
        : "✅ Dataset normal guardado en data.json",
      totalRegistros: newData.length,
      destino: hasEtiqueta ? "dataset.json" : "data.json",
    });
  } catch (error) {
    console.error(error);
    res.status(500).send("Error al procesar el dataset");
  }
});

// ✅ SISTEMA DE APRENDIZAJE CONTINUO
app.post("/feedback", async (req, res) => {
  try {
    const { analysis_id, correct_verdict, correct_score, user_feedback } =
      req.body;

    const allAnalyses = await readAll();
    const analysis = allAnalyses.find((a) => a.id == analysis_id);

    if (analysis) {
      const feedbackData = {
        analysis_id,
        original_score: analysis.score,
        correct_score,
        original_verdict: analysis.verdict,
        correct_verdict,
        user_feedback,
        timestamp: new Date().toISOString(),
      };

      const feedbackPath = path.join(__dirname, "data", "feedback_logs.json");
      let existingFeedback = [];

      if (await fs.pathExists(feedbackPath)) {
        const feedbackContent = await fs.readFile(feedbackPath, "utf8");
        existingFeedback = feedbackContent ? JSON.parse(feedbackContent) : [];
      }

      existingFeedback.push(feedbackData);
      await fs.writeFile(
        feedbackPath,
        JSON.stringify(existingFeedback, null, 2)
      );

      console.log(`✅ Feedback guardado para análisis ${analysis_id}`);
    }

    res.json({
      ok: true,
      message: "Feedback procesado para mejorar el sistema",
    });
  } catch (error) {
    console.error("Error procesando feedback:", error);
    res.status(500).json({ ok: false, error: error.message });
  }
});

// --- Funciones de utilidad ---
async function readAll() {
  try {
    const exists = await fs.pathExists(DATA_FILE);
    if (!exists) return [];
    const raw = await fs.readFile(DATA_FILE, "utf8");
    return raw ? JSON.parse(raw) : [];
  } catch (e) {
    console.error("❌ Error leyendo data.json:", e);
    return [];
  }
}

async function appendRow(row) {
  const arr = await readAll();
  arr.push(row);
  await fs.ensureDir(DATA_DIR);
  await fs.writeFile(DATA_DIR + "/data.json", JSON.stringify(arr, null, 2), "utf8");
  return row;
}

// --- Rutas básicas ---
app.get("/", (_req, res) =>
  res.json({
    ok: true,
    msg: "API Desinfo viva + ML local + Groq LLaMA",
    features: ["groq_llama3", "local_ml", "datasets", "history", "export"],
  })
);

app.get("/health", async (_req, res) => {
  const modelPath = path.join(__dirname, "ml", "model.joblib");
  const mlReady = await fs.pathExists(modelPath);
  res.json({
    ok: true,
    uptime: process.uptime(),
    ml_integration: true,
    ml_ready: mlReady,
    llm: {
      provider: "groq",
      model: "llama-3.1-8b-instant",
      configured: !!groqClient,
    },
  });
});

// --- Endpoint para verificar ML local ---
app.get("/ml-status", async (_req, res) => {
  try {
    const modelPath = path.join(__dirname, "ml", "model.joblib");
    const exists = await fs.pathExists(modelPath);
    res.json({
      ok: true,
      ml_type: "local_python",
      model_exists: exists,
      model_path: "backend/ml/model.joblib",
    });
  } catch (error) {
    res.status(500).json({ ok: false, error: error.message });
  }
});

// --- Análisis de noticias (Groq LLaMA + ML local con reglas) ---
app.post("/analyze", async (req, res) => {
  try {
    const { title = "", body = "", source = "" } = req.body || {};
    if (!title && !body) {
      return res
        .status(400)
        .json({ ok: false, error: "Falta title o body" });
    }

    console.log("📊 Iniciando análisis...");
    const analysisStart = Date.now();

    // --- Contexto del historial para el prompt ---
    const allData = await readAll();
    const ejemplos = allData
      .slice(-10)
      .map((x, i) => `${i + 1}. (${x.etiqueta || "sin_etiqueta"}) ${x.titulo}`)
      .join("\n");

    const prompt = `
Eres un verificador profesional de noticias. Analiza cualquier tipo de noticia (política, salud, deportes, farándula, local, internacional) siguiendo este protocolo:

1) Lee el título, fuente y cuerpo.
2) Imagina que consultas varias fuentes abiertas y comparas:
   - coherencia de fechas
   - existencia de los hechos
   - reputación de la fuente
3) Asigna:
   - un score numérico de 0 a 100 (score)
   - un veredicto (verdict): "verdadera", "falsa", "dudosa" o "no_verificable"
   - etiquetas (labels) que describan el tipo de problema o confiabilidad.
4) Devuelve SOLO un JSON válido estrictamente con esta forma:

{
  "score": 0-100,
  "verdict": "verdadera|falsa|dudosa|no_verificable",
  "labels": ["opcional", "lista"],
  "rationale": "Explicación breve en español",
  "evidence": [
    {
      "claim": "frase de la noticia evaluada",
      "assessment": "compatible|contradicha|no_verificable",
      "sources": ["https://...","https://..."]
    }
  ],
  "checks": {
    "fecha_coherente": true|false|null,
    "fuente_identificable": true|false|null,
    "consenso_en_fuentes": true|false|null
  }
}

TEXTO A VERIFICAR:
- Título: ${title}
- Fuente: ${source}
- Cuerpo: ${body}

EJECUTA TU RAZONAMIENTO INTERNAMENTE Y RESPONDE SOLO CON EL JSON.
`.trim();

    // --- Análisis con Groq (con fallback robusto) ---
    let llmResult;
    let llmLatency = 0;

    try {
      const llmStart = Date.now();

      if (!groqClient) {
        throw new Error("Cliente Groq no inicializado");
      }

      const completion = await groqClient.chat.completions.create({
        model: "llama-3.1-8b-instant",
        messages: [
          { role: "system", content: "Responde SIEMPRE con un único JSON válido." },
          { role: "user", content: prompt },
        ],
        temperature: 0.1,
        max_tokens: 800,
      });

      llmLatency = Date.now() - llmStart;

      const rawText = completion.choices?.[0]?.message?.content ?? "";
      const text = String(rawText || "").trim();

      let parsed = {};
      try {
        parsed = JSON.parse(text);
      } catch {
        const jsonStart = text.indexOf("{");
        const jsonEnd = text.lastIndexOf("}");
        const onlyJson =
          jsonStart >= 0 ? text.slice(jsonStart, jsonEnd + 1) : "{}";
        parsed = JSON.parse(onlyJson);
      }

      llmResult = {
        score: typeof parsed.score === "number" ? parsed.score : 50,
        verdict: parsed.verdict || "dudosa",
        labels: Array.isArray(parsed.labels) ? parsed.labels : [],
        rationale: parsed.rationale || "Sin explicación",
        evidence: Array.isArray(parsed.evidence)
          ? parsed.evidence.slice(0, 3)
          : [],
        checks: {
          fecha_coherente: parsed?.checks?.fecha_coherente ?? null,
          fuente_identificable: parsed?.checks?.fuente_identificable ?? null,
          consenso_en_fuentes: parsed?.checks?.consenso_en_fuentes ?? null,
        },
      };

      console.log(`✅ Groq LLaMA completado en ${llmLatency}ms`);
    } catch (err) {
      console.error("⚠️ Error en Groq LLaMA, usando valores por defecto:", err);

      // Fallback para que la API NO reviente
      llmResult = {
        score: 50,
        verdict: "dudosa",
        labels: ["sin_llm_externo"],
        rationale:
          "No se pudo contactar con el servicio de verificación externa. El análisis se basa solo en el modelo local.",
        evidence: [],
        checks: {
          fecha_coherente: null,
          fuente_identificable: null,
          consenso_en_fuentes: null,
        },
      };
    }

    // --- Análisis con ML local ---
    const mlAnalysis = await analyzeWithLocalML(
      { title, body, source },
      llmResult
    );

    const mlCore = {
      verdict: mlAnalysis.ml_analysis?.ml_verdict,
      confidence: mlAnalysis.ml_analysis?.ml_confidence,
      score: mlAnalysis.ml_analysis?.ml_score,
    };

    // --- Combinar LLM + ML con reglas ---
    const combinedDecision = combineGeminiAndML(
      { verdict: llmResult.verdict, score: llmResult.score },
      mlCore
    );

    // ✅ HU08: Explicaciones usando el resultado combinado
    const explanationData = generateSimpleExplanation(
      {
        score: combinedDecision.finalScore,
        verdict: combinedDecision.finalVerdict,
        labels: llmResult.labels,
      },
      llmResult
    );

    const combinedConfidence =
      mlAnalysis.combined_confidence ??
      Math.max(
        (llmResult.score || 0) / 100,
        mlCore.confidence || 0
      );

    const combinedResult = {
      // mantenemos la propiedad "gemini" para no romper el frontend,
      // pero internamente es la salida del LLM de Groq.
      gemini: {
        ...llmResult,
        latency_ms: llmLatency,
        weight: 0.4,
        provider: "groq",
        model: "llama-3.1-8b-instant",
      },
      ml: {
        ...mlAnalysis.ml_analysis,
        weight: 0.6,
      },
      final: {
        verdict: combinedDecision.finalVerdict,
        score: combinedDecision.finalScore,
        confidence: combinedConfidence,
        flags: combinedDecision.flags,
        explanation: `Análisis combinado por reglas: Groq LLaMA + ML local (${mlAnalysis.analysis_method || "local_ml_logreg_tfidf"})`,
        method: "rules_engine_llm_local_ml",
      },
      explanations: explanationData,
    };

    // --- Guardar en historial ---
    const row = {
      id: Date.now(),
      source,
      title,
      body,
      score: combinedResult.final.score,
      verdict: combinedResult.final.verdict,
      labels: llmResult.labels || [],
      rationale: llmResult.rationale || "Sin explicación",
      evidence: llmResult.evidence || [],
      explanation: combinedResult.final.explanation,
      gemini_score: llmResult.score, // nombre legacy, pero ahora es score del LLM
      ml_score: mlAnalysis.ml_analysis?.ml_score || null,
      ml_verdict: mlAnalysis.ml_analysis?.ml_verdict || null,
      model: "groq-llama-3.1-8b-instant + local-logreg-tfidf",
      latency_ms: Date.now() - analysisStart,
      created_at: new Date().toISOString(),
      explanations: explanationData,
      combination_flags: combinedDecision.flags,
    };

    await appendRow(row);

    console.log(`🎯 Análisis completado en ${Date.now() - analysisStart}ms`);

    res.json({
      ok: true,
      result: combinedResult,
      saved: {
        id: row.id,
        total_latency: Date.now() - analysisStart,
        gemini_latency: llmLatency, // legacy name
      },
    });
  } catch (e) {
    console.error("[/analyze] Error:", e);
    res.status(500).json({ ok: false, error: "Fallo en análisis" });
  }
});

// --- Historial ---
app.get("/history", async (req, res) => {
  try {
    const { q = "", limit = "100" } = req.query;
    const max = Math.min(parseInt(limit, 10) || 100, 1000);
    const all = await readAll();

    const term = String(q).toLowerCase();
    const filtered = term
      ? all.filter(
          (x) =>
            (x.title || "").toLowerCase().includes(term) ||
            (x.source || "").toLowerCase().includes(term) ||
            (x.body || "").toLowerCase().includes(term)
        )
      : all;

    filtered.sort((a, b) => (b.id || 0) - (a.id || 0));
    res.json({
      ok: true,
      items: filtered.slice(0, max),
      total: filtered.length,
    });
  } catch (e) {
    console.error("[/history] Error:", e);
    res.status(500).json({ ok: false, error: "No se pudo leer historial" });
  }
});

// --- Export CSV ---
app.get("/export/csv", async (_req, res) => {
  try {
    const all = await readAll();
    const headers = [
      "id",
      "created_at",
      "source",
      "title",
      "score",
      "verdict",
      "labels",
      "rationale",
      "latency_ms",
      "model",
    ];
    const esc = (s) => `"${String(s ?? "").replace(/"/g, '""')}"`;
    const rows = [
      headers.join(","),
      ...all.map((r) =>
        [
          r.id,
          r.created_at,
          r.source,
          r.title,
          r.score,
          r.verdict,
          (r.labels || []).join("|"),
          r.rationale,
          r.latency_ms,
          r.model,
        ]
          .map(esc)
          .join(",")
      ),
    ].join("\r\n");

    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader("Content-Disposition", "attachment; filename=analyses.csv");
    res.send(rows);
  } catch (e) {
    console.error("[/export/csv] Error:", e);
    res.status(500).json({ ok: false, error: "No se pudo exportar CSV" });
  }
});

// --- Calibración (HU07) ---
app.post("/calibrate", async (req, res) => {
  try {
    console.log("🔧 Iniciando calibración del sistema...");

    const allAnalyses = await readAll();
    const recentAnalyses = allAnalyses.slice(-50);

    const datasetPath = path.join(__dirname, "data", "dataset.json");
    let referenceData = [];

    if (await fs.pathExists(datasetPath)) {
      const datasetContent = await fs.readFile(datasetPath, "utf8");
      referenceData = datasetContent ? JSON.parse(datasetContent) : [];
    }

    const calibrationResults = [];
    let totalMatches = 0;
    let accuracySum = 0;

    for (const analysis of recentAnalyses) {
      const matches = findSimilarArticles(analysis, referenceData);

      if (matches.length > 0) {
        totalMatches++;
        const originalScore = analysis.score || 50;
        const calibratedScore = applyCalibration(originalScore, matches);

        const accuracy = calculateCalibrationAccuracy(
          calibratedScore,
          matches
        );
        accuracySum += accuracy;

        calibrationResults.push({
          analysis_id: analysis.id || analysis._id,
          original_score: originalScore,
          calibrated_score: calibratedScore,
          matches_found: matches.length,
          accuracy: Math.round(accuracy),
        });
      }
    }

    const avgAccuracy = totalMatches > 0 ? accuracySum / totalMatches : 0;
    const calibrationRate =
      recentAnalyses.length > 0
        ? (totalMatches / recentAnalyses.length) * 100
        : 0;

    const calibrationLog = {
      timestamp: new Date().toISOString(),
      total_analyses: recentAnalyses.length,
      calibrated_analyses: totalMatches,
      calibration_rate: Math.round(calibrationRate * 100) / 100,
      average_accuracy: Math.round(avgAccuracy * 100) / 100,
      results: calibrationResults,
    };

    const calibrationLogPath = path.join(
      __dirname,
      "data",
      "calibration_logs.json"
    );
    let existingLogs = [];

    if (await fs.pathExists(calibrationLogPath)) {
      const logsContent = await fs.readFile(calibrationLogPath, "utf8");
      existingLogs = logsContent ? JSON.parse(logsContent) : [];
    }

    existingLogs.push(calibrationLog);
    await fs.writeFile(
      calibrationLogPath,
      JSON.stringify(existingLogs, null, 2)
    );

    console.log(
      `✅ Calibración completada: ${totalMatches}/${recentAnalyses.length} análisis calibrados`
    );

    res.json({
      ok: true,
      message: `Calibración completada: ${totalMatches}/${recentAnalyses.length} análisis calibrados`,
      avg_accuracy: Math.round(avgAccuracy * 100) / 100,
      calibration_rate: Math.round(calibrationRate * 100) / 100,
      results: calibrationResults,
      log_id: calibrationLog.timestamp,
    });
  } catch (error) {
    console.error("❌ Error en calibración:", error);
    res.status(500).json({ ok: false, error: error.message });
  }
});

app.get("/calibration-logs", async (req, res) => {
  try {
    const calibrationLogPath = path.join(
      __dirname,
      "data",
      "calibration_logs.json"
    );

    if (!(await fs.pathExists(calibrationLogPath))) {
      return res.json({ ok: true, logs: [] });
    }

    const logsContent = await fs.readFile(calibrationLogPath, "utf8");
    const logs = logsContent ? JSON.parse(logsContent) : [];

    logs.sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));

    res.json({ ok: true, logs: logs.slice(0, 10) });
  } catch (error) {
    console.error("❌ Error obteniendo logs de calibración:", error);
    res.status(500).json({ ok: false, error: error.message });
  }
});

// ✅ HU08: Explicaciones (igual que tenías, usando score/verdict)
function generateSimpleExplanation(analysisData, geminiResult) {
  const score = analysisData.score || 0;
  const verdict = analysisData.verdict || "no_verificable";
  const labels = analysisData.labels || [];

  let simpleExplanation = "";
  let detailedExplanation = "";

  if (verdict === "falsa" || score < 30) {
    simpleExplanation =
      "🔴 Esta noticia contiene información falsa o muy engañosa.";
    detailedExplanation = `**Puntaje muy bajo (${score}/100):** La información presenta múltiples problemas de veracidad. Se detectaron afirmaciones sin sustento factual y fuentes no confiables.`;
  } else if (verdict === "dudosa" || (score >= 30 && score < 60)) {
    simpleExplanation =
      "🟡 La información presenta señales de alerta y requiere verificación.";
    detailedExplanation = `**Puntaje medio (${score}/100):** Se encontraron contradicciones o falta de transparencia en las fuentes. Se recomienda consultar medios establecidos antes de compartir.`;
  } else if (
    verdict === "real" ||
    verdict === "verdadera" ||
    score >= 60
  ) {
    simpleExplanation = "🟢 La noticia parece confiable y bien fundamentada.";
    detailedExplanation = `**Puntaje alto (${score}/100):** La información coincide con fuentes verificables y presenta datos consistentes. Puede considerarse confiable.`;
  } else {
    simpleExplanation =
      "⚪ No se pudo determinar la veracidad con la información disponible.";
    detailedExplanation = `**Puntaje indeterminado (${score}/100):** Se requiere más contexto o fuentes adicionales para una evaluación completa.`;
  }

  const factors = [];
  if (
    labels.includes("clickbait") ||
    labels.some((l) => l.includes("titular") && l.includes("engamoso"))
  ) {
    factors.push("• El titular es sensacionalista o engañoso");
  }
  if (
    labels.includes("sin_fuente") ||
    labels.some((l) => l.includes("fuente") && l.includes("confiable"))
  ) {
    factors.push("• Las fuentes citadas son poco confiables o no existen");
  }
  if (
    labels.includes("contradice_fuentes") ||
    labels.some((l) => l.includes("contradice"))
  ) {
    factors.push("• La información contradice fuentes establecidas");
  }
  if (
    labels.includes("datos_verificados") ||
    labels.some((l) => l.includes("verificado"))
  ) {
    factors.push("• Los datos coinciden con fuentes oficiales");
  }
  if (
    labels.includes("consenso_en_fuentes") ||
    labels.some((l) => l.includes("consenso"))
  ) {
    factors.push("• Múltiples fuentes confiables confirman la información");
  }

  if (factors.length > 0) {
    detailedExplanation += "\n\n**Factores clave:**\n" + factors.join("\n");
  }

  let recommendation = "";
  if (score >= 70) recommendation = "✅ Puede compartirse con confianza";
  else if (score >= 40)
    recommendation = "⚠️ Verificar con otras fuentes antes de compartir";
  else recommendation = "❌ No se recomienda compartir";

  detailedExplanation += `\n\n**Recomendación:** ${recommendation}`;

  return {
    simple: simpleExplanation,
    detailed: detailedExplanation,
    factors: factors,
    recommendation: recommendation,
    confidence: score >= 80 ? "alta" : score >= 50 ? "media" : "baja",
  };
}

// Funciones auxiliares para calibración
function findSimilarArticles(analysis, referenceData) {
  const similarArticles = [];
  const analysisText = `${analysis.title || ""} ${
    analysis.body || ""
  }`.toLowerCase();

  for (const refArticle of referenceData) {
    const refText = `${refArticle.titulo || ""} ${
      refArticle.cuerpo || ""
    }`.toLowerCase();
    const similarity = calculateTextSimilarity(analysisText, refText);

    if (similarity > 0.6) {
      similarArticles.push({
        ref_article: refArticle,
        similarity_score: similarity,
        verified_score: mapEtiquetaToScore(refArticle.etiqueta),
      });
    }
  }

  return similarArticles;
}

function mapEtiquetaToScore(etiqueta) {
  const scoreMap = {
    real: 85,
    verdadero: 85,
    verdadera: 85,
    confiable: 80,
    dudoso: 40,
    dudosa: 40,
    falso: 20,
    falsa: 20,
    fake: 15,
    engañoso: 30,
  };

  return scoreMap[etiqueta?.toLowerCase()] || 50;
}

function applyCalibration(originalScore, matches) {
  if (matches.length === 0) return originalScore;

  const verifiedScores = matches.map((match) => match.verified_score);
  const avgVerified =
    verifiedScores.reduce((a, b) => a + b, 0) / verifiedScores.length;

  const calibrated = originalScore * 0.6 + avgVerified * 0.4;
  return Math.max(0, Math.min(100, Math.round(calibrated * 10) / 10));
}

function calculateCalibrationAccuracy(calibratedScore, matches) {
  if (matches.length === 0) return 0;

  const verifiedScores = matches.map((match) => match.verified_score);
  const avgVerified =
    verifiedScores.reduce((a, b) => a + b, 0) / verifiedScores.length;

  const accuracy = 100 - Math.abs(calibratedScore - avgVerified);
  return Math.max(0, accuracy);
}

function calculateTextSimilarity(text1, text2) {
  const words1 = new Set(text1.split(/\s+/).filter((w) => w.length > 3));
  const words2 = new Set(text2.split(/\s+/).filter((w) => w.length > 3));

  if (words1.size === 0 || words2.size === 0) return 0;

  const intersection = new Set([...words1].filter((x) => words2.has(x)));
  const union = new Set([...words1, ...words2]);

  return union.size > 0 ? intersection.size / union.size : 0;
}

// --- 404 ---
app.use((_req, res) =>
  res.status(404).json({ ok: false, error: "Ruta no encontrada" })
);

// --- Arranque ---
const PORT = process.env.PORT || 3000;

process.on("uncaughtException", (err) => {
  console.error("💥 uncaughtException:", err);
});
process.on("unhandledRejection", (reason) => {
  console.error("💥 unhandledRejection:", reason);
});

try {
  app.listen(PORT, () => {
    console.log("✅ API en puerto", PORT);
    console.log("🤖 Integración ML local activa (Python en backend/ml)");
    console.log("🧠 LLM externo: Groq LLaMA 3.1 8B (si GROQ_API_KEY está configurada)");
    console.log("📊 Endpoints disponibles:");
    console.log("   POST /analyze          - Análisis con Groq LLaMA + ML local");
    console.log("   GET  /ml-status        - Estado del modelo local");
    console.log("   POST /upload-dataset   - Subir datasets");
    console.log("   GET  /history          - Historial de análisis");
    console.log("   GET  /export/csv       - Exportar datos");
    console.log("   POST /calibrate        - HU07: Calibración del sistema");
    console.log("   GET  /calibration-logs - HU07: Logs de calibración");
  });
} catch (e) {
  console.error("❌ Error al iniciar app.listen:", e);
}
