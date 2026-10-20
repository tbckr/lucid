# NixOS VM test for services.lucid (run via `nix flake check` on Linux): local
# mode, server mode behind a proxy, and server mode serving TLS on 443.
{ self }:
{ pkgs, ... }:
let
  cert = import ./test-cert.nix { inherit pkgs; };

  node = lucid: {
    imports = [ self.nixosModules.default ];
    services.lucid = {
      enable = true;
    }
    // lucid;
    environment.systemPackages = [
      pkgs.curl
      pkgs.iproute2
    ];
  };
in
{
  name = "lucid";

  nodes = {
    local = node { };

    server = node {
      mode = "server";
      address = "0.0.0.0";
      openFirewall = true;
      trustProxyHeaders = true;
      logLevel = "debug";
      cache.size = 64;
    };

    tls = {
      imports = [
        (node {
          mode = "server";
          port = 443;
          tls.certFile = "/etc/lucid-test/cert.pem";
          tls.keyFile = "/etc/lucid-test/key.pem";
        })
      ];
      # Root-owned copies the dynamic user cannot read: only LoadCredential
      # can hand them to Lucid.
      environment.etc."lucid-test/cert.pem" = {
        source = "${cert}/cert.pem";
        mode = "0400";
      };
      environment.etc."lucid-test/key.pem" = {
        source = "${cert}/key.pem";
        mode = "0400";
      };
    };
  };

  testScript = ''
    start_all()

    # Local mode (FR-35): loopback only, plain HTTP, Host check, menu entry.
    local.wait_for_unit("lucid.service")
    local.wait_for_open_port(3456, "127.0.0.1")
    local.succeed("ss -ltnH | grep -q '127.0.0.1:3456'")
    local.fail("ss -ltnH | grep -qE '(0\\.0\\.0\\.0|\\*|\\[::\\]):3456'")
    local.succeed("curl -fsS http://127.0.0.1:3456/healthz")
    # A session cookie is set, and without Secure (plain HTTP on loopback).
    local.succeed("curl -fsSi http://127.0.0.1:3456/api/v1/session | grep -qi '^set-cookie:'")
    local.fail("curl -fsSi http://127.0.0.1:3456/api/v1/session | grep -qi '^set-cookie:.*; secure'")
    local.fail("curl -fsS -H 'Host: evil.example' http://127.0.0.1:3456/healthz")
    local.succeed("grep -q 'http://127.0.0.1:3456/' /run/current-system/sw/share/applications/lucid.desktop")

    # Server mode: reachable from another machine via address + openFirewall.
    server.wait_for_unit("lucid.service")
    server.wait_for_open_port(8080)
    local.succeed("curl -fsS http://server:8080/healthz")
    server.succeed("curl -fsS http://127.0.0.1:8080/readyz")
    # The embedded SPA is served, not the placeholder page.
    server.succeed("curl -fsS http://127.0.0.1:8080/ | grep -qi '<script'")
    # Server mode always sets the Secure cookie flag.
    server.succeed("curl -fsSi http://127.0.0.1:8080/api/v1/session | grep -qi '^set-cookie:.*; secure'")
    # /metrics is served only on its own listener, not on the main one.
    server.fail("curl -fsS http://127.0.0.1:8080/metrics | grep -q go_goroutines")

    # TLS on 443: the key arrives via LoadCredential, the port needs
    # CAP_NET_BIND_SERVICE.
    tls.wait_for_unit("lucid.service")
    tls.wait_for_open_port(443)
    tls.succeed("curl -fsS --cacert ${cert}/cert.pem https://127.0.0.1/healthz")
  '';
}
