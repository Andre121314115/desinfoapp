// frontend/js/main.js

// =========================
// Configuración base
// =========================
const API =
  typeof window !== "undefined" && window.API_BASE
    ? window.API_BASE
    : "http://localhost:3000";

const $ = (q) => document.querySelector(q);

// Elementos principales
const btnAnalyze = $("#btnAnalyze");
const resultBox = $("#result");
const historyBox = $("#history");

// =========================
// Navegación entre secciones
// =========================
function initNavigation() {
  const navItems = document.querySelectorAll(".nav-item");
  const sections = document.querySelectorAll(".content-section");

  navItems.forEach((item) => {
    item.addEventListener("click", function (e) {
      e.preventDefault();

      navItems.forEach((nav) => nav.classList.remove("active"));
      sections.forEach((section) => section.classList.remove("active"));

      this.classList.add("active");

      const sectionId = this.getAttribute("data-section") + "-section";
      const targetSection = document.getElementById(sectionId);
      if (targetSection) {
        targetSection.classList.add("active");

        if (sectionId === "history-section") {
          loadHistory($("#search")?.value.trim() || "");
        } else if (sectionId === "calibration-section") {
          loadCalibrationLog();
          updateCalibrationStats();
        }
      }
    });
  });
}

// =========================
// Estado del sistema (API + ML local)
// =========================
async function updateSystemStatus() {
  const statusGemini = $("#statusGemini"); // ahora “API”
  const statusML = $("#statusML");

  if (!statusGemini && !statusML) return;

  // Estado ML local
  try {
    const res = await fetch(API + "/ml-status");
    const json = await res.json();

    if (statusML) {
      if (json.ok && json.model_exists) {
        statusML.textContent = "🤖 Modelo local de apoyo activo";
        statusML.classList.remove("status-bad");
        statusML.classList.add("status-ok");
      } else {
        statusML.textContent = "⚠️ Modelo local no disponible";
        statusML.classList.remove("status-ok");
        statusML.classList.add("status-bad");
      }
    }
  } catch (e) {
    console.warn("No se pudo consultar /ml-status:", e);
    if (statusML) {
      statusML.textContent = "⚠️ Modelo local sin respuesta";
      statusML.classList.remove("status-ok");
      statusML.classList.add("status-bad");
    }
  }

  // Estado general de la API
  try {
    const res = await fetch(API + "/health");
    const json = await res.json();

    if (statusGemini) {
      if (json.ok) {
        const mlInfo = json.ml_ready ? " + ML local" : "";
        statusGemini.textContent = `🔎 Verificador en línea (API${mlInfo})`;
        statusGemini.classList.remove("status-bad");
        statusGemini.classList.add("status-ok");
      } else {
        statusGemini.textContent = "⚠️ Verificador con problemas";
        statusGemini.classList.remove("status-ok");
        statusGemini.classList.add("status-bad");
      }
    }
  } catch (e) {
    console.warn("No se pudo consultar /health:", e);
    if (statusGemini) {
      statusGemini.textContent = "⚠️ Verificador sin respuesta";
      statusGemini.classList.remove("status-ok");
      statusGemini.classList.add("status-bad");
    }
  }
}

// =========================
// Análisis de noticia (HU01, HU02, HU03, HU08)
// =========================
btnAnalyze?.addEventListener("click", async () => {
  const data = {
    source: $("#source")?.value.trim() || "",
    title: $("#title")?.value.trim() || "",
    body: $("#body")?.value.trim() || "",
  };

  if (!data.title && !data.body) {
    alert("Ingresa al menos título o cuerpo.");
    return;
  }

  btnAnalyze.disabled = true;
  btnAnalyze.textContent = "🔍 Analizando...";

  try {
    const res = await fetch(API + "/analyze", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(data),
    });

    const json = await res.json();
    if (!json.ok) throw new Error(json.error || "Error en análisis");

    const resultData = json.result;
    const analysisId = json.saved?.id ?? null;

    await showAnalysisResults(resultData, analysisId);
    await loadHistory();
    await updateSystemStatus();
  } catch (e) {
    console.error(e);
    alert("Error al conectar con la API");
  } finally {
    btnAnalyze.disabled = false;
    btnAnalyze.textContent = "🔍 Analizar Noticia";
  }
});

