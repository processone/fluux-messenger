FROM node:latest as builder

WORKDIR /home/app
COPY ./fluux-messenger/package.json ./fluux-messenger/package-lock.json ./

RUN npm install --frozen-lockfile

COPY ./fluux-messenger/ /home/app
RUN npm run build

FROM nginx:alpine AS production

# Copy the production build artifacts from the build stage
COPY --from=builder /home/app/apps/fluux/dist /usr/share/nginx/html

# Expose the default NGINX port
EXPOSE 80
CMD ["nginx", "-g", "daemon off;"]
