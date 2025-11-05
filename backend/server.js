// DesInfoApp/backend/server.js
import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import { GoogleGenAI } from "@google/genai";
import fs from "fs-extra";
import path from "node:path";
import { fileURLToPath } from "node:url";
import multer from "multer";
import csv from "csv-parser";
import xlsx from "xlsx";

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

// --- Gemini ---
let ai;
try {
  ai = new GoogleGenAI({});
  if (!process.env.GOOGLE_API_KEY) {
    console.warn("⚠️ GOOGLE_API_KEY no está en .env (el SDK puede fallar luego).");
  } else {
    console.log("🔎 GOOGLE_API_KEY detectada.");
  }
} catch (e) {
  console.error("❌ Error creando cliente GoogleGenAI:", e);
  process.exit(1);
}

// --- Configuración para subir datasets ---
const upload = multer({ dest: path.join(__dirname, "uploads") });
const AUTH_USER = "admin";
const AUTH_PASS = "1234";

// --- NUEVO: URL del Colab ML (cambia si reinicias Colab) ---
const COLAB_ML_URL = "https://laverne-gentianaceous-unpalatally.ngrok-free.dev";

// --- NUEVA FUNCIÓN: Conectar con Colab ML ---
async function analyzeWithColabML(newsData, geminiResult) {
  try {
    console.log("🔗 Conectando con Colab ML...");
    
    const mlRequest = {
      news_data: {
        title: newsData.title,
        body: newsData.body,
        source: newsData.source
      },
      gemini_score: geminiResult.score,
      gemini_verdict: geminiResult.verdict
    };

    const response = await fetch(`${COLAB_ML_URL}/analyze-ml`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(mlRequest),
      timeout: 10000 // 10 segundos timeout
    });

    if (!response.ok) {
      throw new Error(`HTTP error! status: ${response.status}`);
    }

    const mlResult = await response.json();
    console.log("✅ Colab ML respondió correctamente");
    return mlResult;
    
  } catch (error) {
    console.error("❌ Error conectando con Colab ML:", error.message);
    // Fallback: retornar estructura vacía para no afectar flujo principal
    return {
      ml_analysis: { 
        ml_verdict: "error", 
        ml_score: 50,
        ml_confidence: 0.5,
        ml_features_used: 0,
        ml_model_accuracy: 0
      },
      final_verdict: geminiResult.verdict,
      combined_confidence: geminiResult.score / 100,
      analysis_method: "gemini_only_fallback"
    };
  }
}

// --- Función para procesar dataset (SIN CAMBIOS) ---
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
    res.status(500).json({ ok: false, message: "Error al procesar el archivo" });
  }
}

// --- Endpoint para subir dataset (SIN CAMBIOS) ---
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
    const { analysis_id, correct_verdict, correct_score, user_feedback } = req.body;
    
    const allAnalyses = await readAll();
    const analysis = allAnalyses.find(a => a.id == analysis_id);
    
    if (analysis) {
      // Guardar feedback para mejorar el ML
      const feedbackData = {
        analysis_id,
        original_score: analysis.score,
        correct_score,
        original_verdict: analysis.verdict,
        correct_verdict,
        user_feedback,
        timestamp: new Date().toISOString()
      };
      
      // Guardar en dataset de entrenamiento
      const feedbackPath = path.join(__dirname, "data", "feedback_logs.json");
      let existingFeedback = [];
      
      if (await fs.pathExists(feedbackPath)) {
        const feedbackContent = await fs.readFile(feedbackPath, "utf8");
        existingFeedback = feedbackContent ? JSON.parse(feedbackContent) : [];
      }
      
      existingFeedback.push(feedbackData);
      await fs.writeFile(feedbackPath, JSON.stringify(existingFeedback, null, 2));
      
      console.log(`✅ Feedback guardado para análisis ${analysis_id}`);
    }
    
    res.json({ ok: true, message: "Feedback procesado para mejorar el sistema" });
    
  } catch (error) {
    console.error("Error procesando feedback:", error);
    res.status(500).json({ ok: false, error: error.message });
  }
});

// --- Funciones de utilidad existentes (SIN CAMBIOS) ---
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
  await fs.writeFile(DATA_FILE, JSON.stringify(arr, null, 2), "utf8");
  return row;
}

// --- Rutas básicas ---
app.get("/", (_req, res) => res.json({ 
  ok: true, 
  msg: "API Desinfo viva + ML Integration",
  features: ["gemini", "colab_ml", "datasets", "history", "export"]
}));

app.get("/health", (_req, res) => res.json({ 
  ok: true, 
  uptime: process.uptime(),
  ml_integration: true 
}));

