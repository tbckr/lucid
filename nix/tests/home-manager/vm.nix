# NixOS VM test with Home Manager's NixOS module: alice runs Lucid in local
# mode, bob in server mode with TLS, both as systemd user services started by
# lingering.
{ lucid, home-manager }:
{ pkgs, ... }:
let
  cert = import "${lucid}/nix/tests/test-cert.nix" { inherit pkgs; };
in
{
  name = "lucid-home-manager";

  nodes.machine = {
    imports = [ home-manager.nixosModules.home-manager ];

    environment.systemPackages = [ pkgs.curl ];

    users.users.alice = {
      isNormalUser = true;
      linger = true;
    };
    users.users.bob = {
      isNormalUser = true;
      linger = true;
    };

    environment.etc."lucid-bob/cert.pem" = {
      source = "${cert}/cert.pem";
      user = "bob";
      mode = "0400";
    };
    environment.etc."lucid-bob/key.pem" = {
      source = "${cert}/key.pem";
      user = "bob";
      mode = "0400";
    };

    home-manager = {
      useUserPackages = true;
      sharedModules = [ lucid.homeModules.default ];
      users.alice = {
        home.stateVersion = "26.05";
        services.lucid.enable = true;
      };
      users.bob = {
        home.stateVersion = "26.05";
        services.lucid = {
          enable = true;
          mode = "server";
          port = 8443;
          tls.certFile = "/etc/lucid-bob/cert.pem";
          tls.keyFile = "/etc/lucid-bob/key.pem";
        };
      };
    };
  };

  testScript = ''
    machine.wait_for_unit("multi-user.target")

    machine.wait_for_unit("lucid.service", "alice")
    machine.wait_for_open_port(3456, "127.0.0.1")
    machine.succeed("curl -fsS http://127.0.0.1:3456/healthz")
    machine.succeed("grep -q 'http://127.0.0.1:3456/' /etc/profiles/per-user/alice/share/applications/lucid.desktop")

    # LoadCredential in a user service.
    machine.wait_for_unit("lucid.service", "bob")
    machine.wait_for_open_port(8443, "127.0.0.1")
    machine.succeed("curl -fsS --cacert ${cert}/cert.pem https://127.0.0.1:8443/healthz")
  '';
}
