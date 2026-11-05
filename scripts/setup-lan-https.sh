#!/usr/bin/env bash
set -euo pipefail

PROJECT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
CERT_DIR="$PROJECT_DIR/certs"
LAN_IP="${1:-$(ipconfig getifaddr en0 2>/dev/null || true)}"

if ! python3 -c 'import ipaddress, sys; ipaddress.IPv4Address(sys.argv[1])' "$LAN_IP" >/dev/null 2>&1; then
    printf 'Could not determine a valid IPv4 LAN address. Usage: bash scripts/setup-lan-https.sh [IPv4-address]\n' >&2
    exit 1
fi

if ! command -v openssl >/dev/null 2>&1; then
    printf 'OpenSSL is required to generate the local HTTPS certificates.\n' >&2
    exit 1
fi

mkdir -p "$CERT_DIR"
chmod 700 "$CERT_DIR"

if [[ ! -e "$CERT_DIR/ca.key" && ! -e "$CERT_DIR/ca.crt" ]]; then
    openssl genpkey -algorithm RSA -pkeyopt rsa_keygen_bits:3072 -out "$CERT_DIR/ca.key"
    openssl req -x509 -new -key "$CERT_DIR/ca.key" -sha256 -days 3650 \
        -out "$CERT_DIR/ca.crt" \
        -subj "/CN=Bafwethu Local HTTPS CA" \
        -addext "basicConstraints=critical,CA:TRUE" \
        -addext "keyUsage=critical,keyCertSign,cRLSign"
elif [[ ! -f "$CERT_DIR/ca.key" || ! -f "$CERT_DIR/ca.crt" ]]; then
    printf 'A CA key or certificate is missing in %s; refusing to replace it automatically.\n' "$CERT_DIR" >&2
    exit 1
fi

openssl genpkey -algorithm EC -pkeyopt ec_paramgen_curve:P-256 -out "$CERT_DIR/server.key"
openssl req -new -key "$CERT_DIR/server.key" -out "$CERT_DIR/server.csr" \
    -subj "/CN=$LAN_IP"
openssl x509 -req -in "$CERT_DIR/server.csr" \
    -CA "$CERT_DIR/ca.crt" -CAkey "$CERT_DIR/ca.key" -CAcreateserial \
    -out "$CERT_DIR/server.crt" -days 397 -sha256 \
    -extfile <(printf 'basicConstraints=critical,CA:FALSE\nkeyUsage=critical,digitalSignature,keyEncipherment\nextendedKeyUsage=serverAuth\nsubjectAltName=IP:%s\n' "$LAN_IP")
rm "$CERT_DIR/server.csr"
chmod 600 "$CERT_DIR/ca.key" "$CERT_DIR/server.key"
chmod 644 "$CERT_DIR/ca.crt" "$CERT_DIR/server.crt"

printf 'HTTPS certificate created for https://%s:8443\n' "$LAN_IP"
printf 'Trust %s on each device that will use the app.\n' "$CERT_DIR/ca.crt"
printf 'Keep %s private; it is the local CA signing key.\n' "$CERT_DIR/ca.key"
