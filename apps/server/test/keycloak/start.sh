#!/usr/bin/env sh
# Start a throwaway Keycloak on localhost:8080 with the test realm, for the single sign-on
# tests (OIDC; the SAML client is made by the tests, for the workspace they set up). Needs
# Docker. Prints the URL to use as KEYCLOAK_URL.
set -eu
here=$(cd "$(dirname "$0")" && pwd)
# Pinned by digest (26.4.2), as the CI actions are pinned by commit.
image=keycloak/keycloak:26.4.2@sha256:3617b09bb4b7510a8d8d9b9fc5707399e2d70688dbcc2f8fb013a144829be1b9
docker rm -f hekate-keycloak >/dev/null 2>&1 || true
docker run -d --name hekate-keycloak -p 8080:8080 \
  -e KC_BOOTSTRAP_ADMIN_USERNAME=admin -e KC_BOOTSTRAP_ADMIN_PASSWORD=admin-secret-for-tests \
  -v "$here/realm.json:/opt/keycloak/data/import/realm.json:ro" \
  "$image" start-dev --import-realm >/dev/null
for _ in $(seq 1 90); do
  if curl -sf http://localhost:8080/realms/hekate/.well-known/openid-configuration >/dev/null; then
    echo "http://localhost:8080"
    exit 0
  fi
  sleep 2
done
docker logs hekate-keycloak >&2
echo "Keycloak did not start" >&2
exit 1
