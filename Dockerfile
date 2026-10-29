FROM node:24-bookworm-slim
WORKDIR /app
COPY --chown=node:node cairn.mjs package.json package-lock.json ./
COPY --chown=node:node src ./src
COPY --chown=node:node networks ./networks
COPY --chown=node:node wordlists ./wordlists
COPY --chown=node:node blocklist ./blocklist
RUN mkdir /data && chown node:node /data
USER node
ENV CAIRN_DATA=/data
STOPSIGNAL SIGTERM
CMD ["node", "cairn.mjs", "run"]
