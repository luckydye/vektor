FROM debian:12-slim

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

RUN mkdir -p /app/data

EXPOSE 8080

# Binary is bind-mounted from the host at /app/vektor
ENTRYPOINT ["./vektor", "serve"]
