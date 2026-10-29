# Cairn in a container: Node.js 24 and Cairn's own files, nothing else (Cairn has no dependencies).
# Build: docker build -t cairn .   Run: see "Deploy it" in README.md. State lives in the /data volume.
# The base is pinned by digest (the multi-arch index of node:24-bookworm-slim); bump both together.
FROM node:24-bookworm-slim@sha256:be8204d4bd327363357f532187b752ff62759c31bedf98e9e18fc08c9cbd605c

ENV NODE_ENV=production \
    CAIRN_DATA=/data \
    CAIRN_HTTP_PORT=9464 \
    CAIRN_HTTP_HOST=0.0.0.0

WORKDIR /app
COPY package.json cairn.mjs LICENSE ./
COPY src ./src
COPY networks ./networks
COPY wordlists ./wordlists
COPY blocklist ./blocklist
# The data directory belongs to the unprivileged node user; Cairn keeps it mode 700.
RUN mkdir -m 700 /data && chown node:node /data
USER node
VOLUME ["/data"]
# /healthz and /metrics. Inside the container Cairn listens on every interface; publish the port on the
# host's loopback only (docker run -p 127.0.0.1:9464:9464), never on a public address.
EXPOSE 9464
STOPSIGNAL SIGTERM
HEALTHCHECK --interval=30s --timeout=5s --start-period=60s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:'+process.env.CAIRN_HTTP_PORT+'/healthz').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"]
ENTRYPOINT ["node", "cairn.mjs"]
CMD ["run"]
