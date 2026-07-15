FROM debian:12-slim AS build

ARG TARGETARCH

RUN apt-get update \
    && apt-get -y --no-install-recommends install \
        build-essential \
        ca-certificates \
        curl \
        git \
        python3 \
    && rm -rf /var/lib/apt/lists/*

SHELL ["/bin/bash", "-o", "pipefail", "-c"]
ENV MISE_DATA_DIR="/mise"
ENV MISE_CONFIG_DIR="/mise"
ENV MISE_CACHE_DIR="/mise/cache"
ENV MISE_INSTALL_PATH="/usr/local/bin/mise"
ENV PATH="/mise/shims:$PATH"

RUN curl https://mise.run | sh

WORKDIR /app

COPY . .

RUN mise trust && mise install && mise reshim

ENV CARGO_BUILD_JOBS=1
ENV RUST_MIN_STACK=16777216
RUN bun i && cd app && bun i
RUN task native:image
RUN task native:exec
RUN task native:embedding
RUN cd app && bunx --bun astro build && bun run ./build.ts

FROM debian:12-slim

ARG TARGETARCH

RUN apt-get update \
    && apt-get -y --no-install-recommends install \
        curl \
        git \
        ca-certificates \
        jq \
        zstd \
        librsvg2-bin \
    && command -v rsvg-convert \
    && rm -rf /var/lib/apt/lists/*

RUN HTMLQ_ARCH=$([ "$TARGETARCH" = "arm64" ] && echo "aarch64" || echo "x86_64") \
    && curl -L https://github.com/mgdm/htmlq/releases/download/v0.4.0/htmlq-${HTMLQ_ARCH}-linux.tar.gz \
    | tar xvz -C /usr/local/bin

RUN PANDOC_ARCH=$([ "$TARGETARCH" = "arm64" ] && echo "arm64" || echo "amd64") \
    && curl -L https://github.com/jgm/pandoc/releases/download/3.6.4/pandoc-3.6.4-linux-${PANDOC_ARCH}.tar.gz \
    | tar xvz --strip-components=2 -C /usr/local/bin pandoc-3.6.4/bin/pandoc

WORKDIR /app

COPY --from=build /app/app/vektor /app/vektor

RUN mkdir -p /app/data

# Verify the embedded addons against the libraries in the actual runtime image,
# not only the build stage. This catches glibc and shared-library mismatches.
RUN ./vektor __native-self-test

EXPOSE 8080

ENTRYPOINT ["./vektor", "serve"]