// --- NUEVO: Endpoint para verificar conexión Colab ---
app.get("/ml-status", async (_req, res) => {
  try {
    const response = await fetch(`${COLAB_ML_URL}/health`, { timeout: 5000 });
    const status = await response.json();
    res.json({ 
      ok: true, 
      colab_connected: true,
      colab_status: status 
    });
  } catch (error) {
    res.json({ 
      ok: true, 
      colab_connected: false,
      error: error.message 
    });
  }
});

// --- Análisis de noticias (MEJORADO con integración ML) ---
app.post("/analyze", async (req, res) => {
  try {
    const { title = "", body = "", source = "" } = req.body || {};
    if (!title && !body) {
      return res.status(400).json({ ok: false, error: "Falta title o body" });
    }

    console.log("📊 Iniciando análisis...");
    const analysisStart = Date.now();

    // --- Análisis con Gemini (EXISTENTE - SIN CAMBIOS) ---
    const allData = await readAll();
    const ejemplos = allData
      .slice(-10)
      .map((x, i) => `${i + 1}. (${x.etiqueta || "sin_etiqueta"}) ${x.titulo}`)
      .join("\n");

const prompt = `
Eres un verificador de noticias profesionales con expertise en noticias peruanas.

ANÁLISIS EN 2 ETAPAS:

1. **ANÁLISIS INICIAL** (sin prejuicios):
   - ¿El contenido parece noticia real o satírica?
   - ¿La fuente es reconocida?
   - ¿La redacción es profesional?

2. **CONTEXTO PERUANO** (conocimiento local):
   - Considera que pueden haber cambios políticos recientes
   - Noticias de última hora pueden no estar en todas las fuentes
   - Medios locales pueden tener información antes que internacionales

IMPORTANTE: No asumas que toda información nueva es falsa. Considera posibilidad de noticias de última hora.

RESPUESTA EN JSON:
{
  "score": 0-100,
  "verdict": "real" | "falsa" | "no_noticia" | "dudosa",
  "rationale": "Explicación balanceada considerando posibilidad de noticia nueva",
  "labels": ["ultima_hora"|"fuente_local"|"necesita_verificacion"|"posible_real"|"estructura_creible"],
  "evidence": [],
  "checks": {"fecha_coherente":true, "fuente_identificable":true, "consenso_en_fuentes":null}
}

Noticia a analizar:
- Fuente: ${source}
- Título: ${title} 
- Cuerpo: ${body}
`.trim();

    const geminiStart = Date.now();
    const resp = await ai.models.generateContent({
      model: "gemini-2.5-flash",
      contents: [{ role: "user", parts: [{ text: prompt }] }],
    });
    const geminiLatency = Date.now() - geminiStart;

    const text = (resp.text || "").trim();
    let parsed = {};
    try {
      parsed = JSON.parse(text);
    } catch {
      const jsonStart = text.indexOf("{");
      const jsonEnd = text.lastIndexOf("}");
      const onlyJson = jsonStart >= 0 ? text.slice(jsonStart, jsonEnd + 1) : "{}";
      parsed = JSON.parse(onlyJson);
    }

    const geminiResult = {
      score: typeof parsed.score === "number" ? parsed.score : 50,
      verdict: parsed.verdict || "dudosa",
      labels: Array.isArray(parsed.labels) ? parsed.labels : [],
      rationale: parsed.rationale || "Sin explicación",
      evidence: Array.isArray(parsed.evidence) ? parsed.evidence.slice(0, 3) : [],
      checks: {
        fecha_coherente: parsed?.checks?.fecha_coherente ?? null,
        fuente_identificable: parsed?.checks?.fuente_identificable ?? null,
        consenso_en_fuentes: parsed?.checks?.consenso_en_fuentes ?? null,
      },
    };

    console.log(`✅ Gemini completado en ${geminiLatency}ms`);

    // ✅ HU08: Generar explicaciones automáticas y comprensibles
    const explanationData = generateSimpleExplanation(
      { score: geminiResult.score, verdict: geminiResult.verdict, labels: geminiResult.labels },
      geminiResult
    );

    // --- NUEVO: Análisis con Colab ML ---
    let mlAnalysis = null;
    try {
      mlAnalysis = await analyzeWithColabML(
        { title, body, source },
        geminiResult
      );
      console.log("✅ Colab ML integrado correctamente");
    } catch (mlError) {
      console.log("⚠️ Colab ML no disponible, usando solo Gemini");
      mlAnalysis = {
        ml_analysis: { ml_verdict: "no_disponible", ml_score: geminiResult.score },
        final_verdict: geminiResult.verdict,
        combined_confidence: geminiResult.score / 100
      };
    }

    // --- Combinar resultados ---
// ✅ MEJOR BALANCE: 40% Gemini + 60% ML
const mlWeight = 0.6; // 60% peso al ML
const geminiWeight = 0.4; // 40% peso a Gemini

const mlScore = mlAnalysis.ml_analysis?.ml_score || geminiResult.score;
const combinedScore = Math.round((geminiResult.score * geminiWeight) + (mlScore * mlWeight));

// Usar el veredicto del ML si tiene alta confianza, sino de Gemini
const finalVerdict = (mlAnalysis.ml_analysis?.ml_confidence > 0.7) 
  ? mlAnalysis.final_verdict 
  : geminiResult.verdict;

const combinedResult = {
  gemini: {
    ...geminiResult,
    latency_ms: geminiLatency,
    weight: geminiWeight
  },
  ml: {
    ...mlAnalysis.ml_analysis,
    weight: mlWeight
  },
  final: {
    verdict: finalVerdict,
    score: combinedScore,
    confidence: mlAnalysis.combined_confidence || (combinedScore / 100),
    explanation: `Análisis mejorado: Gemini (${geminiWeight*100}%) + ML (${mlWeight*100}%) con ${mlAnalysis.ml_analysis?.ml_features_used || 0} características`,
    method: "balanced_gemini_ml"
  },
  explanations: explanationData
};

    // --- Guardar en historial (VERSIÓN CORREGIDA) ---
    const row = {
      id: Date.now(),
      source,
      title,
      body,
      // ✅ DATOS PRINCIPALES para el frontend
      score: combinedResult.final.score,
      verdict: combinedResult.final.verdict,
      // ✅ GUARDAR EXPLÍCITAMENTE labels Y rationale DE GEMINI
      labels: geminiResult.labels || [],
      rationale: geminiResult.rationale || "Sin explicación",
      evidence: geminiResult.evidence || [],
      // Datos adicionales para análisis interno
      explanation: combinedResult.final.explanation,
      gemini_score: geminiResult.score,
      ml_score: mlAnalysis.ml_analysis?.ml_score || null,
      ml_verdict: mlAnalysis.ml_analysis?.ml_verdict || null,
      model: "gemini-2.5-flash + random-forest-ml",
      latency_ms: Date.now() - analysisStart,
      created_at: new Date().toISOString(),
      // ✅ HU08: Guardar explicaciones en el historial
      explanations: explanationData
    };

    await appendRow(row);

    console.log(`🎯 Análisis completado en ${Date.now() - analysisStart}ms`);

    res.json({ 
      ok: true, 
      result: combinedResult,
      saved: { 
        id: row.id, 
        total_latency: Date.now() - analysisStart,
        gemini_latency: geminiLatency
      } 
    });

  } catch (e) {
    console.error("[/analyze] Error:", e);
    res.status(500).json({ ok: false, error: "Fallo en análisis" });
  }
});

