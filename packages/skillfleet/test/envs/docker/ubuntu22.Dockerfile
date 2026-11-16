# Ubuntu 24.04 with Node 22 from the nodejs.org tarball.
FROM ubuntu:24.04
ARG NODE=v22.23.5
RUN apt-get update && apt-get install -y --no-install-recommends git ca-certificates curl xz-utils procps \
 && curl -fsSL "https://nodejs.org/dist/$NODE/node-$NODE-linux-x64.tar.xz" | tar -xJ -C /usr/local --strip-components=1 \
 && apt-get purge -y curl xz-utils && rm -rf /var/lib/apt/lists/*
USER ubuntu
WORKDIR /home/ubuntu