// =========================
// HU08: Mostrar resultados con explicaciones
// =========================
async function showAnalysisResults(resultData, analysisId = null) {
  if (!resultBox) return;

  const final = resultData.final || {};
  const llm = resultData.llm || resultData.groq || resultData.gemini || {};
  const mlPart = resultData.ml || {};
  const explanations = resultData.explanations || {};

  const score = final.score ?? llm.score ?? 50;
  const verdictRaw = final.verdict || llm.verdict || "no_verificable";
  const verdict = String(verdictRaw || "").toLowerCase();
  const rationale = final.explanation || llm.rationale || "";
  const labels = llm.labels || [];
  const evidence = llm.evidence || [];

  const verdictClass =
    verdict === "falsa"
      ? "verdict-badge verdict-falsa"
      : verdict === "dudosa"
      ? "verdict-badge verdict-dudosa"
      : verdict === "no_verificable"
      ? "verdict-badge verdict-no-verificable"
      : "verdict-badge verdict-creible";

  const scoreClass =
    score < 30
      ? "score-bar-inner score-bad"
      : score < 60
      ? "score-bar-inner score-medium"
      : "score-bar-inner score-good";

  let confidenceClass = "medium-confidence";
  if (explanations.confidence === "alta") confidenceClass = "high-confidence";
  else if (explanations.confidence === "baja") confidenceClass = "low-confidence";

  resultBox.style.display = "block";
  resultBox.innerHTML = `
    <div class="result">
      <div class="result-header">
        <div class="score">
          <span class="score-value">${score}</span>
          <span class="score-label">puntaje de veracidad (0–100)</span>
          <span class="${verdictClass}">
            ${String(verdict || "").toUpperCase()}
          </span>
        </div>
      </div>

      <div class="score-bar">
        <div class="${scoreClass}" style="width:${Math.max(
          0,
          Math.min(score, 100)
        )}%;"></div>
      </div>

      ${
        labels.length > 0
          ? `
        <div class="mt-8">
          <strong>🏷️ Etiquetas identificadas:</strong> 
          ${labels.map((x) => `<span class="pill">${x}</span>`).join(" ")}
        </div>
      `
          : ""
      }

      <div class="explanations-section">
        <h3>🧩 Explicación del Resultado</h3>
        
        <div class="explanation-card">
          <div class="explanation-simple ${confidenceClass}">
            ${
              explanations.simple ||
              "Análisis completado. Revisa los detalles para más información."
            }
          </div>
          
          <div class="explanation-actions">
            <button id="btnToggleDetails" class="btn-outline">📖 Ver detalles técnicos</button>
            <button id="btnCopyExplanation" class="btn-outline">📋 Copiar explicación</button>
            <button id="btnShareExplanation" class="btn-outline">📤 Compartir resultado</button>
          </div>
          
          <div id="detailedExplanation" class="explanation-detailed" style="display: none;">
            ${
              explanations.detailed ||
              rationale ||
              "No hay explicación detallada disponible."
            }
          </div>
        </div>
        
        ${
          explanations.factors && explanations.factors.length
            ? `
          <div class="explanation-factors">
            <h4>🔍 Factores considerados</h4>
            <div class="factors-grid">
              ${explanations.factors
                .map(
                  (factor) => `
                <div class="factor-item">
                  <span class="explanation-badge">${getFactorEmoji(
                    factor
                  )}</span>
                  ${factor.replace("• ", "")}
                </div>
              `
                )
                .join("")}
            </div>
          </div>
        `
            : ""
        }
      </div>

      ${
        evidence.length
          ? `
        <div class="mt-8">
          <strong>🔎 Evidencia encontrada:</strong>
          <ul class="evidence-list">
            ${evidence
              .map(
                (ev) => `
              <li>
                <div class="claim"><em>${ev.claim || "—"}</em> — <b>${
                  ev.assessment || "incierto"
                }</b></div>
                <div class="sources">
                  ${
                    (ev.sources || [])
                      .slice(0, 3)
                      .map(
                        (u) =>
                          `<a href="${u}" target="_blank" rel="noopener">${u}</a>`
                      )
                      .join("<br/>") || "—"
                  }
                </div>
              </li>
            `
              )
              .join("")}
          </ul>
        </div>
      `
          : ""
      }

      ${
        mlPart && typeof mlPart.ml_features_used !== "undefined"
          ? `
        <div class="mt-8 ml-info">
          <small>🤖 Análisis reforzado con modelo local (${mlPart.ml_features_used} características)</small>
        </div>
      `
          : ""
      }

      ${
        analysisId
          ? `
        <div class="feedback-section mt-8">
          <h4>💡 ¿El análisis te pareció correcto?</h4>
          <p class="muted">Tu opinión ayuda a que el sistema mejore y sea más confiable.</p>
          <div class="feedback-buttons">
            <button id="btnFeedbackOk" class="btn-success">
              ✅ Sí, coincide con la realidad
            </button>
            <button id="btnFeedbackFix" class="btn-secondary">
              ❌ No, quiero corregir
            </button>
          </div>
          <div id="feedbackForm" style="display: none; margin-top: 1rem;">
            <label class="form-label">Score correcto (0-100)</label>
            <input type="number" id="correctScore" class="form-input" placeholder="Ej: 90" min="0" max="100">
            
            <label class="form-label" style="margin-top:0.5rem;">Veredicto correcto</label>
            <select id="correctVerdict" class="form-input">
              <option value="real">Real / Confiable</option>
              <option value="falsa">Falsa</option>
              <option value="dudosa">Dudosa</option>
            </select>

            <button id="btnSubmitFeedback" class="submit-btn" style="margin-top:0.5rem;">
              Enviar corrección
            </button>
          </div>
        </div>
      `
          : ""
      }
    </div>
  `;

  initExplanationFeatures(explanations);

  if (analysisId) {
    initFeedbackFeatures(analysisId, score, verdict);
  }
}

