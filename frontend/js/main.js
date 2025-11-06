// Configuración
const API = (typeof window !== 'undefined' && window.API_BASE)
  ? window.API_BASE
  : "http://localhost:3000";

const $ = (q) => document.querySelector(q);

// Elementos principales
const btn = $("#btnAnalyze");
const resultBox = $("#result");
const historyBox = $("#history");

// Navegación entre secciones
function initNavigation() {
    const navItems = document.querySelectorAll('.nav-item');
    const sections = document.querySelectorAll('.content-section');
    
    navItems.forEach(item => {
        item.addEventListener('click', function(e) {
            e.preventDefault();
            
            // Remover activo de todos
            navItems.forEach(nav => nav.classList.remove('active'));
            sections.forEach(section => section.classList.remove('active'));
            
            // Activar elemento clickeado
            this.classList.add('active');
            
            // Mostrar sección correspondiente
            const sectionId = this.getAttribute('data-section') + '-section';
            const targetSection = document.getElementById(sectionId);
            if (targetSection) {
                targetSection.classList.add('active');
                
                // Cargar datos específicos de cada sección
                if (sectionId === 'history-section') {
                    loadHistory($("#search").value.trim());
                } else if (sectionId === 'calibration-section') {
                    loadCalibrationLog();
                    updateCalibrationStats();
                }
            }
        });
    });
}

// Análisis de noticia
btn.addEventListener("click", async () => {
    const data = {
        source: $("#source").value.trim(),
        title: $("#title").value.trim(),
        body: $("#body").value.trim()
    };
    
    if (!data.title && !data.body) {
        alert("Ingresa al menos título o cuerpo.");
        return;
    }

    btn.disabled = true;
    btn.textContent = "🔍 Analizando...";

    try {
        const res = await fetch(API + "/analyze", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(data)
        });
        
        const json = await res.json();
        if (!json.ok) throw new Error(json.error || "Error en análisis");

        // Procesar respuesta
        const resultData = json.result;
        await showAnalysisResults(resultData);
        await loadHistory();
        
    } catch (e) {
        console.error(e);
        alert("Error al conectar con la API");
    } finally {
        btn.disabled = false;
        btn.textContent = "🔍 Analizar Noticia";
    }
});

// ✅ HU08: Mostrar resultados con explicaciones mejoradas
async function showAnalysisResults(resultData) {
    const final = resultData.final || {};
    const gemini = resultData.gemini || {};
    const explanations = resultData.explanations || {};

    const score = final.score || gemini.score;
    const verdict = final.verdict || gemini.verdict;
    const rationale = final.explanation || gemini.rationale;
    const labels = gemini.labels || [];
    const evidence = gemini.evidence || [];

    const verdictBadgeColor =
        verdict === "falsa" ? "#dc2626" :
        verdict === "dudosa" ? "#d97706" :
        verdict === "no_verificable" ? "#64748b" : "#16a34a";

        // ✅ AGREGAR BOTONES DE FEEDBACK
function addFeedbackButtons(analysisId, currentScore) {
  const feedbackHTML = `
    <div class="feedback-section mt-8">
      <h4>💡 ¿El análisis fue correcto?</h4>
      <div class="feedback-buttons">
        <button class="btn-success" onclick="sendFeedback('${analysisId}', ${currentScore}, 'correct')">
          ✅ Sí, es correcto
        </button>
        <button class="btn-secondary" onclick="showFeedbackForm('${analysisId}', ${currentScore})">
          ❌ No, corregir
        </button>
      </div>
      <div id="feedbackForm" style="display: none; margin-top: 1rem;">
        <input type="number" id="correctScore" placeholder="Score correcto (0-100)" min="0" max="100">
        <select id="correctVerdict">
          <option value="real">Real</option>
          <option value="falsa">Falsa</option>
          <option value="dudosa">Dudosa</option>
        </select>
        <button onclick="submitFeedback('${analysisId}')">Enviar corrección</button>
      </div>
    </div>
  `;
  
  resultBox.innerHTML += feedbackHTML;
}

// ✅ FUNCIONES DE FEEDBACK
async function sendFeedback(analysisId, currentScore, type) {
  const correctScore = type === 'correct' ? currentScore : document.getElementById('correctScore').value;
  const correctVerdict = type === 'correct' ? 'real' : document.getElementById('correctVerdict').value;
  
  try {
    await fetch(API + '/feedback', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        analysis_id: analysisId,
        correct_verdict: correctVerdict,
        correct_score: correctScore,
        user_feedback: type === 'correct' ? 'analysis_correct' : 'user_corrected'
      })
    });
    
    alert('✅ Gracias por el feedback! El sistema aprenderá de esta corrección.');
  } catch (error) {
    console.error('Error enviando feedback:', error);
  }
}

