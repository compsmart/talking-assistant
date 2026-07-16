FROM node:24-alpine
WORKDIR /workspace
COPY package*.json ./
RUN npm install --omit=dev --no-audit --no-fund
COPY . .
RUN chown -R node:node /workspace
USER node
ENV PORT=4173 HOST=0.0.0.0 NODE_ENV=production
EXPOSE 4173
CMD ["npm", "start"]