// --- Historial (SIN CAMBIOS) ---
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
    res.json({ ok: true, items: filtered.slice(0, max), total: filtered.length });
  } catch (e) {
    console.error("[/history] Error:", e);
    res.status(500).json({ ok: false, error: "No se pudo leer historial" });
  }
});

// --- Export CSV (SIN CAMBIOS) ---
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

// ✅ HU07 - CALIBRACIÓN CON DATASETS LOCALES
app.post("/calibrate", async (req, res) => {
  try {
    console.log("🔧 Iniciando calibración del sistema...");
    
    // Obtener todos los análisis recientes
    const allAnalyses = await readAll();
    const recentAnalyses = allAnalyses.slice(-50); // Últimos 50 análisis
    
    // Obtener dataset de referencia (con etiquetas verificadas)
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
      // Buscar coincidencias en el dataset
      const matches = findSimilarArticles(analysis, referenceData);
      
      if (matches.length > 0) {
        totalMatches++;
        const originalScore = analysis.score || 50;
        const calibratedScore = applyCalibration(originalScore, matches);
        
        // Calcular precisión de esta calibración
        const accuracy = calculateCalibrationAccuracy(calibratedScore, matches);
        accuracySum += accuracy;
        
        calibrationResults.push({
          analysis_id: analysis.id || analysis._id,
          original_score: originalScore,
          calibrated_score: calibratedScore,
          matches_found: matches.length,
          accuracy: Math.round(accuracy)
        });
      }
    }
    
    // Calcular métricas generales
    const avgAccuracy = totalMatches > 0 ? accuracySum / totalMatches : 0;
    const calibrationRate = recentAnalyses.length > 0 ? (totalMatches / recentAnalyses.length) * 100 : 0;
    
    // Guardar registro de calibración
    const calibrationLog = {
      timestamp: new Date().toISOString(),
      total_analyses: recentAnalyses.length,
      calibrated_analyses: totalMatches,
      calibration_rate: Math.round(calibrationRate * 100) / 100,
      average_accuracy: Math.round(avgAccuracy * 100) / 100,
      results: calibrationResults
    };
    
    // Guardar en archivo de logs de calibración
    const calibrationLogPath = path.join(__dirname, "data", "calibration_logs.json");
    let existingLogs = [];
    
    if (await fs.pathExists(calibrationLogPath)) {
      const logsContent = await fs.readFile(calibrationLogPath, "utf8");
      existingLogs = logsContent ? JSON.parse(logsContent) : [];
    }
    
    existingLogs.push(calibrationLog);
    await fs.writeFile(calibrationLogPath, JSON.stringify(existingLogs, null, 2));
    
    console.log(`✅ Calibración completada: ${totalMatches}/${recentAnalyses.length} análisis calibrados`);
    
    res.json({
      ok: true,
      message: `Calibración completada: ${totalMatches}/${recentAnalyses.length} análisis calibrados`,
      avg_accuracy: Math.round(avgAccuracy * 100) / 100,
      calibration_rate: Math.round(calibrationRate * 100) / 100,
      results: calibrationResults,
      log_id: calibrationLog.timestamp
    });
    
  } catch (error) {
    console.error("❌ Error en calibración:", error);
    res.status(500).json({ ok: false, error: error.message });
  }
});

