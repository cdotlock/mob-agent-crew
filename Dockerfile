FROM node:22-bookworm-slim AS build

WORKDIR /app
RUN corepack enable

COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile

COPY tsconfig.json tsconfig.build.json vite.config.ts ./
COPY src ./src
COPY web ./web
RUN pnpm build

FROM node:22-bookworm-slim AS deepseek-harness

ARG DEEPSEEK_HARNESS_VERSION=0.1.0-rc.6
RUN apt-get update \
    && apt-get install -y --no-install-recommends build-essential python3 \
    && npm install -g "@deepseek-ai/dsh@${DEEPSEEK_HARNESS_VERSION}" \
    && test "$(dsh --version)" = "${DEEPSEEK_HARNESS_VERSION}" \
    && node -e "require('/usr/local/lib/node_modules/@deepseek-ai/dsh/node_modules/node-pty')" \
    && rm -rf /var/lib/apt/lists/*

FROM node:22-bookworm-slim AS runtime

ARG CLAUDE_CODE_VERSION=2.1.220
ARG CODEX_VERSION=0.142.5
ARG CODEX_PACKAGE_LINUX_AMD64_SHA256=14ab953574506cb30d8c773e5a3458fd0a2d1aad58062f0a98ea6a159889b80e
ARG CODEX_PACKAGE_LINUX_ARM64_SHA256=600d444443e8ec04397586965fde7de77de7795842f5e7b0e622c7b05f7fc356
ARG GH_VERSION=2.94.0
ARG HERMES_VERSION=0.19.0
ARG HERMES_WHEEL_SHA256=bd0bac012aee38a60894781f4597dc29ee7bedb3448540249921f10d3bef327f
ARG DEEPSEEK_HARNESS_VERSION=0.1.0-rc.6
ARG PI_VERSION=0.84.1
ARG OMP_VERSION=17.3.0
ARG OMP_LINUX_AMD64_SHA256=287f07366f29896ef1e345423dab79b82a8dc0c1593383e20dfdd62a9dd2e799
ARG OMP_LINUX_ARM64_SHA256=8ffd6d4d0b8003b4228abcdace8ed3882da981e96d9ae6c19255cc44b67f8f37
ARG TARGETARCH

ENV NODE_ENV=production
WORKDIR /app
RUN corepack enable && apt-get update && apt-get install -y --no-install-recommends curl ca-certificates git python3 python3-venv && rm -rf /var/lib/apt/lists/*

# The single control process owns server-only credentials. Every CLI Agent is
# spawned as this separate unprivileged user and only receives the active task
# checkout; this is one container/process topology, not another service.
RUN groupadd --gid 10001 mob-agent \
    && useradd --uid 10001 --gid 10001 --no-create-home --shell /usr/sbin/nologin mob-agent

RUN npm install -g --ignore-scripts "@earendil-works/pi-coding-agent@${PI_VERSION}" \
    && npm install -g --ignore-scripts --omit=optional "@anthropic-ai/claude-code@${CLAUDE_CODE_VERSION}" \
    && case "${TARGETARCH}" in \
      amd64) CLAUDE_PLATFORM_PACKAGE=@anthropic-ai/claude-code-linux-x64 ;; \
      arm64) CLAUDE_PLATFORM_PACKAGE=@anthropic-ai/claude-code-linux-arm64 ;; \
      *) echo "Unsupported Claude Code architecture: ${TARGETARCH}" >&2; exit 1 ;; \
    esac \
    && npm install --prefix /usr/local/lib/node_modules/@anthropic-ai/claude-code \
      --no-save "${CLAUDE_PLATFORM_PACKAGE}@${CLAUDE_CODE_VERSION}"

COPY --from=deepseek-harness /usr/local/lib/node_modules/@deepseek-ai/dsh /usr/local/lib/node_modules/@deepseek-ai/dsh
COPY integrations/deepseek-harness /opt/mob/deepseek-harness-plugin
RUN ln -s /usr/local/lib/node_modules/@deepseek-ai/dsh/lib/bin.js /usr/local/bin/dsh

# Install the immutable official OMP release asset. The moving omp.sh installer
# is intentionally not used: it is both non-reproducible and rejects some
# container build networks.
RUN case "${TARGETARCH}" in \
      amd64) OMP_ARCH=x64; OMP_SHA256="${OMP_LINUX_AMD64_SHA256}" ;; \
      arm64) OMP_ARCH=arm64; OMP_SHA256="${OMP_LINUX_ARM64_SHA256}" ;; \
      *) echo "Unsupported OMP architecture: ${TARGETARCH}" >&2; exit 1 ;; \
    esac \
    && curl -fL --retry 5 --retry-all-errors --connect-timeout 20 "https://github.com/can1357/oh-my-pi/releases/download/v${OMP_VERSION}/omp-linux-${OMP_ARCH}" -o /tmp/omp \
    && echo "${OMP_SHA256}  /tmp/omp" | sha256sum -c - \
    && install -m 0755 /tmp/omp /usr/local/bin/omp \
    && rm /tmp/omp

# Hermes is installed from the pinned universal wheel (not the source archive)
# and exposes the Python entrypoint used by the stdio JSON-RPC connector.
RUN curl -fsSL "https://files.pythonhosted.org/packages/e5/30/c85be8290e9565dc3c7a9720e93f3e59e09b1b163487be4946c3aa848f80/hermes_agent-${HERMES_VERSION}-py3-none-any.whl" \
      -o "/tmp/hermes_agent-${HERMES_VERSION}-py3-none-any.whl" \
    && test "$(sha256sum "/tmp/hermes_agent-${HERMES_VERSION}-py3-none-any.whl" | cut -d ' ' -f 1)" = "${HERMES_WHEEL_SHA256}" \
    && python3 -m venv /opt/hermes \
    && /opt/hermes/bin/pip install --no-cache-dir "/tmp/hermes_agent-${HERMES_VERSION}-py3-none-any.whl" \
    && ln -s /opt/hermes/bin/hermes /usr/local/bin/hermes \
    && printf '%s\n' '#!/bin/sh' 'exec /opt/hermes/bin/python "$@"' > /usr/local/bin/hermes-python \
    && chmod 0755 /usr/local/bin/hermes-python \
    && rm "/tmp/hermes_agent-${HERMES_VERSION}-py3-none-any.whl"

# Install the immutable official Codex package, not only the main executable.
# Codex resolves its bundled rg, bwrap, and shell resources relative to the
# executable, so the release directory layout must remain intact.
RUN case "${TARGETARCH}" in \
      amd64) CODEX_ARCH=x86_64; CODEX_SHA256="${CODEX_PACKAGE_LINUX_AMD64_SHA256}" ;; \
      arm64) CODEX_ARCH=aarch64; CODEX_SHA256="${CODEX_PACKAGE_LINUX_ARM64_SHA256}" ;; \
      *) echo "Unsupported Codex architecture: ${TARGETARCH}" >&2; exit 1 ;; \
    esac \
    && CODEX_ASSET="codex-package-${CODEX_ARCH}-unknown-linux-musl.tar.gz" \
    && curl -fL --retry 5 --retry-all-errors --connect-timeout 20 \
      "https://github.com/openai/codex/releases/download/rust-v${CODEX_VERSION}/${CODEX_ASSET}" \
      -o "/tmp/${CODEX_ASSET}" \
    && echo "${CODEX_SHA256}  /tmp/${CODEX_ASSET}" | sha256sum -c - \
    && install -d -m 0755 /opt/codex \
    && tar -xzf "/tmp/${CODEX_ASSET}" -C /opt/codex \
    && test -f /opt/codex/codex-package.json \
    && chmod 0755 /opt/codex/bin/codex /opt/codex/codex-path/rg /opt/codex/codex-resources/bwrap \
    && ln -s /opt/codex/bin/codex /usr/local/bin/codex \
    && rm -f "/tmp/${CODEX_ASSET}"

# Install GitHub CLI from its immutable official release and verify its asset
# against the release checksum list. TARGETARCH is amd64 or arm64 on Railway.
RUN test "${TARGETARCH}" = "amd64" -o "${TARGETARCH}" = "arm64" \
    && curl -fsSL "https://github.com/cli/cli/releases/download/v${GH_VERSION}/gh_${GH_VERSION}_linux_${TARGETARCH}.tar.gz" -o /tmp/gh.tar.gz \
    && curl -fsSL "https://github.com/cli/cli/releases/download/v${GH_VERSION}/gh_${GH_VERSION}_checksums.txt" -o /tmp/gh-checksums.txt \
    && grep " gh_${GH_VERSION}_linux_${TARGETARCH}.tar.gz$" /tmp/gh-checksums.txt | sed 's#  gh_.*#  /tmp/gh.tar.gz#' | sha256sum -c - \
    && tar -xzf /tmp/gh.tar.gz -C /tmp \
    && install -m 0755 "/tmp/gh_${GH_VERSION}_linux_${TARGETARCH}/bin/gh" /usr/local/bin/gh \
    && rm -rf /tmp/gh.tar.gz /tmp/gh-checksums.txt "/tmp/gh_${GH_VERSION}_linux_${TARGETARCH}"

# npm can leave Claude's small launcher in place when the package lifecycle is
# restricted by the build frontend. Anthropic ships this installer in the
# pinned package and documents it as the repair path for the same native asset.
RUN node /usr/local/lib/node_modules/@anthropic-ai/claude-code/install.cjs \
    && command -v pi \
    && pi --version \
    && command -v omp \
    && omp --version \
    && command -v hermes \
    && command -v hermes-python \
    && hermes-python -I -c 'import tui_gateway.entry' \
    && hermes --version \
    && command -v claude \
    && claude --version \
    && command -v codex \
    && codex --version \
    && codex exec --help >/dev/null \
    && test -x /opt/codex/codex-path/rg \
    && test -x /opt/codex/codex-resources/bwrap \
    && command -v dsh \
    && test "$(dsh --version)" = "${DEEPSEEK_HARNESS_VERSION}" \
    && node -e "import('/opt/mob/deepseek-harness-plugin/index.js')" \
    && DSH_HOME=/tmp/dsh-smoke dsh --profile headless --dump-default-config >/dev/null \
    && rm -rf /tmp/dsh-smoke \
    && command -v gh \
    && gh --version

COPY package.json pnpm-lock.yaml ./
RUN pnpm install --prod --frozen-lockfile

COPY --from=build /app/dist ./dist
COPY --from=build /app/web-dist ./web-dist
COPY docker-entrypoint.sh /usr/local/bin/docker-entrypoint

RUN mkdir -p /data \
    && install -d -m 0700 -o root -g root /run/mob-control \
    && install -d -m 0711 -o root -g root /data/tasks \
    && install -d -m 0700 -o root -g root /data/control \
    && install -d -m 0700 -o root -g root /data/state \
    && install -d -m 0700 -o root -g root /data/artifacts \
    && chmod 0755 /usr/local/bin/docker-entrypoint /app/dist/cli.js \
    && ln -s /app/dist/cli.js /usr/local/bin/mob

# Provider and SCM credentials are copied into a control-only runtime directory
# by the entrypoint, then removed from the server environment. Agent child
# processes only receive task-scoped Mob credentials.
ENV MOB_CONTROL_DIR=/run/mob-control
ENV MOB_AGENT_UID=10001
ENV MOB_AGENT_GID=10001

EXPOSE 4310
ENTRYPOINT ["docker-entrypoint"]
CMD ["node", "dist/cli.js", "start"]
