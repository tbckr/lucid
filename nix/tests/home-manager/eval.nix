# Evaluation tests for the Home Manager module. Both the Linux and the macOS
# configuration are evaluated on every system, so a Linux host checks the
# launchd agent too.
{
  pkgs,
  nixpkgs,
  lucid,
  hmConfiguration,
}:
let
  inherit (pkgs) lib;

  linux = "x86_64-linux";
  darwin = "aarch64-darwin";
  hmEval = system: cfg: (hmConfiguration system cfg).config;
  xdgOpen = lib.getExe' nixpkgs.legacyPackages.${linux}.xdg-utils "xdg-open";

  # Only Lucid's own warnings, not Home Manager's.
  ours = lib.filter (lib.hasPrefix "services.lucid.");
in
import "${lucid}/nix/tests/run-tests.nix" {
  inherit pkgs;
  name = "lucid-home-manager-eval";
  tests = {
    # This flake's lock pins lucid's inputs on its own, so it goes stale when
    # only the main flake.lock is updated. On failure run
    # nix flake update --flake ./nix/tests/home-manager (just upgrade does).
    testLockFollowsMainFlake = {
      expr = nixpkgs.rev;
      expected = (lib.importJSON "${lucid}/flake.lock").nodes.nixpkgs.locked.rev;
    };

    testLinuxLocal = {
      expr =
        let
          c = hmEval linux { };
          s = c.systemd.user.services.lucid;
        in
        {
          inherit (s.Service) Environment;
          inherit (s.Install) WantedBy;
          exec = c.xdg.desktopEntries.lucid.exec;
        };
      expected = {
        Environment = [
          "LUCID_LOCAL_PORT=3456"
          "LUCID_OPEN_BROWSER=false"
        ];
        WantedBy = [ "default.target" ];
        exec = "${xdgOpen} http://127.0.0.1:3456/";
      };
    };

    testLinuxServerTls = {
      expr =
        let
          c = hmEval linux {
            mode = "server";
            port = 8443;
            tls.certFile = "/home/alice/tls/cert.pem";
            tls.keyFile = "/home/alice/tls/key.pem";
          };
          s = c.systemd.user.services.lucid.Service;
        in
        {
          env = s.Environment;
          cred = s.LoadCredential;
          desktop = c.xdg.desktopEntries;
        };
      expected = {
        env = [
          "LUCID_ADDR=127.0.0.1:8443"
          "LUCID_TLS_CERT=%d/tls-cert"
          "LUCID_TLS_KEY=%d/tls-key"
        ];
        cred = [
          "tls-cert:/home/alice/tls/cert.pem"
          "tls-key:/home/alice/tls/key.pem"
        ];
        desktop = { };
      };
    };

    testLinuxLowPortWarning = {
      expr =
        ours
          (hmEval linux {
            mode = "server";
            port = 443;
          }).warnings;
      expected = [
        "services.lucid.port 443 is below 1024, which a systemd user service can only bind if net.ipv4.ip_unprivileged_port_start allows it. Use a reverse proxy or a port of 1024 or higher."
      ];
    };

    testDarwinLocal = {
      expr =
        let
          c = hmEval darwin { };
          a = c.launchd.agents.lucid.config;
        in
        {
          inherit (a) EnvironmentVariables RunAtLoad StandardOutPath;
          # The submodule fills the fields not set with null.
          KeepAlive = lib.filterAttrs (_: v: v != null) a.KeepAlive;
          desktop = c.xdg.desktopEntries;
          systemd = c.systemd.user.services ? lucid;
        };
      expected = {
        EnvironmentVariables = {
          LUCID_LOCAL_PORT = "3456";
          LUCID_OPEN_BROWSER = "false";
        };
        RunAtLoad = true;
        KeepAlive = {
          Crashed = true;
          SuccessfulExit = false;
        };
        StandardOutPath = "/Users/alice/Library/Logs/lucid.log";
        desktop = { };
        systemd = false;
      };
    };

    # launchd has no credentials directory: the paths go in as they are.
    testDarwinServerTls = {
      expr =
        let
          c = hmEval darwin {
            mode = "server";
            port = 443;
            tls.certFile = "/Users/alice/tls/cert.pem";
            tls.keyFile = "/Users/alice/tls/key.pem";
          };
        in
        {
          tls = c.launchd.agents.lucid.config.EnvironmentVariables.LUCID_TLS_CERT;
          warnings = ours c.warnings;
        };
      expected = {
        tls = "/Users/alice/tls/cert.pem";
        warnings = [ ];
      };
    };

    # Home Manager throws on failed assertions as soon as the configuration
    # is used, so only the outcome is visible here; the message comes from
    # nix/lib.nix and is pinned by the NixOS eval tests.
    testWrongModeRejected = {
      expr = map (cfg: (builtins.tryEval (hmEval linux cfg).services.lucid.enable).success) [
        {
          mode = "server";
          trustProxyHeaders = true;
        }
        { trustProxyHeaders = true; }
      ];
      expected = [
        true
        false
      ];
    };
  };
}
