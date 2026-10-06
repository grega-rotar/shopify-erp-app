# docs/BUILD_SPEC.md section 4: Node 22 LTS, two processes from one image.
# The image is built once and run as `web` or `worker` depending on the command.
#
# `prisma/` is copied before `npm ci` because the postinstall script generates
# the Prisma client and needs the schema to be there already.

FROM node:22-alpine AS build
RUN apk add --no-cache openssl
WORKDIR /app

COPY package.json package-lock.json ./
COPY prisma ./prisma
RUN npm ci --no-audit --no-fund

COPY . .
RUN npm run build

# ---

FROM node:22-alpine AS runtime
RUN apk add --no-cache openssl
WORKDIR /app

ENV NODE_ENV=production

COPY package.json package-lock.json ./
COPY prisma ./prisma
RUN npm ci --omit=dev --no-audit --no-fund && npm cache clean --force

COPY --from=build /app/build ./build
COPY --from=build /app/public ./public

# The commit this image was built from. Last, so a new SHA does not bust the
# cached layers above. The deploy checks it inside the running container.
ARG GIT_SHA=unknown
ENV APP_VERSION=$GIT_SHA
LABEL org.opencontainers.image.revision=$GIT_SHA

EXPOSE 3000

# Overridden per service in docker-compose.yml.
CMD ["npm", "run", "start"]
