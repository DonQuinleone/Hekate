#!/usr/bin/env sh
# Start a throwaway OpenLDAP on 127.0.0.1:3389 with the test directory, for the LDAP tests.
# Needs slapd and ldap-utils (apt-get install slapd ldap-utils). Prints the URL to use as
# LDAP_TEST_URL. The data lives in a temporary directory unless LDAP_TEST_DIR names one.
set -eu
here=$(cd "$(dirname "$0")" && pwd)
# LDAP_TEST_DIR places it where the system's slapd profile allows (CI uses /var/lib/ldap).
dir=${LDAP_TEST_DIR:-$(mktemp -d)}
mkdir -p "$dir/data"
cp "$here/fixtures.ldif" "$dir/fixtures.ldif"
cat > "$dir/slapd.conf" <<CONF
include /etc/ldap/schema/core.schema
include /etc/ldap/schema/cosine.schema
include /etc/ldap/schema/inetorgperson.schema
modulepath /usr/lib/ldap
moduleload back_mdb
pidfile $dir/slapd.pid
database mdb
maxsize 10485760
suffix "dc=example,dc=test"
rootdn "cn=admin,dc=example,dc=test"
rootpw admin-secret-for-tests
directory $dir/data
access to attrs=userPassword by anonymous auth by * none
access to * by * read
CONF
slapadd -f "$dir/slapd.conf" -l "$dir/fixtures.ldif" -q
slapd -f "$dir/slapd.conf" -h "ldap://127.0.0.1:3389/"
for _ in 1 2 3 4 5 6 7 8 9 10; do
  if ldapsearch -x -H ldap://127.0.0.1:3389 -b dc=example,dc=test -s base >/dev/null 2>&1; then
    echo "ldap://127.0.0.1:3389"
    exit 0
  fi
  sleep 0.5
done
echo "slapd did not start" >&2
exit 1
