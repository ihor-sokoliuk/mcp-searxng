ARG GIT_COMMIT=unknown
ARG GIT_BRANCH=unknown
ARG BUILD_DATE=unknown

FROM node:lts-alpine AS builder

ARG GIT_COMMIT
ARG GIT_BRANCH
ARG BUILD_DATE

WORKDIR /app

COPY ./ /app

RUN --mount=type=cache,target=/root/.npm npm run bootstrap

FROM node:lts-alpine AS release

ARG GIT_COMMIT
ARG GIT_BRANCH
ARG BUILD_DATE

LABEL org.opencontainers.image.revision="${GIT_COMMIT}"
     org.opencontainers.image.source="https://github.com/ihor-sokoliuk/mcp-searxng"
     org.opencontainers.image.version="${GIT_BRANCH}"

ENV GIT_COMMIT=${GIT_COMMIT} \
    GIT_BRANCH=${GIT_BRANCH} \
    BUILD_DATE=${BUILD_DATE} \
    NODE_ENV=production

RUN apk update && apk upgrade

WORKDIR /app

COPY --from=builder /app/dist /app/dist
COPY --from=builder /app/package.json /app/package.json
COPY --from=builder /app/package-lock.json /app/package-lock.json

RUN npm ci --ignore-scripts --omit=dev && npm uninstall -g npm

ENTRYPOINT ["node", "dist/index.js"]