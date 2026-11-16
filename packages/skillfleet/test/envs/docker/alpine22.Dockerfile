# The minimum engine version on musl and busybox, with git, ssh and pnpm.
FROM node:22.12-alpine
RUN apk add --no-cache git openssh-client && npm install -g pnpm@10 && npm cache clean --force
USER node
WORKDIR /home/node
