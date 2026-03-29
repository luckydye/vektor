FROM debian:12-slim AS builder

RUN apt-get update \
    && apt-get -y --no-install-recommends install \
        curl \
        git \
        ca-certificates \
        build-essential \
        pandoc \
        jq \
        zstd \
        librsvg2-bin \
    && command -v rsvg-convert \
    && rm -rf /var/lib/apt/lists/*

RUN curl -L https://github.com/mgdm/htmlq/releases/download/v0.4.0/htmlq-x86_64-linux.tar.gz | tar xvz -C /usr/local/bin

SHELL ["/bin/bash", "-o", "pipefail", "-c"]
ENV MISE_DATA_DIR="/mise"
ENV MISE_CONFIG_DIR="/mise"
ENV MISE_CACHE_DIR="/mise/cache"
ENV MISE_INSTALL_PATH="/usr/local/bin/mise"
ENV PATH="/mise/shims:$PATH"

RUN curl https://mise.run | sh

WORKDIR /src

COPY . ./

RUN mise trust && mise install
RUN task setup
RUN task compile

FROM debian:12-slim AS runtime

RUN apt-get update \
    && apt-get -y --no-install-recommends install \
        curl \
        git \
        ca-certificates \
        pandoc \
        jq \
        zstd \
        librsvg2-bin \
    && command -v rsvg-convert \
    && rm -rf /var/lib/apt/lists/*

RUN curl -L https://github.com/mgdm/htmlq/releases/download/v0.4.0/htmlq-x86_64-linux.tar.gz | tar xvz -C /usr/local/bin

WORKDIR /app

COPY --from=builder /src/app/vektor ./vektor

RUN mkdir -p /app/data

EXPOSE 8080

ENTRYPOINT ["./vektor", "serve"]