// =========================
// HU08: Funciones auxiliares de explicaciones
// =========================
function initExplanationFeatures(explanations) {
  $("#btnToggleDetails")?.addEventListener("click", function () {
    const detailedSection = $("#detailedExplanation");
    const isVisible = detailedSection.style.display === "block";

    detailedSection.style.display = isVisible ? "none" : "block";
    this.textContent = isVisible
      ? "📖 Ver detalles técnicos"
      : "👁️ Ocultar detalles";
  });

  $("#btnCopyExplanation")?.addEventListener("click", function () {
    const simpleExplanation = explanations.simple || "";
    const detailedExplanation = explanations.detailed || "";

    const textToCopy = `🔍 Análisis de veracidad:\n\n${simpleExplanation}\n\n${detailedExplanation}`;

    navigator.clipboard.writeText(textToCopy).then(() => {
      const originalText = this.textContent;
      this.textContent = "✅ Copiado";
      setTimeout(() => {
        this.textContent = originalText;
      }, 2000);
    });
  });

  $("#btnShareExplanation")?.addEventListener("click", function () {
    const simpleExplanation = explanations.simple || "";

    if (navigator.share) {
      navigator.share({
        title: "Resultado de análisis de noticia",
        text: simpleExplanation,
        url: window.location.href,
      });
    } else {
      alert(
        'La función de compartir no está disponible en este dispositivo. Usa "Copiar explicación".'
      );
    }
  });
}

function getFactorEmoji(factor) {
  const emojiMap = {
    titular: "⚠️",
    sensacionalista: "🎭",
    engañoso: "🤥",
    fuentes: "🔍",
    confiables: "✅",
    transparencia: "📝",
    contradice: "❌",
    datos: "📊",
    consenso: "👍",
  };

  for (const [key, emoji] of Object.entries(emojiMap)) {
    if (factor.toLowerCase().includes(key)) return emoji;
  }

  return "📌";
}

// =========================
// Feedback / Aprendizaje continuo
// =========================
function initFeedbackFeatures(analysisId, currentScore, currentVerdict) {
  const btnOk = $("#btnFeedbackOk");
  const btnFix = $("#btnFeedbackFix");
  const form = $("#feedbackForm");
  const inputScore = $("#correctScore");
  const selectVerdict = $("#correctVerdict");
  const btnSubmit = $("#btnSubmitFeedback");

  if (!btnOk || !btnFix || !form || !inputScore || !selectVerdict || !btnSubmit)
    return;

  btnOk.addEventListener("click", async () => {
    await sendFeedback({
      analysis_id: analysisId,
      correct_score: currentScore,
      correct_verdict: currentVerdict || "real",
      user_feedback: "analysis_correct",
    });
  });

  btnFix.addEventListener("click", () => {
    form.style.display = "block";
  });

  btnSubmit.addEventListener("click", async () => {
    const valScore = Number(inputScore.value);
    const valVerdict = selectVerdict.value || "real";

    if (Number.isNaN(valScore) || valScore < 0 || valScore > 100) {
      alert("Ingresa un score entre 0 y 100.");
      return;
    }

    await sendFeedback({
      analysis_id: analysisId,
      correct_score: valScore,
      correct_verdict: valVerdict,
      user_feedback: "user_corrected",
    });
  });
}

