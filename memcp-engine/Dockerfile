FROM python:3.12-slim

WORKDIR /app

COPY pyproject.toml README.md CHANGELOG.md ./
COPY src/ src/

# Install with search, fuzzy, semantic, and cache extras
RUN pip install --no-cache-dir ".[search,fuzzy,semantic,cache]" httpx

# Health-check: memcp_ping via HTTP
HEALTHCHECK --interval=30s --timeout=5s --retries=3 \
    CMD python -c "import httpx; r=httpx.get('http://127.0.0.1:3457/mcp/', timeout=5); r.raise_for_status()" || exit 1

EXPOSE 3457

# Default: HTTP transport for network deployment
ENV MEMCP_TRANSPORT=http
ENV MEMCP_HOST=0.0.0.0
ENV MEMCP_PORT=3457
ENV MEMCP_DATA_DIR=/data

ENTRYPOINT ["python", "-m", "memcp"]
