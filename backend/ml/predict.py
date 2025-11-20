# backend/ml/predict.py
import os
import sys
import json
import joblib

# -------------------------------------------------------------------
# CONFIG RUTAS
# -------------------------------------------------------------------
BASE_DIR = os.path.dirname(os.path.abspath(__file__))

# Debe coincidir con lo que usas en train_model.py
MODEL_PATH = os.path.join(BASE_DIR, "model.joblib")
MODEL_PATH = os.path.normpath(MODEL_PATH)

# -------------------------------------------------------------------
# CARGA DE MODELO
# -------------------------------------------------------------------
if not os.path.exists(MODEL_PATH):
    MODEL = None
else:
    MODEL = joblib.load(MODEL_PATH)


def main():
    raw = sys.stdin.read()
    if not raw:
        _fallback("sin_input")
        return

    try:
        data = json.loads(raw)
    except Exception:
        _fallback("json_parse_error")
        return

    news = data.get("news_data", {}) or {}

    # Campos esperados desde el backend
    title = (news.get("title") or "").strip()
    body = (news.get("body") or "").strip()
    source = (news.get("source") or "").strip()  # opcional
    gemini_score = float(data.get("gemini_score", 50))

    # ---------------------------------------------------------------
    # IMPORTANTE: el pipeline fue entrenado con una sola columna "texto"
    # (titulo + cuerpo + "Fuente: ..."). Aquí replicamos esa lógica.
    # ---------------------------------------------------------------
    full_text = f"{title} {body}"
    if source:
        full_text = f"{full_text} Fuente: {source}"

    # El modelo espera un iterable de textos
    X_input = [full_text]

    if MODEL is None:
        _fallback("model_not_loaded", base_score=gemini_score)
        return

    try:
        pred_label = MODEL.predict(X_input)[0]
        # Si el modelo soporta predict_proba (LogisticRegression sí)
        if hasattr(MODEL, "predict_proba"):
            proba = MODEL.predict_proba(X_input)[0]
            max_proba = float(max(proba))
        else:
            # fallback si algún día cambias de modelo
            max_proba = 0.5
    except Exception:
        _fallback("model_inference_error", base_score=gemini_score)
        return

    ml_score = int(round(max_proba * 100))

    out = {
        "ml_analysis": {
            "ml_verdict": str(pred_label),        # "verdadera" o "falsa"
            "ml_score": ml_score,                 # 0–100
            "ml_confidence": max_proba,           # 0.0–1.0
            "ml_features_used": 1,                # 1 texto de entrada
            "ml_model_accuracy": None             # lo puedes rellenar luego
        },
        "final_verdict": str(pred_label),
        "combined_confidence": max_proba,
        "analysis_method": "local_ml_logreg_tfidf"
    }

    sys.stdout.write(json.dumps(out))


def _fallback(reason, base_score=50.0):
    """
    Si algo falla, devolvemos estructura mínima
    para que el backend siga funcionando.
    """
    out = {
        "ml_analysis": {
            "ml_verdict": f"ml_error:{reason}",
            "ml_score": int(round(base_score)),
            "ml_confidence": 0.5,
            "ml_features_used": 0,
            "ml_model_accuracy": 0.0
        },
        "final_verdict": None,
        "combined_confidence": 0.5,
        "analysis_method": "ml_fallback"
    }
    sys.stdout.write(json.dumps(out))


if __name__ == "__main__":
    main()
