FROM node:lts-alpine@sha256:156b55f92e98ccd5ef49578a8cea0df4679826564bad1c9d4ef04462b9f0ded6 AS builder

WORKDIR /app

COPY ./ /app

RUN --mount=type=cache,target=/root/.npm npm run bootstrap

FROM node:lts-alpine@sha256:156b55f92e98ccd5ef49578a8cea0df4679826564bad1c9d4ef04462b9f0ded6 AS release

RUN apk update && apk upgrade

WORKDIR /app

COPY --from=builder /app/dist /app/dist
COPY --from=builder /app/package.json /app/package.json
COPY --from=builder /app/package-lock.json /app/package-lock.json

ENV NODE_ENV=production

RUN npm ci --ignore-scripts --omit=dev && npm uninstall -g npm

USER 1000

ENTRYPOINT ["node", "dist/cli.js"]
