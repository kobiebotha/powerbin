FROM node:24-trixie AS node

FROM rust:1.99.1-trixie AS build
COPY --from=node /usr/local/ /usr/local/
RUN apt-get update && apt-get install -y --no-install-recommends \
    libgtk-4-dev libssl-dev pkg-config clang llvm libclang-dev \
    && rm -rf /var/lib/apt/lists/*
ENV PNPM_HOME=/opt/pnpm
ENV PATH="/opt/pnpm/bin:${PATH}"
RUN curl -fsSL https://get.pnpm.io/install.sh -o /tmp/install-pnpm.sh \
    && PNPM_VERSION=12.18.0 PNPM_NO_MODIFY_PATH=1 SHELL=/bin/sh sh /tmp/install-pnpm.sh \
    && rm /tmp/install-pnpm.sh
RUN rustup target add wasm32-unknown-unknown \
    && cargo install wasm-bindgen-cli --version 0.2.129 --locked
# Official NSH 0.4.0 (e626a8d) ships a Linux x86_64 SDK, including its host descriptor.
RUN curl -fsSL https://github.com/longbridge/nsh/releases/download/v0.4.0/nsh-linux-x86_64.tar.gz -o /tmp/nsh.tar.gz \
    && echo '8806121aebf40bb51f8fb6aa703722fbb01253f9a435759c18d53beece1ec976  /tmp/nsh.tar.gz' | sha256sum -c - \
    && tar -xzf /tmp/nsh.tar.gz -C /opt && rm /tmp/nsh.tar.gz
ENV PATH="/opt/nsh/bin:${PATH}" CARGO_BUILD_JOBS=2
WORKDIR /workspace
COPY . .
RUN pnpm install --frozen-lockfile
RUN pnpm run web:build
RUN pnpm --filter powerbin-server deploy --prod --legacy /runtime

FROM node:24-trixie-slim AS powerbin
WORKDIR /app
COPY --from=build /runtime/ ./
COPY --from=build /workspace/.nsh/out/PowerBin/ ./public/
# Root can initialize the Railway-mounted /data volume; key files are 0600/0700.
ENV NODE_ENV=production WEB_DIST=/app/public PORT=8080 HOST=::
EXPOSE 8080
CMD ["node", "src/index.js"]
