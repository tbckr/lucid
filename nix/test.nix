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
        # Test-only key; real deployments keep this file out of the store.
        environmentFile = pkgs.writeText "lucid.env" ''
          LUCID_SESSION_KEY=MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY=
        '';
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

    # LUCID_SESSION_KEY arrived through the environment file.
    machine.fail("journalctl -u lucid.service | grep -q 'LUCID_SESSION_KEY is not set'")
  '';
}
