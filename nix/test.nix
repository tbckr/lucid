# NixOS VM test for services.lucid (run via `nix flake check` on Linux).
{ self }:
{
  name = "lucid";

  nodes.machine =
    { pkgs, ... }:
    {
      imports = [ self.nixosModules.default ];

      services.lucid = {
        enable = true;
        # One value per freeform type (str, int, bool).
        settings = {
          LUCID_LOG_LEVEL = "debug";
          LUCID_CACHE_SIZE = 64;
          LUCID_TRUST_PROXY_HEADERS = true;
        };
      };

      environment.systemPackages = [ pkgs.curl ];
    };

  testScript = ''
    machine.wait_for_unit("lucid.service")
    machine.wait_for_open_port(8080, "127.0.0.1")

    machine.succeed("curl -fsS http://127.0.0.1:8080/healthz")
    machine.succeed("curl -fsS http://127.0.0.1:8080/readyz")

    # The embedded SPA is served, not the placeholder page.
    machine.succeed("curl -fsS http://127.0.0.1:8080/ | grep -qi '<script'")

    # Server mode (LUCID_ADDR is set) always sets the Secure cookie flag.
    machine.succeed("curl -fsSi http://127.0.0.1:8080/api/v1/session | grep -qi '^set-cookie:.*; secure'")

    # /metrics is served only on LUCID_METRICS_ADDR, not on the main listener.
    machine.fail("curl -fsS http://127.0.0.1:8080/metrics | grep -q go_goroutines")
  '';
}