async function sendFeedback(payload) {
  try {
    await fetch(API + "/feedback", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    alert("✅ ¡Gracias! El sistema usará este feedback para mejorar.");
  } catch (error) {
    console.error("Error enviando feedback:", error);
    alert("⚠️ No se pudo enviar el feedback.");
  }
}

// =========================
// HU07: Calibración del sistema
// =========================
document
  .getElementById("btnRunCalibration")
  ?.addEventListener("click", async function () {
    const btn = this;
    btn.disabled = true;
    btn.textContent = "🔄 Calibrando...";

    try {
      const response = await fetch(API + "/calibrate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
      });

      const result = await response.json();

      if (result.ok) {
        showCalibrationResults(result);
        updateCalibrationStats(result);
        await loadCalibrationLog();
      } else {
        alert("Error en calibración: " + result.error);
      }
    } catch (error) {
      console.error("Error:", error);
      alert("Error al conectar con el servidor");
    } finally {
      btn.disabled = false;
      btn.textContent = "Ejecutar Calibración";
    }
  });

document
  .getElementById("btnViewCalibrationLog")
  ?.addEventListener("click", function () {
    const logSection = document.getElementById("calibrationLog");
    if (!logSection) return;
    logSection.style.display =
      logSection.style.display === "none" ? "block" : "none";
    if (logSection.style.display === "block") {
      loadCalibrationLog();
    }
  });

function showCalibrationResults(data) {
  const resultsContainer = document.getElementById("calibrationResults");
  if (!resultsContainer) return;

  resultsContainer.style.display = "block";

  resultsContainer.innerHTML = `
    <h3>✅ Calibración completada</h3>
    <p><strong>Resultado:</strong> ${data.message}</p>
    <p><strong>Precisión promedio:</strong> ${data.avg_accuracy}%</p>
    <p><strong>Tasa de calibración:</strong> ${data.calibration_rate}%</p>
    
    <div class="mt-8">
      <h4>📊 Resultados detallados</h4>
      ${data.results
        .map(
          (item) => `
        <div class="calibration-item ${
          item.accuracy < 80 ? "warning" : ""
        }">
          <div><strong>Análisis ID:</strong> ${String(item.analysis_id).substring(
            0,
            8
          )}...</div>
          <div><strong>Score:</strong> ${
            item.original_score
          } → ${item.calibrated_score}</div>
          <div><strong>Coincidencias:</strong> ${item.matches_found}</div>
          <div><strong>Precisión:</strong> ${item.accuracy}%</div>
        </div>
      `
        )
        .join("")}
    </div>
  `;
}

async function loadCalibrationLog() {
  const logContent = document.getElementById("calibrationLogContent");
  if (!logContent) return;

  try {
    const response = await fetch(API + "/calibration-logs");
    const data = await response.json();

    if (data.ok && data.logs.length > 0) {
      logContent.innerHTML = `
        <table class="history">
          <thead>
            <tr>
              <th>Fecha</th>
              <th>Análisis</th>
              <th>Calibrados</th>
              <th>Tasa</th>
              <th>Precisión</th>
            </tr>
          </thead>
          <tbody>
            ${data.logs
              .map(
                (log) => `
              <tr>
                <td>${new Date(log.timestamp).toLocaleString()}</td>
                <td>${log.total_analyses}</td>
                <td>${log.calibrated_analyses}</td>
                <td>${log.calibration_rate}%</td>
                <td>${log.average_accuracy}%</td>
              </tr>
            `
              )
              .join("")}
          </tbody>
        </table>
      `;
    } else {
      logContent.innerHTML =
        '<p class="muted">No hay registros de calibración disponibles.</p>';
    }
  } catch (error) {
    console.error("Error cargando registro:", error);
    logContent.innerHTML = '<p class="muted">Error al cargar registros.</p>';
  }
}

