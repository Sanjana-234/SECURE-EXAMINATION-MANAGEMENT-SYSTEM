# Zero npm dependencies: only Node 22+ is required.
FROM node:22-alpine
ENV NODE_ENV=production SEMS_DB=/data/sems.db SEMS_UPLOADS=/data/uploads PORT=4000
WORKDIR /app
COPY package.json ./
COPY src ./src
COPY public ./public
RUN addgroup -S sems && adduser -S sems -G sems && mkdir -p /data && chown sems:sems /data
USER sems
VOLUME /data
EXPOSE 4000
HEALTHCHECK --interval=30s --timeout=4s --retries=3 CMD wget -qO- http://127.0.0.1:4000/api/health || exit 1
CMD ["node", "--disable-warning=ExperimentalWarning", "src/main.ts"]
