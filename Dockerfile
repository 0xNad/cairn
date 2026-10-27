# Cairn in a container: Node.js 24 and Cairn's own files, nothing else (it has no dependencies to install).
# Build: docker build -t cairn .    Run: see "Deploy it" in README.md.
FROM node:24-alpine

WORKDIR /app
COPY package.json LICENSE cairn.mjs ./
COPY src ./src
COPY networks ./networks
COPY wordlists ./wordlists
COPY blocklist ./blocklist

# State lives in a volume at /data (mode 700), owned by the image's unprivileged "node" user (uid 1000).
# The HTTP endpoint listens on all of the container's interfaces so that a published port reaches it; publish it
# on the host's loopback only (-p 127.0.0.1:8080:8080). Unset CAIRN_HTTP_PORT to turn it off.
ENV CAIRN_DATA=/data CAIRN_HTTP_HOST=0.0.0.0 CAIRN_HTTP_PORT=8080
RUN mkdir -p /data && chown node:node /data && chmod 700 /data
VOLUME /data
USER node
EXPOSE 8080

# Healthy while /healthz answers 200: blocks arrive, the RPC and Telegram answer. Without CAIRN_HTTP_PORT, no check.
HEALTHCHECK --interval=30s --timeout=5s --start-period=60s --retries=3 \
  CMD ["node", "-e", "const p=process.env.CAIRN_HTTP_PORT;if(!p)process.exit(0);fetch(`http://127.0.0.1:${p}/healthz`,{signal:AbortSignal.timeout(4000)}).then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"]

# docker stop sends SIGTERM: Cairn finishes its current request and exits 0 within 3 s.
STOPSIGNAL SIGTERM
ENTRYPOINT ["node", "cairn.mjs"]
CMD ["run"]