function updateCalibrationStats(data = null) {
  const elAcc = document.getElementById("calibrationAccuracy");
  const elCount = document.getElementById("calibratedCount");
  const elRate = document.getElementById("calibrationRate");
  if (!elAcc || !elCount || !elRate) return;

  if (data) {
    elAcc.textContent = `${data.avg_accuracy}%`;
    elCount.textContent = data.results.length;
    elRate.textContent = `${data.calibration_rate}%`;
  }
}

// =========================
// Subir dataset (HU06)
// =========================
document
  .getElementById("btnUploadDataset")
  ?.addEventListener("click", function () {
    const fileInput = document.getElementById("datasetFile");
    const msg = document.getElementById("uploadMessage");
    const file = fileInput?.files?.[0];
    if (!file) {
      alert("Selecciona un archivo");
      return;
    }

    const formData = new FormData();
    formData.append("file", file);

    const headers = new Headers();
    const userPass = btoa("admin:1234");
    headers.append("Authorization", "Basic " + userPass);

    fetch(API + "/upload-dataset", { method: "POST", body: formData, headers })
      .then((res) => res.json())
      .then((data) => {
        if (msg) msg.innerText = data.message || "Dataset procesado.";
        console.log("✅ Respuesta del backend:", data);
      })
      .catch((err) => {
        console.error("❌ Error subiendo dataset:", err);
        if (msg) msg.innerText = "Error al subir el dataset.";
      });
  });

// =========================
// Entrenar modelo local (usa dataset.json)
// =========================
document
  .getElementById("btnTrainML")
  ?.addEventListener("click", async function () {
    const btn = this;
    const status = document.getElementById("trainMLStatus");

    btn.disabled = true;
    const prevText = btn.textContent;
    btn.textContent = "🔄 Entrenando modelo...";
    if (status) status.textContent = "Entrenando modelo local con dataset.json...";

    try {
      const res = await fetch(API + "/train-ml", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
      });

      const json = await res.json();

      if (json.ok) {
        if (status) {
          status.textContent =
            json.message ||
            "✅ Entrenamiento completado. El modelo local fue actualizado.";
        }
        // refrescamos estado del sistema para que /ml-status muestre el nuevo modelo
        updateSystemStatus();
      } else {
        if (status) {
          status.textContent =
            "⚠️ Error entrenando el modelo: " + (json.error || "Error desconocido");
        }
      }
    } catch (err) {
      console.error("❌ Error al entrenar modelo:", err);
      if (status) status.textContent = "⚠️ No se pudo conectar al backend.";
    } finally {
      btn.disabled = false;
      btn.textContent = prevText;
    }
  });

// =========================
// Historial + Métricas (HU05, HU09)
// =========================
async function loadHistory(q = "") {
  if (!historyBox) return;

  try {
    const res = await fetch(API + "/history?q=" + encodeURIComponent(q));
    const json = await res.json();
    if (!json.ok) throw new Error("Fallo en /history");
    const arr = json.items || [];
    renderMetrics(arr);

    if (!arr.length) {
      historyBox.innerHTML = `<p class="muted">Sin resultados.</p>`;
      return;
    }

    const rows = arr
      .map((x) => {
        const verdict = x.verdict || "—";
        const verdictLower = String(verdict).toLowerCase();

        let verdictColor = "#16a34a";
        if (verdictLower === "falsa") verdictColor = "#dc2626";
        else if (verdictLower.startsWith("dud")) verdictColor = "#d97706";
        else if (verdictLower.includes("no_verificable"))
          verdictColor = "#64748b";

        const scoreNum = Number(x.score) || 0;
        const scoreColor =
          scoreNum < 30 ? "#dc2626" : scoreNum < 60 ? "#d97706" : "#16a34a";

        return `
        <tr>
          <td>${new Date(x.created_at).toLocaleString()}</td>
          <td>${x.source || "—"}</td>
          <td>${x.title || "—"}</td>
          <td style="font-weight:600;color:${scoreColor}">${scoreNum}</td>
          <td><span class="verdict-chip" style="background:${verdictColor}">${String(
            verdict
          ).toUpperCase()}</span></td>
          <td>${(x.labels || []).join(", ")}</td>
          <td>${x.rationale || "—"}</td>
        </tr>
      `;
      })
      .join("");

    historyBox.innerHTML = `
      <table>
        <thead><tr>
          <th>Fecha</th><th>Fuente</th><th>Título</th><th>Score</th><th>Veredicto</th><th>Etiquetas</th><th>Explicación</th>
        </tr></thead>
        <tbody>${rows}</tbody>
      </table>
      <p class="muted">Total: ${json.total}</p>
    `;

    initComparisonHooks(arr);
  } catch (e) {
    console.error(e);
    historyBox.innerHTML = `<p class="muted">No se pudo cargar historial.</p>`;
    renderMetrics([]);
  }
}

