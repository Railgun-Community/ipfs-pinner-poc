FROM node:24-bookworm-slim AS deps

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci

FROM node:24-bookworm-slim AS build

WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . ./
RUN npm run build

FROM node:24-bookworm-slim AS runtime

ENV NODE_ENV=production
WORKDIR /app

COPY --from=build /app/package.json /app/package-lock.json ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/bin ./bin
COPY --from=build /app/src ./src

CMD ["node", "bin/pinner.js"]
