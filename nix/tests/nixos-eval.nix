# Evaluation tests for services.lucid on NixOS: the generated unit, the
# environment and the assertions, without building or booting anything.
{ self, pkgs }:
let
  inherit (pkgs) lib;

  eval =
    cfg:
    (self.inputs.nixpkgs.lib.nixosSystem {
      modules = [
        self.nixosModules.default
        {
          nixpkgs.hostPlatform = pkgs.stdenv.hostPlatform.system;
          system.stateVersion = "26.05";
          services.lucid = {
            enable = true;
          }
          // cfg;
        }
      ];
    }).config;

  env = c: lib.filterAttrs (n: _: lib.hasPrefix "LUCID_" n) c.systemd.services.lucid.environment;
  serviceConfig = cfg: (eval cfg).systemd.services.lucid.serviceConfig;
  # Only Lucid's own messages: this minimal system also fails NixOS's
  # assertions about the root file system and the boot loader.
  failed =
    c:
    lib.filter (lib.hasPrefix "services.lucid.") (
      map (a: a.message) (lib.filter (a: !a.assertion) c.assertions)
    );
  rejects = cfg: !(builtins.tryEval (builtins.deepSeq (env (eval cfg)) true)).success;
in
import ./run-tests.nix {
  inherit pkgs;
  name = "lucid-nixos-eval";
  tests = {
    testLocalDefaults = {
      expr = env (eval { });
      expected = {
        LUCID_LOCAL_PORT = "3456";
        LUCID_OPEN_BROWSER = "false";
      };
    };

    testServerDefaults = {
      expr = env (eval {
        mode = "server";
      });
      expected = {
        LUCID_ADDR = "127.0.0.1:8080";
      };
    };

    testServerFull = {
      expr =
        let
          c = eval {
            mode = "server";
            address = "0.0.0.0";
            port = 443;
            trustProxyHeaders = true;
            tls.certFile = "/var/lib/acme/x/fullchain.pem";
            tls.keyFile = "/var/lib/acme/x/key.pem";
            metrics = {
              enable = true;
              port = 9100;
            };
          };
        in
        {
          env = env c;
          cred = c.systemd.services.lucid.serviceConfig.LoadCredential;
        };
      expected = {
        env = {
          LUCID_ADDR = "0.0.0.0:443";
          LUCID_TRUST_PROXY_HEADERS = "true";
          LUCID_TLS_CERT = "%d/tls-cert";
          LUCID_TLS_KEY = "%d/tls-key";
          LUCID_METRICS_ADDR = "127.0.0.1:9100";
        };
        cred = [
          "tls-cert:/var/lib/acme/x/fullchain.pem"
          "tls-key:/var/lib/acme/x/key.pem"
        ];
      };
    };

    testIPv6Address = {
      expr =
        (env (eval {
          mode = "server";
          address = "::";
        })).LUCID_ADDR;
      expected = "[::]:8080";
    };

    # systemd expands %-specifiers in Environment= and LoadCredential=; an
    # IPv6 zone or a path with % must reach Lucid unchanged.
    testPercentEscaped = {
      expr =
        let
          c = eval {
            mode = "server";
            address = "fe80::1%eth0";
            tls.certFile = "/etc/lucid/c%ert.pem";
            tls.keyFile = "/etc/lucid/key.pem";
          };
        in
        {
          addr = (env c).LUCID_ADDR;
          cert = (env c).LUCID_TLS_CERT;
          cred = c.systemd.services.lucid.serviceConfig.LoadCredential;
        };
      expected = {
        addr = "[fe80::1%%eth0]:8080";
        cert = "%d/tls-cert";
        cred = [
          "tls-cert:/etc/lucid/c%%ert.pem"
          "tls-key:/etc/lucid/key.pem"
        ];
      };
    };

    testTuning = {
      expr = env (eval {
        privateNetworks = [
          "192.168.1.10/32"
          "10.0.0.0/8"
        ];
        session.ttl = "8h";
        rateLimit.rps = 0.5;
        rateLimit.burst = 30;
        cache.size = 64;
        logLevel = "debug";
      });
      expected = {
        LUCID_LOCAL_PORT = "3456";
        LUCID_OPEN_BROWSER = "false";
        LUCID_PRIVATE_NETWORKS = "192.168.1.10/32,10.0.0.0/8";
        LUCID_SESSION_TTL = "8h";
        LUCID_RATE_LIMIT_RPS = "0.5";
        LUCID_RATE_LIMIT_BURST = "30";
        LUCID_CACHE_SIZE = "64";
        LUCID_LOG_LEVEL = "debug";
      };
    };

    testPrivateNetworksAll = {
      expr =
        (env (eval {
          mode = "server";
          privateNetworks = "all";
        })).LUCID_PRIVATE_NETWORKS;
      expected = "all";
    };

    # An empty list would export "", which Lucid reads as unset: "all" in
    # local mode.
    testEmptyPrivateNetworksRejected = {
      expr = rejects { privateNetworks = [ ]; };
      expected = true;
    };

    # A path literal would be copied into the store once interpolated;
    # types.externalPath only accepts strings.
    testPathLiteralRejected = {
      expr = rejects {
        mode = "server";
        tls.certFile = "/var/lib/acme/x/fullchain.pem";
        tls.keyFile = /var/lib/acme/x/key.pem;
      };
      expected = true;
    };

    testBadDurationRejected = {
      expr = rejects { session.ttl = "12 h"; };
      expected = true;
    };

    # Values Lucid would reject at start, or read as unset, fail at
    # evaluation instead.
    testEmptyPrivateNetworkEntryRejected = {
      expr = rejects { privateNetworks = [ "" ]; };
      expected = true;
    };

    testPortZeroRejected = {
      expr = rejects { port = 0; };
      expected = true;
    };

    testZeroDurationRejected = {
      expr = rejects { session.ttl = "0s"; };
      expected = true;
    };

    # The positive-duration check must not reject positive values written
    # with zeros.
    testDurationsWithZerosAccepted = {
      expr = lib.getAttrs [ "LUCID_CACHE_FRESHNESS" "LUCID_SESSION_TTL" ] (
        env (eval {
          cache.freshness = "0.5s";
          session.ttl = "0h30m";
        })
      );
      expected = {
        LUCID_CACHE_FRESHNESS = "0.5s";
        LUCID_SESSION_TTL = "0h30m";
      };
    };

    testBracketedAddress = {
      expr =
        (env (eval {
          mode = "server";
          address = "[::1]";
        })).LUCID_ADDR;
      expected = "[::1]:8080";
    };

    testMetricsCollision = {
      expr =
        map
          (
            c:
            failed (
              eval (
                {
                  mode = "server";
                }
                // c
              )
            )
          )
          [
            {
              metrics = {
                enable = true;
                port = 8080;
              };
            }
            {
              address = "0.0.0.0";
              metrics = {
                enable = true;
                port = 8080;
              };
            }
            {
              metrics = {
                enable = true;
                port = 9100;
              };
            }
          ];
      expected = [
        [
          "services.lucid.metrics needs a port of its own: it collides with services.lucid.port on the same address."
        ]
        [
          "services.lucid.metrics needs a port of its own: it collides with services.lucid.port on the same address."
        ]
        [ ]
      ];
    };

    # Local mode only binds loopback: an offline laptop must not delay it.
    testNetworkOrdering = {
      expr =
        map
          (
            c:
            let
              s = (eval c).systemd.services.lucid;
            in
            {
              inherit (s) after wants;
            }
          )
          [
            { }
            { mode = "server"; }
          ];
      expected = [
        {
          after = [ "network.target" ];
          wants = [ ];
        }
        {
          after = [ "network-online.target" ];
          wants = [ "network-online.target" ];
        }
      ];
    };

    testLowPortCapabilities = {
      expr =
        lib.getAttrs [ "AmbientCapabilities" "CapabilityBoundingSet" "PrivateUsers" ]
          (serviceConfig {
            mode = "server";
            port = 443;
          });
      expected = {
        AmbientCapabilities = [ "CAP_NET_BIND_SERVICE" ];
        CapabilityBoundingSet = [ "CAP_NET_BIND_SERVICE" ];
        PrivateUsers = false;
      };
    };

    testHighPortHardening = {
      expr =
        let
          s = serviceConfig { mode = "server"; };
        in
        {
          inherit (s) CapabilityBoundingSet PrivateUsers DynamicUser;
          ambient = s ? AmbientCapabilities;
        };
      expected = {
        CapabilityBoundingSet = "";
        PrivateUsers = true;
        DynamicUser = true;
        ambient = false;
      };
    };

    testWrongModeAssertions = {
      expr = lib.sort lib.lessThan (
        failed (eval {
          trustProxyHeaders = true;
          openFirewall = true;
        })
      );
      expected = [
        ''services.lucid.openFirewall only applies in server mode, but services.lucid.mode is "local".''
        ''services.lucid.trustProxyHeaders only applies in server mode, but services.lucid.mode is "local".''
      ];
    };

    testTlsPairAssertion = {
      expr = failed (eval {
        mode = "server";
        tls.certFile = "/etc/lucid/cert.pem";
      });
      expected = [ "services.lucid.tls.certFile and services.lucid.tls.keyFile must be set together." ];
    };

    testOpenFirewall = {
      expr =
        (eval {
          mode = "server";
          openFirewall = true;
          metrics = {
            enable = true;
            port = 9100;
          };
        }).networking.firewall.allowedTCPPorts;
      expected = [ 8080 ];
    };

    testDesktopItemLocalOnly = {
      expr = map (c: lib.any (p: (p.name or "") == "lucid.desktop") c.environment.systemPackages) [
        (eval { })
        (eval { mode = "server"; })
      ];
      expected = [
        true
        false
      ];
    };
  };
}
