import os
import pandas as pd
from collections import Counter

from sklearn.model_selection import train_test_split
from sklearn.pipeline import Pipeline
from sklearn.feature_extraction.text import TfidfVectorizer
from sklearn.linear_model import LogisticRegression
from sklearn.metrics import classification_report
import joblib

# --------------------
# CONFIG DE RUTAS
# --------------------
BASE_DIR = os.path.dirname(os.path.abspath(__file__))

DATASET_PATH = os.path.join(BASE_DIR, "..", "data", "dataset.json")
DATASET_PATH = os.path.normpath(DATASET_PATH)

MODEL_PATH = os.path.join(BASE_DIR, "model.joblib")
MODEL_PATH = os.path.normpath(MODEL_PATH)


def load_dataset(path: str = DATASET_PATH) -> pd.DataFrame:
    """
    Carga el dataset desde JSON, normaliza columnas y etiquetas.
    Espera campos: fuente, titulo, cuerpo, etiqueta.
    """
    df = pd.read_json(path, encoding="utf-8")

    # Por si alguna vez aparecen columnas con BOM tipo "﻿fuente"
    for col_with_bom in list(df.columns):
        clean_col = col_with_bom.replace("\ufeff", "")
        if clean_col != col_with_bom:
            df.rename(columns={col_with_bom: clean_col}, inplace=True)

    # Asegurarnos de que las columnas existen
    required_cols = ["fuente", "titulo", "cuerpo", "etiqueta"]
    for c in required_cols:
        if c not in df.columns:
            raise ValueError(f"Falta la columna requerida '{c}' en el dataset.")

    # Normalizar etiquetas a minúsculas y sin espacios
    df["etiqueta"] = df["etiqueta"].astype(str).str.strip().str.lower()

    # Mapear posibles sinónimos futuros (por si editas el JSON luego)
    mapping = {
        "verdadera": "verdadera",
        "real": "verdadera",
        "true": "verdadera",
        "falsa": "falsa",
        "noticia falsa": "falsa",
        "false": "falsa"
    }
    df["etiqueta"] = df["etiqueta"].map(lambda x: mapping.get(x, x))

    # Eliminar filas con etiqueta vacía o NaN
    df = df[df["etiqueta"].notna() & (df["etiqueta"] != "")].copy()

    # Comprobar distribución de clases
    counts = Counter(df["etiqueta"])
    print("Distribución de clases ANTES de filtrar:", counts)

    # Filtrar clases que tengan al menos 2 muestras (para que stratify no explote)
    valid_labels = {label for label, cnt in counts.items() if cnt >= 2}
    df = df[df["etiqueta"].isin(valid_labels)].copy()

    counts_after = Counter(df["etiqueta"])
    print("Distribución de clases DESPUÉS de filtrar:", counts_after)

    if len(counts_after) < 2:
        raise ValueError(
            f"Después de filtrar, solo quedó una clase: {counts_after}. "
            f"Necesitas al menos dos clases para entrenar el modelo."
        )

    # Construir campo de texto de entrada (puedes tunearlo)
    df["texto"] = (
        df["titulo"].fillna("") + " "
        + df["cuerpo"].fillna("") + " "
        + "Fuente: " + df["fuente"].fillna("")
    )

    return df


def build_pipeline() -> Pipeline:
    """
    Crea el pipeline de ML: TF-IDF + Regresión Logística.
    """
    pipeline = Pipeline([
        ("tfidf", TfidfVectorizer(
            max_features=5000,
            ngram_range=(1, 2),
            lowercase=True
        )),
        ("clf", LogisticRegression(
            max_iter=1000,
            class_weight="balanced"
        ))
    ])
    return pipeline


def main():
    # 1. Cargar dataset
    df = load_dataset(DATASET_PATH)

    X = df["texto"]
    y = df["etiqueta"]

    # 2. Partir en train / test con estratificación
    X_train, X_test, y_train, y_test = train_test_split(
        X,
        y,
        test_size=0.2,
        random_state=42,
        stratify=y
    )

    print(f"Tamaño train: {len(X_train)}, test: {len(X_test)}")

    # 3. Crear pipeline y entrenar
    pipeline = build_pipeline()
    pipeline.fit(X_train, y_train)

    # 4. Evaluar
    y_pred = pipeline.predict(X_test)
    print("\n=== Reporte de clasificación ===")
    print(classification_report(y_test, y_pred))

    # 5. Guardar modelo
    joblib.dump(pipeline, MODEL_PATH)
    print(f"\nModelo guardado en: {MODEL_PATH}")


if __name__ == "__main__":
    main()
