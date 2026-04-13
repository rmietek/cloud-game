FROM node:20-bullseye-slim
WORKDIR /app
RUN apt-get update && apt-get install -y git
COPY apps/child-gameserver/package.json .
RUN npm install
RUN npm install @google-cloud/agones-sdk
RUN npm install redis
COPY apps/shared/ shared/
COPY apps/child-gameserver/src/ src/
EXPOSE 5000
CMD ["node", "src/main.js"]