function renderMetrics(items) {
  const total = items.length;
  const avg = total
    ? items.reduce((s, x) => s + (Number(x.score) || 0), 0) / total
    : 0;
  const lat = total
    ? items.reduce((s, x) => s + (Number(x.latency_ms) || 0), 0) / total
    : 0;
  const high = items.filter((x) => (Number(x.score) || 0) < 30).length;

  const counts = items.reduce(
    (acc, x) => {
      const v = (x.verdict || "nv").toLowerCase();
      if (v.startsWith("cre") || v.startsWith("rea") || v.startsWith("ver"))
        acc.c++;
      else if (v.startsWith("dud")) acc.d++;
      else if (v.startsWith("fal")) acc.f++;
      else acc.nv++;
      return acc;
    },
    { c: 0, d: 0, f: 0, nv: 0 }
  );

  $("#kpiTotal") && ($("#kpiTotal").textContent = total);
  $("#kpiAvgScore") && ($("#kpiAvgScore").textContent = avg.toFixed(1));
  $("#kpiAvgLatency") &&
    ($("#kpiAvgLatency").textContent = `${Math.round(lat)} ms`);
  $("#kpiHighRisk") && ($("#kpiHighRisk").textContent = high);
  $("#kpiVerdicts") &&
    ($("#kpiVerdicts").textContent = `C:${counts.c} • D:${counts.d} • F:${counts.f} • NV:${counts.nv}`);
}

// =========================
// HU11: ganchos para comparación de noticias
// =========================
function initComparisonHooks(items) {
  const panel = document.getElementById("comparisonPanel");
  if (!panel) return;

  if (items.length < 2) {
    panel.innerHTML =
      '<p class="muted">Analiza al menos dos noticias para habilitar la comparación.</p>';
    return;
  }

  const [a, b] = items.slice(0, 2);

  panel.innerHTML = `
    <div class="comparison-panel">
      <div class="comparison-toolbar">
        <span class="muted">Comparando las dos noticias más recientes del historial</span>
      </div>
      <div class="comparison-grid">
        ${renderComparisonCard(a)}
        ${renderComparisonCard(b)}
      </div>
    </div>
  `;
}

function renderComparisonCard(item) {
  const score = Number(item.score) || 0;
  const verdict = String(item.verdict || "—").toUpperCase();

  return `
    <div class="comparison-card">
      <h4>${item.title || "—"}</h4>
      <div class="comparison-meta">${item.source || "—"} · ${new Date(
    item.created_at
  ).toLocaleString()}</div>
      <div class="comparison-score">Score: <strong>${score}</strong></div>
      <div class="comparison-meta">Veredicto: ${verdict}</div>
      <div class="comparison-meta">Etiquetas: ${(item.labels || []).join(
        ", "
      ) || "—"}</div>
    </div>
  `;
}

// =========================
// Botones generales
// =========================
$("#btnReload")?.addEventListener("click", () => {
  loadHistory($("#search")?.value.trim() || "");
  updateSystemStatus();
});

$("#btnExport")?.addEventListener("click", () =>
  window.open(API + "/export/csv", "_blank")
);

$("#search")?.addEventListener("keyup", (e) => {
  if (e.key === "Enter") loadHistory($("#search").value.trim());
});

// =========================
// Inicialización
// =========================
document.addEventListener("DOMContentLoaded", function () {
  initNavigation();
  loadHistory();
  loadCalibrationLog();
  updateSystemStatus();
});