function showFeedbackForm(analysisId, currentScore) {
  document.getElementById('feedbackForm').style.display = 'block';
}

    // ✅ HU08: Construir interfaz de explicaciones mejorada
    resultBox.style.display = "block";
    resultBox.innerHTML = `
        <div class="score">
            🎯 Score: <strong>${score}/100</strong>
            <span class="verdict-badge" style="background:${verdictBadgeColor}">
                ${String(verdict || '').toUpperCase() || "—"}
            </span>
        </div>
        
        ${labels.length > 0 ? `
            <div class="mt-8">
                <strong>🏷️ Etiquetas identificadas:</strong> 
                ${labels.map(x => `<span class="pill">${x}</span>`).join(" ")}
            </div>
        ` : ''}
        
        <!-- ✅ HU08: Sección de Explicaciones Mejorada -->
        <div class="explanations-section">
            <h3>🧩 Explicación del Resultado</h3>
            
            <div class="explanation-card">
                <div class="explanation-simple ${explanations.confidence || 'medium-confidence'}">
                    ${explanations.simple || "Análisis completado. Revisa los detalles para más información."}
                </div>
                
                <div class="explanation-actions">
                    <button id="btnToggleDetails" class="btn-outline">📖 Ver detalles técnicos</button>
                    <button id="btnCopyExplanation" class="btn-outline">📋 Copiar explicación</button>
                    <button id="btnShareExplanation" class="btn-outline">📤 Compartir resultado</button>
                </div>
                
                <div id="detailedExplanation" class="explanation-detailed" style="display: none;">
                    ${explanations.detailed || "No hay explicación detallada disponible."}
                </div>
            </div>
            
            ${explanations.factors && explanations.factors.length > 0 ? `
                <div class="explanation-factors">
                    <h4>🔍 Factores Considerados</h4>
                    <div class="factors-grid">
                        ${explanations.factors.map(factor => `
                            <div class="factor-item">
                                <span class="explanation-badge">${getFactorEmoji(factor)}</span>
                                ${factor.replace('• ', '')}
                            </div>
                        `).join('')}
                    </div>
                </div>
            ` : ''}
        </div>
        
        ${evidence.length > 0 ? `
            <div class="mt-8">
                <strong>🔎 Evidencia encontrada:</strong>
                <ul class="evidence-list">
                    ${evidence.map(ev => `
                        <li>
                            <div class="claim"><em>${ev.claim || "—"}</em> — <b>${ev.assessment || "incierto"}</b></div>
                            <div class="sources">
                                ${(ev.sources||[]).slice(0,3).map(u => `<a href="${u}" target="_blank" rel="noopener">${u}</a>`).join("<br/>") || "—"}
                            </div>
                        </li>
                    `).join("")}
                </ul>
            </div>
        ` : ''}
        
        ${resultData.ml ? `
            <div class="mt-8 ml-info">
                <small>🤖 Análisis mejorado con ML (${resultData.ml.ml_features_used || 0} características)</small>
            </div>
        ` : ''}
    `;

    // ✅ HU08: Inicializar funcionalidades de explicaciones
    initExplanationFeatures(explanations);
}

// ✅ HU08: Funcionalidades para explicaciones
function initExplanationFeatures(explanations) {
    // Toggle detalles técnicos
    $("#btnToggleDetails")?.addEventListener('click', function() {
        const detailedSection = $("#detailedExplanation");
        const isVisible = detailedSection.style.display === 'block';
        
        detailedSection.style.display = isVisible ? 'none' : 'block';
        this.textContent = isVisible ? '📖 Ver detalles técnicos' : '👁️ Ocultar detalles';
    });
    
    // Copiar explicación
    $("#btnCopyExplanation")?.addEventListener('click', function() {
        const simpleExplanation = explanations.simple || "";
        const detailedExplanation = explanations.detailed || "";
        
        const textToCopy = `🔍 Análisis de Veracidad:\n\n${simpleExplanation}\n\n${detailedExplanation}`;
        
        navigator.clipboard.writeText(textToCopy).then(() => {
            const originalText = this.textContent;
            this.textContent = '✅ Copiado!';
            setTimeout(() => {
                this.textContent = originalText;
            }, 2000);
        });
    });
    
    // Compartir resultado
    $("#btnShareExplanation")?.addEventListener('click', function() {
        const simpleExplanation = explanations.simple || "";
        
        if (navigator.share) {
            navigator.share({
                title: 'Resultado de Análisis de Veracidad',
                text: simpleExplanation,
                url: window.location.href
            });
        } else {
            alert('Función de compartir no disponible. Usa la opción "Copiar explicación" instead.');
        }
    });
}

