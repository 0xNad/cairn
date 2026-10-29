FROM node:24.22.1-bookworm-slim
ENV NODE_ENV=production CAIRN_DATA=/data
WORKDIR /app
COPY --chown=node:node cairn.mjs package.json ./
COPY --chown=node:node src ./src
COPY --chown=node:node networks ./networks
USER node
VOLUME ["/data"]
STOPSIGNAL SIGTERM
CMD ["node", "cairn.mjs", "run"]
