FROM python:3.12-slim

WORKDIR /app

COPY pyproject.toml README.md CHANGELOG.md ./
COPY src/ src/

# Install with search, fuzzy, semantic, cache, and HNSW (O(log N) vector search) extras
RUN pip install --no-cache-dir ".[search,fuzzy,semantic,cache,hnsw]" httpx

# Health-check: TCP port check (streamable-http hat kein einfaches GET)
HEALTHCHECK --interval=30s --timeout=5s --retries=3 \
    CMD python -c "import socket; s=socket.create_connection(('127.0.0.1', 3457), timeout=5); s.close()" || exit 1

EXPOSE 3457

# Default: HTTP transport for network deployment
ENV MEMCP_TRANSPORT=http
ENV MEMCP_HOST=0.0.0.0
ENV MEMCP_PORT=3457
ENV MEMCP_DATA_DIR=/data

ENTRYPOINT ["python", "-m", "memcp"]
