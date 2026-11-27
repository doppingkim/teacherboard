# Teacherboard — build the web app, then run the server that serves it.
# docker build -t teacherboard .
# docker run --env-file .env -p 8787:8787 teacherboard
FROM node:22-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY . .
RUN npm run build

FROM node:22-slim
WORKDIR /app
ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=8787
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund && npm cache clean --force
COPY --from=build /app/dist ./dist
COPY src ./src
COPY tsconfig.json ./
USER node
EXPOSE 8787
# HOST=0.0.0.0 opens the server beyond localhost, so FAMILY_PIN must be set or the server refuses to start.
CMD ["npm", "start"]
