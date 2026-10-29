FROM node:24.15.0-bookworm-slim
ENV NODE_ENV=production CAIRN_DATA=/data CAIRN_HTTP_HOST=0.0.0.0
WORKDIR /app
COPY --chown=node:node cairn.mjs package.json ./
COPY --chown=node:node src ./src
COPY --chown=node:node networks ./networks
COPY --chown=node:node resources ./resources
RUN mkdir /data && chown node:node /data
USER node
VOLUME /data
EXPOSE 8080
STOPSIGNAL SIGTERM
CMD ["node", "cairn.mjs", "run"]
