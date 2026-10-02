# Built with repo root as the Docker build context (see infra/lib/slot-sync-stack.mjs),
# because this is an npm workspace and needs packages/core + packages/parsers
# alongside apps/slot-sync-aws to install. Two Lambda functions share this
# image (block-worker, health-check) — CDK overrides `cmd` per function so
# both reuse the same build.
FROM mcr.microsoft.com/playwright:v1.47.0-jammy

RUN npm i -g aws-lambda-ric

WORKDIR /app

COPY package.json package-lock.json ./
COPY packages/core/package.json packages/core/package.json
COPY packages/parsers/package.json packages/parsers/package.json
COPY apps/slot-sync-aws/package.json apps/slot-sync-aws/package.json

RUN npm ci --omit=dev --workspace=@turfsync/slot-sync-aws --include-workspace-root

COPY packages/core packages/core
COPY packages/parsers packages/parsers
COPY apps/slot-sync-aws apps/slot-sync-aws

WORKDIR /app/apps/slot-sync-aws

ENTRYPOINT ["npx", "aws-lambda-ric"]
# CMD is overridden per Lambda function by CDK (block-worker vs. health-check).
CMD ["src/block-worker/handler.handler"]