function getFactorEmoji(factor) {
    const emojiMap = {
        'titular': '⚠️',
        'sensacionalista': '🎭',
        'engañoso': '🤥',
        'fuentes': '🔍',
        'confiables': '✅',
        'transparencia': '📝',
        'contradice': '❌',
        'datos': '📊',
        'consenso': '👍'
    };
    
    for (const [key, emoji] of Object.entries(emojiMap)) {
        if (factor.toLowerCase().includes(key)) return emoji;
    }
    
    return '📌';
}

// ✅ HU07: Calibración del sistema
document.getElementById('btnRunCalibration')?.addEventListener('click', async function() {
    const btn = this;
    btn.disabled = true;
    btn.textContent = '🔄 Calibrando...';
    
    try {
        const response = await fetch(API + '/calibrate', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' }
        });
        
        const result = await response.json();
        
        if (result.ok) {
            showCalibrationResults(result);
            updateCalibrationStats(result);
            await loadCalibrationLog();
        } else {
            alert('Error en calibración: ' + result.error);
        }
    } catch (error) {
        console.error('Error:', error);
        alert('Error al conectar con el servidor');
    } finally {
        btn.disabled = false;
        btn.textContent = '🔄 Ejecutar Calibración';
    }
});

// ✅ HU07: Ver registros de calibración
document.getElementById('btnViewCalibrationLog')?.addEventListener('click', function() {
    const logSection = document.getElementById('calibrationLog');
    logSection.style.display = logSection.style.display === 'none' ? 'block' : 'none';
    if (logSection.style.display === 'block') {
        loadCalibrationLog();
    }
});

// ✅ HU07: Mostrar resultados de calibración
function showCalibrationResults(data) {
    const resultsContainer = document.getElementById('calibrationResults');
    resultsContainer.style.display = 'block';
    
    const resultsHTML = `
        <h3>✅ Calibración Completada</h3>
        <p><strong>Resultado:</strong> ${data.message}</p>
        <p><strong>Precisión promedio:</strong> ${data.avg_accuracy}%</p>
        <p><strong>Tasa de calibración:</strong> ${data.calibration_rate}%</p>
        
        <div class="mt-8">
            <h4>📊 Resultados Detallados:</h4>
            ${data.results.map(item => `
                <div class="calibration-item ${item.accuracy < 80 ? 'warning' : ''}">
                    <div><strong>Análisis ID:</strong> ${String(item.analysis_id).substring(0, 8)}...</div>
                    <div><strong>Score:</strong> ${item.original_score} → ${item.calibrated_score}</div>
                    <div><strong>Coincidencias:</strong> ${item.matches_found}</div>
                    <div><strong>Precisión:</strong> ${item.accuracy}%</div>
                </div>
            `).join('')}
        </div>
    `;
    
    resultsContainer.innerHTML = resultsHTML;
}

