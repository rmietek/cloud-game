FROM node:20-bullseye-slim
WORKDIR /app
RUN apt-get update && apt-get install -y git
COPY apps/mother-lobby/package.json .
RUN npm install
RUN npm install @google-cloud/agones-sdk
RUN npm install redis
COPY apps/shared/ shared/
COPY apps/mother-lobby/src/ src/
COPY apps/mother-lobby/public/ public/
EXPOSE 9876 3001 3002
CMD ["node", "src/main.js"]
