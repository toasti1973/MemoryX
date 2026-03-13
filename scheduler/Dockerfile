FROM node:20-alpine AS build

RUN apk add --no-cache python3 make g++

WORKDIR /app
COPY package.json ./
RUN npm install --production

FROM node:20-alpine

WORKDIR /app
COPY --from=build /app/node_modules ./node_modules
COPY package.json ./
COPY src/ ./src/

RUN mkdir -p /data /backups

CMD ["node", "src/index.js"]
