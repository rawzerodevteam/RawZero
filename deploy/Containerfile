# RawStudio — image OCI (Podman / Docker)
# Build multi-étapes : 1) build du frontend (Node), 2) runtime Python qui sert
# l'API FastAPI + le frontend statique sur un seul port (comme start.ps1 sans -Dev).

# ---- Étape 1 : build du frontend React/Vite ----
FROM docker.io/library/node:22-slim AS frontend
WORKDIR /app/frontend

# Dépendances d'abord (cache de couche tant que le lockfile ne change pas)
COPY frontend/package.json frontend/package-lock.json ./
RUN npm ci --no-fund --no-audit

# Sources puis build (tsc --noEmit && vite build → dist/)
COPY frontend/ ./
RUN npm run build

# ---- Étape 2 : runtime Python ----
FROM docker.io/library/python:3.12-slim AS runtime

# libgomp1 : requis par onnxruntime (masques IA / débruitage).
# rawpy, opencv-python-headless et Pillow embarquent leurs propres libs natives.
RUN apt-get update \
    && apt-get install -y --no-install-recommends libgomp1 \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

ENV PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1

# Dépendances Python figées (versions validées) avant le code → cache de couche
COPY backend/requirements-lock.txt backend/requirements-lock.txt
RUN pip install --no-cache-dir -r backend/requirements-lock.txt

# Code backend + frontend buildé
COPY backend/ backend/
COPY --from=frontend /app/frontend/dist /app/frontend/dist

# Chemins de l'app (montés en volumes par compose)
ENV DATA_DIR=/data \
    IMPORT_DIR=/import \
    STATIC_DIR=/app/frontend/dist

EXPOSE 8000

# Healthcheck applicatif (ignoré par podman generate kube, utile en compose/run)
HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 \
    CMD python -c "import urllib.request,sys; sys.exit(0 if urllib.request.urlopen('http://127.0.0.1:8000/api/health').status==200 else 1)"

CMD ["python", "-m", "uvicorn", "app.main:app", "--app-dir", "backend", \
     "--host", "0.0.0.0", "--port", "8000"]
