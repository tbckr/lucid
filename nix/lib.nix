# Helpers shared by the NixOS and the Home Manager module: what the options
# in nix/options.nix mean for Lucid's environment.
{ lib }:
rec {
  # host:port as Go's net.Listen expects it, with IPv6 hosts in brackets.
  hostPort =
    address: port:
    if lib.hasInfix ":" address then "[${address}]:${toString port}" else "${address}:${toString port}";

  # Where the app-menu entry points. 127.0.0.1, not localhost: localhost may
  # resolve to ::1, where local mode does not listen (FR-35).
  url = cfg: "http://127.0.0.1:${toString cfg.port}/";

  icon = ../web/public/favicon.svg;

  # The LUCID_* variables for cfg. tls says where the process finds the
  # certificate and key ({ cert, key }), or is null without TLS.
  environment =
    cfg: tls:
    let
      local = cfg.mode == "local";
      # toJSON renders 0.5 as "0.5"; toString would give "0.500000".
      render =
        v:
        if lib.isList v then
          lib.concatStringsSep "," v
        else if lib.isString v then
          v
        else
          builtins.toJSON v;
      tuning = lib.filterAttrs (_: v: v != null) {
        LUCID_PRIVATE_NETWORKS = cfg.privateNetworks;
        LUCID_SESSION_TTL = cfg.session.ttl;
        LUCID_SESSION_IDLE_TIMEOUT = cfg.session.idleTimeout;
        LUCID_RATE_LIMIT_RPS = cfg.rateLimit.rps;
        LUCID_RATE_LIMIT_BURST = cfg.rateLimit.burst;
        LUCID_LOGIN_RATE_LIMIT_PER_MIN = cfg.rateLimit.loginPerMinute;
        LUCID_CACHE_SIZE = cfg.cache.size;
        LUCID_CACHE_FRESHNESS = cfg.cache.freshness;
        LUCID_UPSTREAM_TIMEOUT = cfg.upstreamTimeout;
        LUCID_LOG_LEVEL = cfg.logLevel;
      };
    in
    lib.mapAttrs (_: render) tuning
    // (
      if local then
        {
          LUCID_LOCAL_PORT = toString cfg.port;
          # A service has no one to open a browser for.
          LUCID_OPEN_BROWSER = "false";
        }
      else
        {
          LUCID_ADDR = hostPort cfg.address cfg.port;
        }
        // lib.optionalAttrs cfg.trustProxyHeaders { LUCID_TRUST_PROXY_HEADERS = "true"; }
        // lib.optionalAttrs (tls != null) {
          LUCID_TLS_CERT = tls.cert;
          LUCID_TLS_KEY = tls.key;
        }
        // lib.optionalAttrs cfg.metrics.enable {
          LUCID_METRICS_ADDR = hostPort cfg.metrics.address cfg.metrics.port;
        }
    );

  # Whether Lucid serves TLS itself.
  hasTLS = cfg: cfg.mode == "server" && cfg.tls.certFile != null && cfg.tls.keyFile != null;

  # systemd LoadCredential= entries for the TLS files (strings, never store
  # paths: types.externalPath).
  credentials =
    cfg:
    lib.optionals (hasTLS cfg) [
      "tls-cert:${cfg.tls.certFile}"
      "tls-key:${cfg.tls.keyFile}"
    ];

  serverOnlyMessage =
    name: ''services.lucid.${name} only applies in server mode, but services.lucid.mode is "local".'';

  # The Nix-side mirror of Lucid's startup check: a server setting in local
  # mode is an error, not silently ignored.
  assertions =
    cfg:
    let
      local = cfg.mode == "local";
      serverOnly = {
        address = cfg.address != "127.0.0.1";
        trustProxyHeaders = cfg.trustProxyHeaders;
        "tls.certFile" = cfg.tls.certFile != null;
        "tls.keyFile" = cfg.tls.keyFile != null;
        "metrics.enable" = cfg.metrics.enable;
      };
    in
    lib.mapAttrsToList (name: set: {
      assertion = !(local && set);
      message = serverOnlyMessage name;
    }) serverOnly
    ++ [
      {
        assertion = (cfg.tls.certFile == null) == (cfg.tls.keyFile == null);
        message = "services.lucid.tls.certFile and services.lucid.tls.keyFile must be set together.";
      }
    ];
}