// ✅ HU07: Cargar logs de calibración
async function loadCalibrationLog() {
    try {
        const response = await fetch(API + '/calibration-logs');
        const data = await response.json();
        
        const logContent = document.getElementById('calibrationLogContent');
        
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
                        ${data.logs.map(log => `
                            <tr>
                                <td>${new Date(log.timestamp).toLocaleString()}</td>
                                <td>${log.total_analyses}</td>
                                <td>${log.calibrated_analyses}</td>
                                <td>${log.calibration_rate}%</td>
                                <td>${log.average_accuracy}%</td>
                            </tr>
                        `).join('')}
                    </tbody>
                </table>
            `;
        } else {
            logContent.innerHTML = '<p class="muted">No hay registros de calibración disponibles.</p>';
        }
    } catch (error) {
        console.error('Error cargando registro:', error);
        document.getElementById('calibrationLogContent').innerHTML = '<p class="muted">Error al cargar registros.</p>';
    }
}

// ✅ HU07: Actualizar estadísticas de calibración
function updateCalibrationStats(data = null) {
    if (data) {
        document.getElementById('calibrationAccuracy').textContent = data.avg_accuracy + '%';
        document.getElementById('calibratedCount').textContent = data.results.length;
        document.getElementById('calibrationRate').textContent = data.calibration_rate + '%';
    }
}

// Subir dataset (existente)
document.getElementById('btnUploadDataset')?.addEventListener('click', function() {
    const fileInput = document.getElementById('datasetFile');
    const file = fileInput.files[0];
    if (!file) return alert('Selecciona un archivo');

    const formData = new FormData();
    formData.append('file', file);

    const headers = new Headers();
    const userPass = btoa('admin:1234');
    headers.append('Authorization', 'Basic ' + userPass);

    fetch(API + '/upload-dataset', { method: 'POST', body: formData, headers })
        .then(res => res.json())
        .then(data => {
            document.getElementById('uploadMessage').innerText = data.message;
            console.log("✅ Respuesta del backend:", data);
        })
        .catch(err => {
            console.error("❌ Error subiendo dataset:", err);
            document.getElementById('uploadMessage').innerText = "Error al subir el dataset.";
        });
});

// Historial + Métricas (existente)
async function loadHistory(q = "") {
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

        const rows = arr.map(x => {
            const verdict = x.verdict || "—";
            const verdictColor =
                verdict === "falsa" ? "#dc2626" :
                verdict === "dudosa" ? "#d97706" :
                verdict === "no_verificable" ? "#64748b" : "#16a34a";

            return `
                <tr>
                    <td>${new Date(x.created_at).toLocaleString()}</td>
                    <td>${x.source || "—"}</td>
                    <td>${x.title || "—"}</td>
                    <td style="font-weight:600;color:${x.score>75?"#dc2626":x.score>50?"#d97706":"#16a34a"}">${x.score}</td>
                    <td><span class="verdict-chip" style="background:${verdictColor}">${String(verdict).toUpperCase()}</span></td>
                    <td>${(x.labels||[]).join(", ")}</td>
                    <td>${x.rationale || "—"}</td>
                </tr>
            `;
        }).join("");

        historyBox.innerHTML = `
            <table>
                <thead><tr>
                    <th>Fecha</th><th>Fuente</th><th>Título</th><th>Score</th><th>Veredicto</th><th>Etiquetas</th><th>Explicación</th>
                </tr></thead>
                <tbody>${rows}</tbody>
            </table>
            <p class="muted">Total: ${json.total}</p>
        `;
    } catch (e) {
        console.error(e);
        historyBox.innerHTML = `<p class="muted">No se pudo cargar historial.</p>`;
        renderMetrics([]);
    }
}

function renderMetrics(items) {
    const total = items.length;
    const avg = total ? (items.reduce((s, x) => s + (Number(x.score) || 0), 0) / total) : 0;
    const lat = total ? (items.reduce((s, x) => s + (Number(x.latency_ms) || 0), 0) / total) : 0;
    const high = items.filter(x => (Number(x.score) || 0) >= 75).length;

    const counts = items.reduce((acc, x) => {
        const v = (x.verdict || "nv").toLowerCase();
        if (v.startsWith("cre")) acc.c++;
        else if (v.startsWith("dud")) acc.d++;
        else if (v.startsWith("fal")) acc.f++;
        else acc.nv++;
        return acc;
    }, { c: 0, d: 0, f: 0, nv: 0 });

    $("#kpiTotal").textContent = total;
    $("#kpiAvgScore").textContent = avg.toFixed(1);
    $("#kpiAvgLatency").textContent = `${Math.round(lat)} ms`;
    $("#kpiHighRisk").textContent = high;
    $("#kpiVerdicts").textContent = `C:${counts.c} • D:${counts.d} • F:${counts.f} • NV:${counts.nv}`;
}

// Event listeners
$("#btnReload")?.addEventListener("click", () => loadHistory($("#search").value.trim()));
$("#btnExport")?.addEventListener("click", () => window.open(API + "/export/csv", "_blank"));
$("#search")?.addEventListener("keyup", e => {
    if (e.key === "Enter") loadHistory($("#search").value.trim());
});

// Inicialización
document.addEventListener('DOMContentLoaded', function() {
    initNavigation();
    loadHistory();
    loadCalibrationLog();
});