// ✅ HU07: Endpoint para obtener logs de calibración
app.get("/calibration-logs", async (req, res) => {
  try {
    const calibrationLogPath = path.join(__dirname, "data", "calibration_logs.json");
    
    if (!await fs.pathExists(calibrationLogPath)) {
      return res.json({ ok: true, logs: [] });
    }
    
    const logsContent = await fs.readFile(calibrationLogPath, "utf8");
    const logs = logsContent ? JSON.parse(logsContent) : [];
    
    // Ordenar por fecha más reciente primero
    logs.sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));
    
    res.json({ ok: true, logs: logs.slice(0, 10) }); // Últimos 10 logs
    
  } catch (error) {
    console.error("❌ Error obteniendo logs de calibración:", error);
    res.status(500).json({ ok: false, error: error.message });
  }
});

// ✅ HU08: Función para generar explicaciones automáticas
function generateSimpleExplanation(analysisData, geminiResult) {
  const score = analysisData.score || 0;
  const verdict = analysisData.verdict || 'no_verificable';
  const labels = analysisData.labels || [];
  
  // Explicaciones basadas en el score y veredicto
  let simpleExplanation = "";
  let detailedExplanation = "";
  
  if (verdict === "falsa" || score < 30) {
    simpleExplanation = "🔴 Esta noticia contiene información falsa o muy engañosa.";
    detailedExplanation = `**Puntaje muy bajo (${score}/100):** La información presenta múltiples problemas de veracidad. Se detectaron afirmaciones sin sustento factual y fuentes no confiables.`;
  } 
  else if (verdict === "dudosa" || (score >= 30 && score < 60)) {
    simpleExplanation = "🟡 La información presenta señales de alerta y requiere verificación.";
    detailedExplanation = `**Puntaje medio (${score}/100):** Se encontraron contradicciones o falta de transparencia en las fuentes. Se recomienda consultar medios establecidos antes de compartir.`;
  }
  else if (verdict === "real" || score >= 60) {
    simpleExplanation = "🟢 La noticia parece confiable y bien fundamentada.";
    detailedExplanation = `**Puntaje alto (${score}/100):** La información coincide con fuentes verificables y presenta datos consistentes. Puede considerarse confiable.`;
  }
  else {
    simpleExplanation = "⚪ No se pudo determinar la veracidad con la información disponible.";
    detailedExplanation = `**Puntaje indeterminado (${score}/100):** Se requiere más contexto o fuentes adicionales para una evaluación completa.`;
  }
  
  // Personalizar basado en labels específicos
  const factors = [];
  if (labels.includes("clickbait") || labels.some(l => l.includes("titular") && l.includes("engamoso"))) {
    factors.push("• El titular es sensacionalista o engañoso");
  }
  if (labels.includes("sin_fuente") || labels.some(l => l.includes("fuente") && l.includes("confiable"))) {
    factors.push("• Las fuentes citadas son poco confiables o no existen");
  }
  if (labels.includes("contradice_fuentes") || labels.some(l => l.includes("contradice"))) {
    factors.push("• La información contradice fuentes establecidas");
  }
  if (labels.includes("datos_verificados") || labels.some(l => l.includes("verificado"))) {
    factors.push("• Los datos coinciden con fuentes oficiales");
  }
  if (labels.includes("consenso_en_fuentes") || labels.some(l => l.includes("consenso"))) {
    factors.push("• Múltiples fuentes confiables confirman la información");
  }
  
  if (factors.length > 0) {
    detailedExplanation += "\n\n**Factores clave:**\n" + factors.join("\n");
  }
  
  // Recomendación final
  let recommendation = "";
  if (score >= 70) recommendation = "✅ Puede compartirse con confianza";
  else if (score >= 40) recommendation = "⚠️ Verificar con otras fuentes antes de compartir";
  else recommendation = "❌ No se recomienda compartir";
  
  detailedExplanation += `\n\n**Recomendación:** ${recommendation}`;
  
  return {
    simple: simpleExplanation,
    detailed: detailedExplanation,
    factors: factors,
    recommendation: recommendation,
    confidence: score >= 80 ? "alta" : score >= 50 ? "media" : "baja"
  };
}

