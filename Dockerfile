FROM node:24-alpine AS build

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npm run build && npm run server:build

FROM nginx:stable-alpine AS web
COPY --from=build /app/dist/ /usr/share/nginx/html/
COPY deploy/nginx.conf /etc/nginx/templates/default.conf.template
EXPOSE 80 443

FROM node:24-alpine AS api
ENV NODE_ENV=production PORT=3000
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=build /app/server/ ./server/
COPY --from=build /app/src/ ./src/
COPY --from=build /app/tsconfig.server.json ./tsconfig.server.json
USER node
EXPOSE 3000
CMD ["npm", "run", "server:start"]
