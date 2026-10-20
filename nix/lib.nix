# Helpers shared by the NixOS and the Home Manager module: what the options
# in nix/options.nix mean for Lucid's environment.
{ lib }:
rec {
  # host:port as Go's net.Listen expects it, with IPv6 hosts in brackets,
  # whether or not the address was written with them.
  hostPort =
    address: port:
    let
      host = lib.removePrefix "[" (lib.removeSuffix "]" address);
    in
    if lib.hasInfix ":" host then "[${host}]:${toString port}" else "${host}:${toString port}";

  # Where the app-menu entry points. 127.0.0.1, not localhost: localhost may
  # resolve to ::1, where local mode does not listen (FR-35).
  url = cfg: "http://127.0.0.1:${toString cfg.port}/";

  icon = ../web/public/favicon.svg;

  # The LUCID_* variables for cfg, as Lucid reads them (launchd passes them
  # on unchanged).
  environment =
    cfg:
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
        // lib.optionalAttrs (hasTLS cfg) {
          LUCID_TLS_CERT = cfg.tls.certFile;
          LUCID_TLS_KEY = cfg.tls.keyFile;
        }
        // lib.optionalAttrs cfg.metrics.enable {
          LUCID_METRICS_ADDR = hostPort cfg.metrics.address cfg.metrics.port;
        }
    );

  # Whether Lucid serves TLS itself.
  hasTLS = cfg: cfg.mode == "server" && cfg.tls.certFile != null && cfg.tls.keyFile != null;

  # systemd expands %-specifiers in Environment= and LoadCredential=, so a %
  # in a value (an IPv6 zone, a path) must be doubled to reach Lucid as is.
  escapeSpecifiers = lib.replaceStrings [ "%" ] [ "%%" ];

  # environment for a systemd unit: values escaped, and the TLS files taken
  # from the credentials directory (%d) that credentials fills.
  systemdEnvironment =
    cfg:
    lib.mapAttrs (_: escapeSpecifiers) (environment cfg)
    // lib.optionalAttrs (hasTLS cfg) {
      LUCID_TLS_CERT = "%d/tls-cert";
      LUCID_TLS_KEY = "%d/tls-key";
    };

  # systemd LoadCredential= entries for the TLS files (strings, never store
  # paths: types.externalPath).
  credentials =
    cfg:
    lib.optionals (hasTLS cfg) [
      "tls-cert:${escapeSpecifiers cfg.tls.certFile}"
      "tls-key:${escapeSpecifiers cfg.tls.keyFile}"
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
      {
        assertion = !(cfg.mode == "server" && cfg.metrics.enable && metricsCollides cfg);
        message = "services.lucid.metrics needs a port of its own: it collides with services.lucid.port on the same address.";
      }
    ];

  # Whether the metrics listener would bind what the main listener binds: the
  # same port on the same address, or on a wildcard address covering it.
  metricsCollides =
    cfg:
    let
      wildcard =
        a:
        lib.elem a [
          ""
          "0.0.0.0"
          "::"
          "[::]"
        ];
    in
    cfg.metrics.port == cfg.port
    && (cfg.metrics.address == cfg.address || wildcard cfg.address || wildcard cfg.metrics.address);
}
