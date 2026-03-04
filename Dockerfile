FROM debian:12-slim

RUN apt-get update  \
    && apt-get -y --no-install-recommends install  \
        # install any other dependencies you might need
        sudo curl git ca-certificates build-essential pandoc jq zstd \
    && rm -rf /var/lib/apt/lists/*

# Download and install htmlq
RUN curl -L https://github.com/mgdm/htmlq/releases/download/v0.4.0/htmlq-x86_64-linux.tar.gz | tar xvz -C /usr/local/bin
    
SHELL ["/bin/bash", "-o", "pipefail", "-c"]
ENV MISE_DATA_DIR="/mise"
ENV MISE_CONFIG_DIR="/mise"
ENV MISE_CACHE_DIR="/mise/cache"
ENV MISE_INSTALL_PATH="/usr/local/bin/mise"
ENV PATH="/mise/shims:$PATH"

RUN curl https://mise.run | sh

WORKDIR /app

COPY ./ ./

RUN mise trust && mise install
RUN task build

EXPOSE 8080

WORKDIR /app/app

ENTRYPOINT ["bun", "./src/server.ts"]
