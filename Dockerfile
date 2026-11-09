FROM node:lts-alpine@sha256:8996bb5821d62a8fd9bb27c1cb07462f3fdce6e47d640c6a881ead0b064ce216 AS builder

WORKDIR /app

COPY ./ /app

RUN --mount=type=cache,target=/root/.npm npm run bootstrap

FROM node:lts-alpine@sha256:8996bb5821d62a8fd9bb27c1cb07462f3fdce6e47d640c6a881ead0b064ce216 AS release

RUN apk update && apk upgrade

WORKDIR /app

COPY --from=builder /app/dist /app/dist
COPY --from=builder /app/package.json /app/package.json
COPY --from=builder /app/package-lock.json /app/package-lock.json

ENV NODE_ENV=production

RUN npm ci --ignore-scripts --omit=dev && npm uninstall -g npm

USER 1000

ENTRYPOINT ["node", "dist/cli.js"]
