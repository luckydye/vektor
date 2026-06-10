FROM debian:12-slim

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

RUN curl -L https://github.com/mgdm/htmlq/releases/download/v0.4.0/htmlq-x86_64-linux.tar.gz | tar xvz -C /usr/local/bin

RUN curl -L https://github.com/jgm/pandoc/releases/download/3.6.4/pandoc-3.6.4-linux-amd64.tar.gz \
    | tar xvz --strip-components=2 -C /usr/local/bin pandoc-3.6.4/bin/pandoc

WORKDIR /app

RUN mkdir -p /app/data

EXPOSE 8080

# Binary is bind-mounted from the host at /app/vektor
ENTRYPOINT ["./vektor", "serve"]
