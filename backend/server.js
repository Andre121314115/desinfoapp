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
Eres un verificador profesional de noticias locales.
Tienes a continuación algunos ejemplos de noticias previamente clasificadas por analistas humanos:

${ejemplos}

Ahora analiza la siguiente noticia y determina si es **real, falsa o no_noticia**.
También da un puntaje de credibilidad de 0 a 100 y una breve explicación.

Devuelve SOLO JSON válido con este formato:

{
  "score": 0-100,
  "verdict": "real" | "falsa" | "no_noticia" | "dudosa",
  "rationale": "Explicación breve (máx. 2 líneas)"
  "labels": ["clickbait"|"sin_fuente"|"contradice_fuentes"|"sesgada"|"descontextualizada"|"rumor"|"satira"|"neutral"],
  "evidence": [{"claim":"...", "assessment":"soporta|refuta|incierto", "sources":["https://..."]}],
  "checks": {"fecha_coherente":true|false, "fuente_identificable":true|false, "consenso_en_fuentes":true|false}
}

Texto a verificar:
- Título: ${title}
- Fuente: ${source}
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
    const combinedResult = {
      gemini: {
        ...geminiResult,
        latency_ms: geminiLatency
      },
      ml: mlAnalysis.ml_analysis,
      final: {
        verdict: mlAnalysis.final_verdict || geminiResult.verdict,
        score: Math.round(mlAnalysis.combined_confidence * 100) || geminiResult.score,
        confidence: mlAnalysis.combined_confidence || (geminiResult.score / 100),
        explanation: `Análisis híbrido: Gemini + Modelo ML (${mlAnalysis.ml_analysis?.ml_features_used || 0} características)`,
        method: mlAnalysis.analysis_method || "gemini_standalone"
      }
    };

    // --- Guardar en historial ---
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
  });
} catch (e) {
  console.error("❌ Error al iniciar app.listen:", e);
}