FROM node:20-alpine

RUN apk add --no-cache python3 make g++ sqlite curl

WORKDIR /app

COPY package.json ./
RUN npm install --production

COPY src/ ./src/

RUN mkdir -p /data /backups

EXPOSE 3459

CMD ["node", "src/index.js"]
