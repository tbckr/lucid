# Self-signed certificate for 127.0.0.1 and localhost, for the VM tests only:
# its key lives in the Nix store.
{ pkgs }:
pkgs.runCommand "lucid-test-cert" { nativeBuildInputs = [ pkgs.openssl ]; } ''
  mkdir $out
  openssl req -x509 -newkey ec -pkeyopt ec_paramgen_curve:prime256v1 -nodes \
    -keyout $out/key.pem -out $out/cert.pem -days 36500 -subj /CN=localhost \
    -addext subjectAltName=IP:127.0.0.1,DNS:localhost
''
