# ---- build & test ----------------------------------------------------------
FROM golang:1.26-alpine AS build
WORKDIR /src

COPY go.mod go.sum* ./
COPY *.go ./
# go mod tidy resolves go.sum if it hasn't been committed yet.
RUN go mod tidy && go mod download

# Unit tests run as part of the image build (skip with --build-arg SKIP_TESTS=true).
ARG SKIP_TESTS=false
RUN if [ "$SKIP_TESTS" != "true" ]; then go test ./...; fi

RUN CGO_ENABLED=0 go build -trimpath -ldflags="-s -w" -o /out/photo-slideshow-api .

# ---- runtime -----------------------------------------------------------------
FROM alpine:3
RUN apk add --no-cache ca-certificates tzdata \
 && adduser -D -u 10001 app \
 && mkdir -p /cache/thumbs /photos \
 && chown -R app /cache
COPY --from=build /out/photo-slideshow-api /usr/local/bin/photo-slideshow-api

USER app
ENV ADDR=:8080 \
    PHOTO_ROOT=/photos \
    THUMB_CACHE_DIR=/cache/thumbs \
    MONGO_URI=mongodb://mongo:27017 \
    MONGO_DB=photo_slideshow
EXPOSE 8080
HEALTHCHECK --interval=15s --timeout=3s --start-period=20s \
  CMD wget -qO- http://127.0.0.1:8080/api/health >/dev/null || exit 1
ENTRYPOINT ["photo-slideshow-api"]
