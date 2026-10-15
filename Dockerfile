FROM ubuntu:24.04

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

# Upstream htmlq 0.4.0 has no Linux ARM64 release artifact; compile that version.
RUN if [ "$TARGETARCH" = "arm64" ]; then \
        apt-get update \
        && apt-get -y --no-install-recommends install cargo gcc libc6-dev \
        && CARGO_HOME=/tmp/cargo CARGO_TARGET_DIR=/tmp/target \
            cargo install htmlq --version 0.4.0 --locked --root /usr/local \
        && apt-get -y purge --auto-remove cargo gcc libc6-dev \
        && rm -rf /tmp/cargo /tmp/target /var/lib/apt/lists/*; \
    else \
        curl --fail -L https://github.com/mgdm/htmlq/releases/download/v0.4.0/htmlq-x86_64-linux.tar.gz \
        | tar xvz -C /usr/local/bin; \
    fi

RUN PANDOC_ARCH=$([ "$TARGETARCH" = "arm64" ] && echo "arm64" || echo "amd64") \
    && curl -L https://github.com/jgm/pandoc/releases/download/3.6.4/pandoc-3.6.4-linux-${PANDOC_ARCH}.tar.gz \
    | tar xvz --strip-components=2 -C /usr/local/bin pandoc-3.6.4/bin/pandoc

WORKDIR /app

# The binary is compiled natively before the image build so Rust, ONNX Runtime,
# Astro, and Bun compilation can use the CI/local build cache.
COPY server/vektor /app/vektor

RUN mkdir -p /app/data

# Validate the prebuilt binary against the actual runtime libraries.
RUN ./vektor __native-self-test

EXPOSE 8080

ENTRYPOINT ["./vektor", "serve"]