// Funciones auxiliares para calibración
function findSimilarArticles(analysis, referenceData) {
  const similarArticles = [];
  const analysisText = `${analysis.title || ''} ${analysis.body || ''}`.toLowerCase();
  
  for (const refArticle of referenceData) {
    const refText = `${refArticle.titulo || ''} ${refArticle.cuerpo || ''}`.toLowerCase();
    
    // Calcular similitud básica (en producción usaríamos embeddings)
    const similarity = calculateTextSimilarity(analysisText, refText);
    
    if (similarity > 0.6) { // Umbral de similitud ajustado
      similarArticles.push({
        ref_article: refArticle,
        similarity_score: similarity,
        verified_score: mapEtiquetaToScore(refArticle.etiqueta)
      });
    }
  }
  
  return similarArticles;
}

function mapEtiquetaToScore(etiqueta) {
  // Mapear etiquetas del dataset a scores numéricos
  const scoreMap = {
    "real": 85,
    "verdadero": 85,
    "confiable": 80,
    "dudoso": 40,
    "falso": 20,
    "fake": 15,
    "engañoso": 30
  };
  
  return scoreMap[etiqueta?.toLowerCase()] || 50;
}

function applyCalibration(originalScore, matches) {
  if (matches.length === 0) return originalScore;
  
  const verifiedScores = matches.map(match => match.verified_score);
  const avgVerified = verifiedScores.reduce((a, b) => a + b, 0) / verifiedScores.length;
  
  // Calibrar: 60% score original + 40% promedio verificado
  const calibrated = (originalScore * 0.6) + (avgVerified * 0.4);
  return Math.max(0, Math.min(100, Math.round(calibrated * 10) / 10)); // Asegurar entre 0-100
}

function calculateCalibrationAccuracy(calibratedScore, matches) {
  if (matches.length === 0) return 0;
  
  const verifiedScores = matches.map(match => match.verified_score);
  const avgVerified = verifiedScores.reduce((a, b) => a + b, 0) / verifiedScores.length;
  
  // Precisión = 100% - diferencia porcentual absoluta
  const accuracy = 100 - Math.abs(calibratedScore - avgVerified);
  return Math.max(0, accuracy);
}

function calculateTextSimilarity(text1, text2) {
  // Implementación básica de similitud de Jaccard
  const words1 = new Set(text1.split(/\s+/).filter(w => w.length > 3));
  const words2 = new Set(text2.split(/\s+/).filter(w => w.length > 3));
  
  if (words1.size === 0 || words2.size === 0) return 0;
  
  const intersection = new Set([...words1].filter(x => words2.has(x)));
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
    console.log("🤖 Integración ML activa:", COLAB_ML_URL);
    console.log("📊 Endpoints disponibles:");
    console.log("   POST /analyze          - Análisis con Gemini + ML");
    console.log("   GET  /ml-status        - Estado conexión Colab");
    console.log("   POST /upload-dataset   - Subir datasets");
    console.log("   GET  /history          - Historial de análisis");
    console.log("   GET  /export/csv       - Exportar datos");
    console.log("   POST /calibrate        - HU07: Calibración del sistema");
    console.log("   GET  /calibration-logs - HU07: Logs de calibración");
  });
} catch (e) {
  console.error("❌ Error al iniciar app.listen:", e);
}